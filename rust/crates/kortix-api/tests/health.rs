use std::collections::HashMap;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use kortix_api::{app, config::Config, AppState};
use serde_json::Value;
use tower::ServiceExt;

fn test_state() -> AppState {
    AppState::new(
        &Config::from_environment(&HashMap::from([
            ("INTERNAL_KORTIX_ENV".to_owned(), "test".to_owned()),
            ("KORTIX_VERSION".to_owned(), "1.2.3".to_owned()),
            ("KORTIX_COMMIT".to_owned(), "abcdef12".to_owned()),
            ("HOSTNAME".to_owned(), "test-instance".to_owned()),
        ]))
        .unwrap(),
    )
}

async fn request(state: AppState, path: &str) -> (StatusCode, Value) {
    let response = app(state)
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn compatibility_health_preserves_identity_fields() {
    for path in ["/health", "/v1/health"] {
        let (status, body) = request(test_state(), path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["service"], "kortix-api");
        assert_eq!(body["environment"], "test");
        assert_eq!(body["version"], "1.2.3");
        assert_eq!(body["commit"], "abcdef12");
        assert_eq!(body["instance"], "test-instance");
        assert_eq!(body["scheduler_leader"], false);
        assert!(body["trigger_scheduler"].as_object().unwrap().is_empty());
        assert!(body["timestamp"].as_str().unwrap().ends_with('Z'));
        assert!(body["started_at"].as_str().unwrap().ends_with('Z'));
    }
}

#[tokio::test]
async fn liveness_is_available_on_both_routes() {
    for path in ["/health/live", "/v1/health/live"] {
        let (status, body) = request(test_state(), path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({"status":"ok", "event_loop_lag_ms":0})
        );
    }
}

#[tokio::test]
async fn readiness_tracks_startup_and_shutdown() {
    let state = test_state();
    let (status, body) = request(state.clone(), "/health/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "starting");

    state.mark_ready();
    let (status, body) = request(state.clone(), "/v1/health/ready").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({"status":"ok"}));

    state.begin_shutdown();
    let (status, body) = request(state, "/health/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "draining");
}
