use std::collections::HashMap;

use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Method, Request, StatusCode},
    response::Response,
};
use kortix_api::{app, config::Config, AppState, EventLoopLag};
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

async fn raw_request(state: AppState, request: Request<Body>) -> Response<Body> {
    app(state).oneshot(request).await.unwrap()
}

async fn request(state: AppState, path: &str) -> (StatusCode, HeaderMap, Value) {
    let response = raw_request(state, Request::get(path).body(Body::empty()).unwrap()).await;
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, headers, serde_json::from_slice(&body).unwrap())
}

fn assert_response_context(headers: &HeaderMap) {
    let request_id = headers["x-request-id"].to_str().unwrap();
    assert!(!request_id.is_empty());

    let traceparent = headers["traceparent"].to_str().unwrap();
    let parts: Vec<_> = traceparent.split('-').collect();
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], "00");
    assert_eq!(parts[1].len(), 32);
    assert_eq!(parts[2].len(), 16);
    assert_eq!(parts[3].len(), 2);
    assert!(parts[1..].iter().all(|part| part
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())));
    assert_ne!(parts[1], "00000000000000000000000000000000");
    assert_ne!(parts[2], "0000000000000000");

    let timing = headers["server-timing"].to_str().unwrap();
    let duration = timing.strip_prefix("api;dur=").unwrap();
    assert!(
        duration.parse::<u64>().is_ok(),
        "invalid Server-Timing: {timing}"
    );
}

#[tokio::test]
async fn compatibility_health_preserves_identity_fields() {
    for path in ["/health", "/v1/health"] {
        let (status, _headers, body) = request(test_state(), path).await;
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
        let (status, _headers, body) = request(test_state(), path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({"status":"ok", "event_loop_lag_ms":0})
        );
    }
}

#[tokio::test]
async fn liveness_matches_bun_at_and_above_threshold() {
    let config = Config::from_environment(&HashMap::from([(
        "HEALTH_MAX_EVENT_LOOP_LAG_MS".to_owned(),
        "5000".to_owned(),
    )]))
    .unwrap();
    let lag = EventLoopLag::new();
    let state = AppState::with_event_loop_lag(&config, lag.clone());

    lag.set_ms(5000);
    let (status, _headers, body) = request(state.clone(), "/health/live").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        serde_json::json!({"status":"ok", "event_loop_lag_ms":5000})
    );

    lag.set_ms(5001);
    let (status, _headers, body) = request(state, "/v1/health/live").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        serde_json::json!({
            "status":"degraded",
            "event_loop_lag_ms":5001,
            "threshold_ms":5000
        })
    );
}

#[tokio::test]
async fn liveness_compares_unrounded_lag_and_rounds_response_like_bun() {
    let config = Config::from_environment(&HashMap::from([(
        "HEALTH_MAX_EVENT_LOOP_LAG_MS".to_owned(),
        "5000".to_owned(),
    )]))
    .unwrap();
    let lag = EventLoopLag::new();
    let state = AppState::with_event_loop_lag(&config, lag.clone());

    lag.set_duration(std::time::Duration::from_micros(5_000_400));
    let (status, _headers, body) = request(state.clone(), "/health/live").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body,
        serde_json::json!({
            "status":"degraded",
            "event_loop_lag_ms":5000,
            "threshold_ms":5000
        })
    );

    lag.set_duration(std::time::Duration::from_micros(5_000_500));
    let (status, _headers, body) = request(state, "/health/live").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["event_loop_lag_ms"], 5001);
}

#[tokio::test]
async fn readiness_tracks_startup_and_shutdown() {
    let state = test_state();
    let (status, _headers, body) = request(state.clone(), "/health/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "starting");

    state.mark_ready();
    let (status, _headers, body) = request(state.clone(), "/v1/health/ready").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::json!({"status":"ok"}));

    state.begin_shutdown();
    let (status, _headers, body) = request(state, "/health/ready").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "draining");
}

#[tokio::test]
async fn all_health_aliases_receive_fresh_response_context() {
    let mut request_ids = std::collections::HashSet::new();
    for path in [
        "/health",
        "/v1/health",
        "/health/live",
        "/v1/health/live",
        "/health/ready",
        "/v1/health/ready",
    ] {
        let response = raw_request(
            test_state(),
            Request::get(path).body(Body::empty()).unwrap(),
        )
        .await;
        assert_response_context(response.headers());
        assert_eq!(response.headers()[header::VARY], "Origin");
        assert!(request_ids.insert(
            response.headers()["x-request-id"]
                .to_str()
                .unwrap()
                .to_owned()
        ));
    }
}

