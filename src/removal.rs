//! Remote uninstall is a separate operation from deleting a panel record.
//! The root-owned helper reports over HTTP after stopping the agent. A scoped,
//! random request ID authorizes these callbacks even after the node is deleted.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{answer, fail, Admin};
use crate::{auth, Shared};

pub const TIMEOUT: i64 = 300;

#[derive(Clone, Debug, Serialize)]
pub struct Attempt {
    pub node_id: i64,
    pub id: String,
    pub node_name: String,
    pub status: String,
    pub message: String,
    pub started_at: i64,
    pub updated_at: i64,
    /// Hidden from history, but retained to acknowledge a retried completion.
    pub dismissed: bool,
}

pub enum Start {
    Ready { fresh: bool, attempt: Attempt },
    Missing,
    Upgrading,
    Unconfirmed,
}

pub async fn list(_: Admin, State(app): State<Shared>) -> Response {
    match app.db.expire_agent_removals(Utc::now().timestamp()).and_then(|()| app.db.agent_removals()) {
        Ok(removals) => {
            ([(header::CACHE_CONTROL, "no-store")], Json(json!({"removals": removals}))).into_response()
        }
        Err(e) => fail(e),
    }
}

#[derive(Deserialize)]
pub struct Dismiss {
    ids: Vec<String>,
}

pub async fn dismiss(_: Admin, State(app): State<Shared>, Json(request): Json<Dismiss>) -> Response {
    match app.db.dismiss_completed_removals(&request.ids) {
        Ok(cleared) => Json(json!({"cleared": cleared})).into_response(),
        Err(e) => fail(e),
    }
}

pub async fn start(_: Admin, State(app): State<Shared>, Path(node): Path<i64>) -> Response {
    let now = Utc::now().timestamp();
    if let Err(e) = app.db.expire_agent_upgrades(now).and_then(|()| app.db.expire_agent_removals(now)) {
        return fail(e);
    }
    let mut attempt = match app.db.start_agent_removal(node, &auth::random_token(), now) {
        Ok(Start::Ready { fresh: false, attempt }) => {
            return ([(header::CACHE_CONTROL, "no-store")], Json(attempt)).into_response()
        }
        Ok(Start::Ready { fresh: true, attempt }) => attempt,
        Ok(Start::Missing) => return answer(StatusCode::NOT_FOUND, "节点已被删除"),
        Ok(Start::Upgrading) => return answer(StatusCode::CONFLICT, "节点正在升级，请等待升级结束后再卸载"),
        Ok(Start::Unconfirmed) => {
            return answer(StatusCode::CONFLICT, "上次卸载结果尚未确认，请先在节点检查或手动卸载")
        }
        Err(e) => return fail(e),
    };
    let command = json!({
        "jsonrpc": "2.0", "method": "agent.uninstall", "params": {"id": attempt.id},
    })
    .to_string();
    let refused = {
        let agents = app.agents.read().unwrap_or_else(|e| e.into_inner());
        match agents.get(&node) {
            None => Some("节点已离线，无法远程卸载；节点记录已保留"),
            Some(agent) if !agent.can_uninstall => {
                Some("此节点未启用远程卸载；目前支持用新版安装脚本配置的 Linux/systemd 节点")
            }
            Some(agent) => agent.tx.try_send(command).err().map(|_| "节点连接繁忙或已断开，请重试"),
        }
    };
    if let Some(message) = refused {
        if let Err(e) = app.db.agent_removal_progress(node, &attempt.id, "failed", message) {
            return fail(e);
        }
        attempt.status = "failed".into();
        attempt.message = message.into();
        attempt.updated_at = Utc::now().timestamp();
    }
    ([(header::CACHE_CONTROL, "no-store")], Json(attempt)).into_response()
}

#[derive(Deserialize)]
pub struct Progress {
    status: String,
    #[serde(default)]
    message: String,
}

/// Agent frames only acknowledge receipt or report inability to enqueue the
/// helper. They cannot claim the privileged cleanup has completed.
pub fn progress(app: &crate::App, node: i64, params: Value) -> anyhow::Result<()> {
    #[derive(Deserialize)]
    struct Report {
        id: String,
        #[serde(flatten)]
        progress: Progress,
    }
    let report: Report = serde_json::from_value(params)?;
    anyhow::ensure!(
        matches!(report.progress.status.as_str(), "accepted" | "failed"),
        "invalid uninstall status"
    );
    app.db.agent_removal_progress(
        node,
        &report.id,
        &report.progress.status,
        &message(&report.progress.message),
    )
}

