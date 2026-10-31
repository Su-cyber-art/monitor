//! Administrator-triggered agent upgrades. The executable comes from the hub's
//! existing signed release relay; commands contain a release version, never a URL
//! or a shell command. Only a hello from the new process confirms completion.

use std::collections::HashSet;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{answer, fail, Admin};
use crate::auth::random_token;
use crate::Shared;

/// Includes relay queueing, download, validation and the new process's reconnect.
pub const TIMEOUT: i64 = 600;

#[derive(Debug, Serialize)]
pub struct Attempt {
    pub node_id: i64,
    pub id: String,
    pub version: String,
    pub status: String,
    pub message: String,
    pub started_at: i64,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct Request {
    ids: Vec<i64>,
    version: String,
}

/// A release tag component. No path, query or fragment may reach the relay URL.
pub fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version.as_bytes()[0].is_ascii_digit()
        && version.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
}

pub async fn list(_: Admin, State(app): State<Shared>) -> Response {
    match app.db.expire_agent_upgrades(Utc::now().timestamp()).and_then(|()| app.db.agent_upgrades()) {
        Ok(upgrades) => Json(json!({"upgrades": upgrades})).into_response(),
        Err(e) => fail(e),
    }
}

pub async fn start(_: Admin, State(app): State<Shared>, Json(request): Json<Request>) -> Response {
    if request.ids.is_empty() || !valid_version(&request.version) {
        return answer(StatusCode::BAD_REQUEST, "请选择节点并指定有效的 agent 版本");
    }
    let nodes = match app.db.nodes() {
        Ok(nodes) => nodes,
        Err(e) => return fail(e),
    };
    let ids: HashSet<_> = request.ids.into_iter().collect();
    if ids.iter().any(|id| !nodes.iter().any(|node| node.id == *id)) {
        return answer(StatusCode::NOT_FOUND, "部分节点已被删除，请刷新后重试");
    }
    let now = Utc::now().timestamp();
    if let Err(e) = app.db.expire_agent_upgrades(now) {
        return fail(e);
    }
    let mut started = 0;
    for node in nodes.iter().filter(|node| ids.contains(&node.id)) {
        let id = random_token();
        match app.db.start_agent_upgrade(node.id, &id, &request.version, now) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => return fail(e),
        }
        let command = json!({
            "jsonrpc": "2.0", "method": "agent.upgrade",
            "params": {"id": id, "version": request.version},
        })
        .to_string();
        // No database lock while holding this map: agent reports take them in
        // the other order. Looking up the sender at the moment of dispatch also
        // excludes sessions revoked by a token rotation or a node deletion.
        let refused = {
            let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
            match agents.get(&node.id) {
                None => Some("节点已离线，请上线后重试"),
                Some(agent) if !agent.can_upgrade => {
                    Some("此 agent 尚未启用远程升级，请先用新版安装脚本更新一次")
                }
                Some(_) if node.agent_version == request.version => Some("节点已运行目标版本"),
                Some(agent) => agent.tx.try_send(command).err().map(|_| "节点连接繁忙或已断开，请重试"),
            }
        };
        if let Some(reason) = refused {
            if let Err(e) = app.db.agent_upgrade_progress(node.id, &id, "failed", reason) {
                return fail(e);
            }
        } else {
            started += 1;
        }
    }
    match app.db.agent_upgrades() {
        Ok(upgrades) => Json(json!({"started": started, "upgrades": upgrades})).into_response(),
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
pub struct Progress {
    id: String,
    status: String,
    #[serde(default)]
    message: String,
}

pub fn progress(app: &crate::App, node: i64, params: serde_json::Value) -> anyhow::Result<()> {
    let report: Progress = serde_json::from_value(params)?;
    anyhow::ensure!(
        matches!(report.status.as_str(), "downloading" | "restarting" | "failed"),
        "invalid upgrade status"
    );
    let message: String = report.message.chars().filter(|c| !c.is_control()).take(500).collect();
    app.db.agent_upgrade_progress(node, &report.id, &report.status, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent_ws::Agent,
        db::{Db, Node},
        App,
    };
    use std::sync::Arc;

    fn node(app: &App, token: &str) -> i64 {
        let id = app.db.create_node(&Node { name: token.into(), ..Default::default() }, token).unwrap();
        app.db.save_facts(id, &json!({"agent_version":"1.3.0"}), "", "").unwrap();
        id
    }

    #[tokio::test]
    async fn a_batch_dispatches_only_to_capable_online_nodes_and_duplicate_clicks_do_not_repeat_it() {
        let app = Arc::new(App::for_test(Db::open(":memory:").unwrap()));
        let ready = node(&app, "ready");
        let old = node(&app, "old");
        let offline = node(&app, "offline");
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let mut agent = Agent::new(1, tx.clone());
        agent.can_upgrade = true;
        app.agents.write().unwrap().insert(ready, agent);
        app.agents.write().unwrap().insert(old, Agent::new(2, tx));
        let request = || Json(Request { ids: vec![ready, ready, old, offline], version: "1.3.1".into() });
        assert_eq!(start(Admin, State(app.clone()), request()).await.status(), StatusCode::OK);
        let command: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(command["method"], "agent.upgrade");
        assert_eq!(command["params"]["version"], "1.3.1");
        assert!(rx.try_recv().is_err());
        let attempts = app.db.agent_upgrades().unwrap();
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts.iter().filter(|a| a.status == "queued").count(), 1);
        assert_eq!(attempts.iter().filter(|a| a.status == "failed").count(), 2);
        start(Admin, State(app.clone()), request()).await;
        assert!(rx.try_recv().is_err(), "an in-flight attempt is not sent again");
    }

    #[test]
    fn completion_is_bound_to_the_node_request_and_observed_version() {
        let app = App::for_test(Db::open(":memory:").unwrap());
        let a = node(&app, "a");
        let b = node(&app, "b");
        app.db.start_agent_upgrade(a, "first", "1.3.1", 100).unwrap();
        app.db.complete_agent_upgrade(b, "first", "1.3.1").unwrap();
        app.db.complete_agent_upgrade(a, "first", "1.3.0").unwrap();
        assert_eq!(app.db.agent_upgrades().unwrap()[0].status, "queued");
        app.db.complete_agent_upgrade(a, "first", "1.3.1").unwrap();
        progress(&app, a, json!({"id":"first", "status":"failed"})).unwrap();
        assert_eq!(app.db.agent_upgrades().unwrap()[0].status, "succeeded");
        app.db.start_agent_upgrade(a, "next", "1.3.2", 200).unwrap();
        app.db.complete_agent_upgrade(a, "first", "1.3.1").unwrap();
        assert_eq!(app.db.agent_upgrades().unwrap()[0].id, "next");
        assert_eq!(app.db.agent_upgrades().unwrap()[0].status, "queued");
        app.db.expire_agent_upgrades(200 + TIMEOUT).unwrap();
        assert_eq!(app.db.agent_upgrades().unwrap()[0].status, "failed");
        app.db.delete_node(a).unwrap();
        assert!(app.db.agent_upgrades().unwrap().is_empty());
    }

    #[tokio::test]
    async fn upgrade_routes_require_an_admin_session_and_bad_batches_send_nothing() {
        use axum::body::Body;
        use axum::http::Request as HttpRequest;
        use tower::ServiceExt;
        let app = Arc::new(App::for_test(Db::open(":memory:").unwrap()));
        let routes = axum::Router::new()
            .route("/api/agent-upgrades", axum::routing::get(list).post(start))
            .with_state(app.clone());
        for method in ["GET", "POST"] {
            let request = HttpRequest::builder()
                .method(method)
                .uri("/api/agent-upgrades")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"ids":[1],"version":"1.3.1"}"#))
                .unwrap();
            assert_eq!(routes.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
        for version in ["../latest", "1.3.1?other", "v1.3.1", "", "1.3.1/extra"] {
            assert!(!valid_version(version));
        }
        for version in ["1.3.1", "1.3.1-rc.1", "1.3.1+build.2"] {
            assert!(valid_version(version));
        }
        let id = node(&app, "only");
        let response = start(
            Admin,
            State(app.clone()),
            Json(Request { ids: vec![id, id + 1], version: "1.3.1".into() }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(app.db.agent_upgrades().unwrap().is_empty());
    }
}