#[tokio::test]
async fn valid_incoming_traceparent_preserves_trace_and_flags_with_a_new_span() {
    let incoming = "00-99999999999999999999999999999999-8888888888888888-00";
    let response = raw_request(
        test_state(),
        Request::get("/health")
            .header("traceparent", incoming)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_response_context(response.headers());
    let outgoing = response.headers()["traceparent"].to_str().unwrap();
    assert!(outgoing.starts_with("00-99999999999999999999999999999999-"));
    assert!(outgoing.ends_with("-00"));
    assert_ne!(outgoing, incoming);
}

#[tokio::test]
async fn invalid_incoming_traceparent_is_replaced() {
    let response = raw_request(
        test_state(),
        Request::get("/health")
            .header(
                "traceparent",
                "00-00000000000000000000000000000000-8888888888888888-01",
            )
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_response_context(response.headers());
    assert!(!response.headers()["traceparent"]
        .to_str()
        .unwrap()
        .contains("00000000000000000000000000000000"));
}

#[tokio::test]
async fn cors_allows_cloud_local_and_configured_origins() {
    let config = Config::from_environment(&HashMap::from([
        ("INTERNAL_KORTIX_ENV".to_owned(), "prod".to_owned()),
        (
            "CORS_ALLOWED_ORIGINS".to_owned(),
            " https://customer.example, https://second.example ".to_owned(),
        ),
    ]))
    .unwrap();
    for origin in [
        "https://kortix.com",
        "http://127.0.0.1:3010",
        "https://customer.example",
        "https://second.example",
    ] {
        let response = raw_request(
            AppState::new(&config),
            Request::get("/health")
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.headers()["access-control-allow-origin"], origin);
        assert_eq!(
            response.headers()["access-control-allow-credentials"],
            "true"
        );
        let exposed = response.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(exposed.contains("x-request-id"));
        assert!(exposed.contains("server-timing"));
    }
}

#[tokio::test]
async fn cors_denies_unknown_production_and_gates_preview_origins() {
    let production = Config::from_environment(&HashMap::from([(
        "INTERNAL_KORTIX_ENV".to_owned(),
        "prod".to_owned(),
    )]))
    .unwrap();
    let preview = Config::from_environment(&HashMap::from([(
        "INTERNAL_KORTIX_ENV".to_owned(),
        "preview".to_owned(),
    )]))
    .unwrap();
    let origin = "https://pr-123.preview.kortix.com";

    let denied = raw_request(
        AppState::new(&production),
        Request::get("/health")
            .header(header::ORIGIN, origin)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(!denied.headers().contains_key("access-control-allow-origin"));
    assert_eq!(denied.headers()[header::VARY], "Origin");

    let allowed = raw_request(
        AppState::new(&preview),
        Request::get("/health")
            .header(header::ORIGIN, origin)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(allowed.headers()["access-control-allow-origin"], origin);
    assert_eq!(allowed.headers()[header::VARY], "Origin");
}

#[tokio::test]
async fn denied_cors_preflight_still_varies_on_origin() {
    let response = raw_request(
        test_state(),
        Request::builder()
            .method(Method::OPTIONS)
            .uri("/health")
            .header(header::ORIGIN, "https://denied.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(!response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    assert_eq!(response.headers()[header::VARY], "Origin");
}

#[tokio::test]
async fn cors_preflight_has_bun_contract_and_response_context() {
    let response = raw_request(
        test_state(),
        Request::builder()
            .method(Method::OPTIONS)
            .uri("/v1/health/ready")
            .header(header::ORIGIN, "http://localhost:3000")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PATCH")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization,traceparent,x-request-id,cache-control",
            )
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(response.status().is_success());
    assert_response_context(response.headers());
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "http://localhost:3000"
    );
    assert_eq!(
        response.headers()["access-control-allow-credentials"],
        "true"
    );
    assert_eq!(response.headers()["access-control-max-age"], "600");
    let methods = response.headers()["access-control-allow-methods"]
        .to_str()
        .unwrap();
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
        assert!(methods.contains(method));
    }
    let headers = response.headers()["access-control-allow-headers"]
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    for name in [
        "authorization",
        "x-api-key",
        "traceparent",
        "x-request-id",
        "cache-control",
    ] {
        assert!(headers.contains(name));
    }
}

#[tokio::test]
async fn unavailable_health_responses_receive_context_and_cors() {
    let state = test_state();
    let response = raw_request(
        state,
        Request::get("/health/ready")
            .header(header::ORIGIN, "https://dev.kortix.com")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_response_context(response.headers());
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "https://dev.kortix.com"
    );
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        serde_json::json!({"status":"starting", "reason":"schema not ready"})
    );
}
