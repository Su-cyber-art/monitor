//! Run with two real Linux agent builds via scripts/e2e-upgrade.sh. A test
//! signing key exercises the real relay verification without release secrets.
#![cfg(target_os = "linux")]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::process::Command;

use crate::{
    agent_ws, api, auth,
    db::{Db, Node},
    upgrade, AgentRelease, App, Shared, TempDir,
};

async fn until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    tokio::time::timeout(Duration::from_secs(40), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn version(path: &Path) -> String {
    let output = std::process::Command::new(path).arg("--version").output().unwrap();
    assert!(output.status.success(), "agent must support --version");
    String::from_utf8(output.stdout).unwrap().trim().strip_prefix("monitor-agent ").unwrap().to_owned()
}

async fn rows(client: &reqwest::Client, base: &str, path: &str) -> Value {
    client
        .get(format!("{base}/api/{path}"))
        .header("Cookie", "monitor_session=e2e")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn start(client: &reqwest::Client, base: &str, ids: &[i64], version: &str) -> Value {
    client
        .post(format!("{base}/api/agent-upgrades"))
        .header("Cookie", "monitor_session=e2e")
        .header("Sec-Fetch-Site", "same-origin")
        .header("Origin", "https://hub.example.com")
        .json(&json!({"ids": ids, "version": version}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs two Linux agent builds; run scripts/e2e-upgrade.sh"]
async fn batch_self_update() {
    let old = PathBuf::from(std::env::var("MONITOR_E2E_AGENT_OLD").expect("old agent path"));
    let new = PathBuf::from(std::env::var("MONITOR_E2E_AGENT_NEW").expect("new agent path"));
    let old_version = version(&old);
    let new_version = version(&new);
    assert_ne!(old_version, new_version, "use two distinct agent versions");
    let scratch = TempDir::new("upgrade-e2e");
    let binary = std::fs::read(&new).unwrap();
    let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
    let key = pair.public_key().as_ref().to_vec();
    let signature = pair.sign(&binary).as_ref().to_vec();
    let mirror = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mirror_url = format!("http://{}", mirror.local_addr().unwrap());
    let fixture = Router::new().fallback(move |uri: Uri| {
        let binary = binary.clone();
        let signature = signature.clone();
        async move {
            // Long enough to observe reports continuing during both downloads.
            tokio::time::sleep(Duration::from_secs(3)).await;
            let path = uri.path();
            if !path.contains("/releases/download/v") {
                return StatusCode::NOT_FOUND.into_response();
            }
            if path.ends_with(".sig") {
                if path.contains("/v999.0.998/") {
                    return vec![0u8; 64].into_response();
                }
                return signature.into_response();
            }
            binary.into_response()
        }
    });
    let mirror_task = tokio::spawn(async move { axum::serve(mirror, fixture).await.unwrap() });
    let app = Arc::new(App::for_test(Db::open(scratch.0.join("hub.db").to_str().unwrap()).unwrap()));
    app.db.set("github_proxy", &mirror_url).unwrap();
    app.db.create_session(&auth::sha256("e2e"), chrono::Utc::now().timestamp() + 600).unwrap();
    let routes = Router::new()
        .route("/api/nodes", get(api::nodes))
        .route("/api/agent-upgrades", get(upgrade::list).post(upgrade::start))
        .route("/api/agent/ws", get(agent_ws::handler))
        .route("/api/agent/echo", get(agent_ws::echo))
        .route(
            "/agent/{arch}",
            get(
                move |State(app): State<Shared>,
                      UrlPath(arch): UrlPath<String>,
                      Query(release): Query<AgentRelease>| {
                    let key = key.clone();
                    async move { crate::relay_agent(app, arch, release, &key).await }
                },
            ),
        )
        .layer(axum::middleware::from_fn(api::same_origin_writes))
        .with_state(app.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hub_task = tokio::spawn(async move {
        axum::serve(listener, routes.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    let mut children = Vec::new();
    let mut ids = Vec::new();
    let mut paths = Vec::new();
    for name in ["first", "second"] {
        let node = app.db.create_node(&Node { name: name.into(), ..Default::default() }, name).unwrap();
        let dir = scratch.0.join(name);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("monitor-agent");
        std::fs::copy(&old, &path).unwrap();
        let log = std::fs::File::create(dir.join("agent.log")).unwrap();
        let mut command = Command::new(&path);
        // CI normally runs as its user. On a root test host, exercise the same
        // unprivileged ownership boundary as the installed service.
        use std::os::unix::fs::MetadataExt;
        if std::fs::metadata("/proc/self").unwrap().uid() == 0 {
            std::os::unix::fs::chown(&dir, Some(65534), Some(65534)).unwrap();
            std::os::unix::fs::chown(&path, Some(65534), Some(65534)).unwrap();
            command.uid(65534).gid(65534);
        }
        let child = command
            .args(["--server", &base, "--token", name, "--allow-upgrade"])
            .stdout(Stdio::null())
            .stderr(log)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        children.push(child);
        ids.push(node);
        paths.push(path);
    }
    let client = reqwest::Client::new();
    until("both initial agents to report", || async {
        let data = rows(&client, &base, "nodes").await;
        data["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| {
                node["online"] == true && node["can_upgrade"] == true && node["metrics"].is_object()
            })
            .count()
            == 2
    })
    .await;
    let before = rows(&client, &base, "nodes").await;
    let accepted = start(&client, &base, &ids, &new_version).await;
    assert_eq!(accepted["started"], 2);
    let duplicate = start(&client, &base, &ids, &new_version).await;
    assert_eq!(duplicate["started"], 0);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let during = rows(&client, &base, "nodes").await;
    for (old, live) in before["nodes"].as_array().unwrap().iter().zip(during["nodes"].as_array().unwrap()) {
        assert_eq!(live["online"], true);
        assert!(
            live["last_seen"].as_i64().unwrap() > old["last_seen"].as_i64().unwrap(),
            "reports must continue while downloading"
        );
    }
    until("both upgrades to confirm the new version", || async {
        let data = rows(&client, &base, "agent-upgrades").await;
        data["upgrades"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|job| job["status"] == "succeeded" && job["version"] == new_version)
            .count()
            == 2
    })
    .await;
    until("both replacements to report", || async {
        rows(&client, &base, "nodes").await["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| {
                node["online"] == true && node["agent_version"] == new_version && node["metrics"].is_object()
            })
            .count()
            == 2
    })
    .await;
    for path in &paths {
        assert_eq!(version(path), new_version);
        assert!(!path.with_file_name("monitor-agent.previous").exists());
        assert!(!path.with_file_name("monitor-agent.upgrade.json").exists());
    }
    for rejected in ["999.0.999", "999.0.998"] {
        assert_ne!(rejected, new_version);
        assert_eq!(start(&client, &base, &ids[..1], rejected).await["started"], 1);
        until("a wrong version or bad signature to fail", || async {
            rows(&client, &base, "agent-upgrades").await["upgrades"].as_array().unwrap().iter().any(|job| {
                job["node_id"] == ids[0] && job["version"] == rejected && job["status"] == "failed"
            })
        })
        .await;
        assert_eq!(version(&paths[0]), new_version, "a refused candidate must not replace the working agent");
        assert!(!paths[0].with_file_name("monitor-agent.download").exists());
    }
    // A supervisor restart before the first confirmed boot loses memory, but
    // must still restore the previous executable and report the failed update.
    children[0].kill().await.unwrap();
    let path = &paths[0];
    let previous = path.with_file_name("monitor-agent.previous");
    std::fs::copy(&old, &previous).unwrap();
    std::fs::write(
        path.with_file_name("monitor-agent.upgrade.json"),
        serde_json::to_vec(&json!({"id":"recovery", "version":new_version, "boots":1})).unwrap(),
    )
    .unwrap();
    assert!(app
        .db
        .start_agent_upgrade(ids[0], "recovery", &new_version, chrono::Utc::now().timestamp())
        .unwrap());
    let mut recovered = Command::new(path);
    use std::os::unix::fs::MetadataExt;
    if std::fs::metadata("/proc/self").unwrap().uid() == 0 {
        std::os::unix::fs::chown(&previous, Some(65534), Some(65534)).unwrap();
        recovered.uid(65534).gid(65534);
    }
    children[0] = recovered
        .args(["--server", &base, "--token", "first", "--allow-upgrade"])
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(path.with_file_name("recovery.log")).unwrap())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    until("the old process to confirm the rollback", || async {
        rows(&client, &base, "agent-upgrades").await["upgrades"].as_array().unwrap().iter().any(|job| {
            job["id"] == "recovery"
                && job["status"] == "failed"
                && job["message"].as_str().unwrap().contains("已恢复原版本")
        })
    })
    .await;
    assert_eq!(version(path), old_version);
    assert!(!path.with_file_name("monitor-agent.upgrade.json").exists());
    for child in &mut children {
        child.kill().await.unwrap();
    }
    hub_task.abort();
    mirror_task.abort();
    println!("batch_self_update: two agents {old_version} -> {new_version}; continuous reports, duplicate suppression, version/signature failures and restart rollback verified");
}