fn message(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).take(500).collect()
}

pub async fn callback(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(report): Json<Progress>,
) -> Response {
    let Some(id) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return answer(StatusCode::UNAUTHORIZED, "missing uninstall credential");
    };
    if !matches!(report.status.as_str(), "stopping" | "removing" | "succeeded" | "failed") {
        return answer(StatusCode::BAD_REQUEST, "invalid uninstall status");
    }
    let node_token = headers.get("x-node-token").and_then(|value| value.to_str().ok());
    if report.status == "stopping" && node_token.is_none() {
        return answer(StatusCode::UNAUTHORIZED, "missing installed node credential");
    }
    if let Err(e) = app.db.expire_agent_removals(Utc::now().timestamp()) {
        return fail(e);
    }
    match app.db.confirm_agent_removal(id, &report.status, &message(&report.message), node_token) {
        Ok(Some((node, completed))) => {
            if completed {
                crate::api::forget_node(&app, node);
            }
            Json(json!({"ok": true})).into_response()
        }
        Ok(None) => answer(StatusCode::CONFLICT, "uninstall request is unknown, expired or no longer active"),
        Err(e) => fail(e),
    }
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

    fn fixture(capable: bool) -> (Shared, i64, tokio::sync::mpsc::Receiver<String>) {
        let app = Arc::new(App::for_test(Db::open(":memory:").unwrap()));
        let node = app
            .db
            .create_node(&Node { name: "test node".into(), ..Default::default() }, "node-token")
            .unwrap();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let mut agent = Agent::new(1, tx);
        agent.can_uninstall = capable;
        agent.can_upgrade = true;
        app.agents.write().unwrap().insert(node, agent);
        (app, node, rx)
    }

    async fn report(app: &Shared, id: &str, status: &str) -> StatusCode {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, format!("Bearer {id}").parse().unwrap());
        headers.insert("x-node-token", "node-token".parse().unwrap());
        callback(
            State(app.clone()),
            headers,
            Json(Progress { status: status.into(), message: String::new() }),
        )
        .await
        .status()
    }

    #[tokio::test]
    async fn deletion_still_only_removes_the_record_unless_uninstall_is_requested() {
        let (app, node, mut rx) = fixture(true);
        assert_eq!(
            crate::api::delete_node(Admin, State(app.clone()), Path(node)).await.status(),
            StatusCode::OK
        );
        assert!(rx.recv().await.is_none(), "no uninstall command is sent");
        assert!(app.db.agent_removals().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unsupported_and_offline_nodes_keep_their_records_with_explicit_failure() {
        for online in [true, false] {
            let (app, node, mut rx) = fixture(false);
            if !online {
                app.agents.write().unwrap().clear();
            }
            assert_eq!(start(Admin, State(app.clone()), Path(node)).await.status(), StatusCode::OK);
            let job = app.db.agent_removals().unwrap().remove(0);
            assert_eq!(job.status, "failed");
            assert!(!job.message.is_empty());
            assert!(app.db.node(node).unwrap().is_some());
            assert!(rx.try_recv().is_err());
        }
    }

    #[tokio::test]
    async fn duplicates_dispatch_once_and_cannot_delete_before_the_helper_confirms() {
        let (app, node, mut rx) = fixture(true);
        for _ in 0..2 {
            assert_eq!(start(Admin, State(app.clone()), Path(node)).await.status(), StatusCode::OK);
        }
        let command: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(command["method"], "agent.uninstall");
        let id = command["params"]["id"].as_str().unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(report(&app, id, "succeeded").await, StatusCode::CONFLICT);
        assert_eq!(
            crate::api::delete_node(Admin, State(app.clone()), Path(node)).await.status(),
            StatusCode::CONFLICT
        );
        assert!(progress(&app, node, json!({"id": id, "status": "succeeded"})).is_err());
        assert!(app.db.node(node).unwrap().is_some());
        assert_eq!(report(&app, id, "stopping").await, StatusCode::OK);
        progress(&app, node, json!({"id": id, "status": "accepted"})).unwrap();
        assert_eq!(app.db.agent_removals().unwrap()[0].status, "stopping");
        assert_eq!(report(&app, id, "removing").await, StatusCode::OK);
        assert_eq!(report(&app, id, "succeeded").await, StatusCode::OK);
        assert!(app.db.node(node).unwrap().is_none());
        assert!(!app.agents.read().unwrap().contains_key(&node));
        assert_eq!(app.db.agent_removals().unwrap()[0].status, "succeeded");
        assert_eq!(report(&app, id, "succeeded").await, StatusCode::OK, "retry after a lost final reply");
        assert_eq!(
            report(&app, id, "stopping").await,
            StatusCode::CONFLICT,
            "the old marker cannot start another cleanup"
        );
        let new =
            app.db.create_node(&Node { name: "next".into(), ..Default::default() }, "next-token").unwrap();
        assert_ne!(new, node);
        assert_eq!(report(&app, id, "succeeded").await, StatusCode::OK);
        assert!(app.db.node(new).unwrap().is_some());
    }

    #[tokio::test]
    async fn failed_and_unknown_callbacks_never_delete_a_node() {
        let (app, node, mut rx) = fixture(true);
        start(Admin, State(app.clone()), Path(node)).await;
        let command: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let id = command["params"]["id"].as_str().unwrap();
        assert_eq!(report(&app, "unknown", "stopping").await, StatusCode::CONFLICT);
        progress(&app, node + 1, json!({"id": id, "status": "failed"})).unwrap();
        assert_eq!(app.db.agent_removals().unwrap()[0].status, "queued");
        assert_eq!(report(&app, id, "stopping").await, StatusCode::OK);
        assert_eq!(report(&app, id, "failed").await, StatusCode::OK);
        assert_eq!(report(&app, id, "succeeded").await, StatusCode::CONFLICT);
        assert!(app.db.node(node).unwrap().is_some());
    }

    #[tokio::test]
    async fn timeouts_preserve_records_and_accept_a_late_final_receipt_only_for_a_started_helper() {
        for helper_started in [true, false] {
            let (app, node, _rx) = fixture(true);
            let now = Utc::now().timestamp();
            app.db.start_agent_removal(node, "request", now).unwrap();
            if helper_started {
                assert_eq!(report(&app, "request", "stopping").await, StatusCode::OK);
            }
            app.db.expire_agent_removals(now + TIMEOUT).unwrap();
            let job = &app.db.agent_removals().unwrap()[0];
            assert_eq!(job.status, if helper_started { "unconfirmed" } else { "failed" });
            assert!(app.db.node(node).unwrap().is_some());
            if helper_started {
                assert!(matches!(
                    app.db.start_agent_removal(node, "retry", now + TIMEOUT + 1).unwrap(),
                    Start::Unconfirmed
                ));
                assert_eq!(report(&app, "request", "succeeded").await, StatusCode::OK);
                assert!(app.db.node(node).unwrap().is_none());
            } else {
                assert_eq!(report(&app, "request", "stopping").await, StatusCode::CONFLICT);
                assert!(matches!(
                    app.db.start_agent_removal(node, "retry", now + TIMEOUT + 1).unwrap(),
                    Start::Ready { fresh: true, .. }
                ));
                assert_eq!(report(&app, "request", "stopping").await, StatusCode::CONFLICT);
            }
        }
    }

    #[tokio::test]
    async fn upgrading_and_uninstalling_are_mutually_exclusive() {
        let (app, node, mut rx) = fixture(true);
        let now = Utc::now().timestamp();
        app.db.start_agent_upgrade(node, "upgrade", "next", now).unwrap();
        assert_eq!(start(Admin, State(app.clone()), Path(node)).await.status(), StatusCode::CONFLICT);
        assert!(rx.try_recv().is_err());
        app.db.agent_upgrade_progress(node, "upgrade", "failed", "test").unwrap();
        start(Admin, State(app.clone()), Path(node)).await;
        assert!(!app.db.start_agent_upgrade(node, "another", "next", now).unwrap());
    }

    #[tokio::test]
    async fn the_helper_must_identify_the_installed_node_before_stopping_anything() {
        let (app, node, _rx) = fixture(true);
        app.db.start_agent_removal(node, "request", Utc::now().timestamp()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer request".parse().unwrap());
        let body = || Json(Progress { status: "stopping".into(), message: String::new() });
        assert_eq!(
            callback(State(app.clone()), headers.clone(), body()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        headers.insert("x-node-token", "another-nodes-token".parse().unwrap());
        assert_eq!(callback(State(app.clone()), headers, body()).await.status(), StatusCode::CONFLICT);
        assert_eq!(app.db.agent_removals().unwrap()[0].status, "queued");
        assert!(app.db.node(node).unwrap().is_some());
    }

    #[tokio::test]
    async fn clearing_history_only_dismisses_requested_successes_and_keeps_completion_receipts() {
        let scratch = crate::TempDir::new("removal-history");
        let path = scratch.0.join("hub.db");
        let app = Arc::new(App::for_test(Db::open(path.to_str().unwrap()).unwrap()));
        let now = Utc::now().timestamp();
        let mut requests = Vec::new();
        for status in ["succeeded", "queued", "failed", "unconfirmed", "removing", "succeeded"] {
            let id = format!("request-{}", requests.len());
            let node = app.db.create_node(&Node { name: id.clone(), ..Default::default() }, &id).unwrap();
            let started = if status == "unconfirmed" { now - TIMEOUT } else { now };
            app.db.start_agent_removal(node, &id, started).unwrap();
            match status {
                "queued" => {}
                "failed" => app.db.agent_removal_progress(node, &id, "failed", "test failure").unwrap(),
                _ => {
                    app.db.confirm_agent_removal(&id, "stopping", "", Some(&id)).unwrap();
                    if status == "unconfirmed" {
                        app.db.expire_agent_removals(now).unwrap();
                    } else {
                        app.db.confirm_agent_removal(&id, status, "", None).unwrap();
                    }
                }
            }
            requests.push(id);
        }
        // Include unfinished/failed IDs deliberately. A second success that was
        // not on the screen when Clear was clicked must also remain visible.
        let ids = requests[..5].to_vec();
        let response = dismiss(Admin, State(app.clone()), Json(Dismiss { ids: ids.clone() })).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app.db.dismiss_completed_removals(&ids).unwrap(), 0, "clearing twice is harmless");
        let jobs = app.db.agent_removals().unwrap();
        assert_eq!(jobs.iter().filter(|job| job.dismissed).count(), 1);
        assert!(jobs.iter().find(|job| job.id == requests[0]).unwrap().dismissed);
        for job in jobs.iter().filter(|job| job.id != requests[0]) {
            assert!(!job.dismissed, "{} must stay visible", job.status);
        }
        assert_eq!(report(&app, &requests[0], "succeeded").await, StatusCode::OK);
        assert!(
            app.db.agent_removals().unwrap().iter().find(|job| job.id == requests[0]).unwrap().dismissed,
            "a retried callback must not reappear in history"
        );
        drop(app);
        let reopened = Db::open(path.to_str().unwrap()).unwrap();
        assert!(
            reopened.agent_removals().unwrap().iter().find(|job| job.id == requests[0]).unwrap().dismissed,
            "clearing survives a hub restart"
        );
        assert_eq!(reopened.nodes().unwrap().len(), 4, "clearing history never deletes a node");
    }

    #[tokio::test]
    async fn admin_routes_require_login_and_callback_requires_its_scoped_credential() {
        use axum::{body::Body, http::Request as HttpRequest};
        use tower::ServiceExt;
        let (app, node, _rx) = fixture(true);
        let router = axum::Router::new()
            .route("/api/agent-removals", axum::routing::get(list).delete(dismiss))
            .route("/api/nodes/{id}/removal", axum::routing::post(start))
            .route("/api/agent/removal", axum::routing::post(callback))
            .with_state(app);
        for (method, path, body) in [
            ("GET", "/api/agent-removals".into(), ""),
            ("DELETE", "/api/agent-removals".into(), r#"{"ids":[]}"#),
            ("POST", format!("/api/nodes/{node}/removal"), ""),
            ("POST", "/api/agent/removal".into(), r#"{"status":"succeeded"}"#),
        ] {
            let request = HttpRequest::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(router.clone().oneshot(request).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
    }
}
