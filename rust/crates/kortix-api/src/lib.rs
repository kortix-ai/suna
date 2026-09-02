pub mod config;

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tower_http::trace::TraceLayer;

use config::Config;

#[derive(Clone)]
pub struct AppState {
    identity: Arc<ServiceIdentity>,
    ready: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
}

#[derive(Debug)]
struct ServiceIdentity {
    environment: String,
    version: String,
    commit: String,
    instance: String,
    started_at: String,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        Self {
            identity: Arc::new(ServiceIdentity {
                environment: config.environment.clone(),
                version: config.version.clone(),
                commit: config.commit.clone(),
                instance: config.instance.clone(),
                started_at: timestamp(),
            }),
            ready: Arc::new(AtomicBool::new(false)),
            draining: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }

    pub fn begin_shutdown(&self) {
        self.draining.store(true, Ordering::Release);
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    timestamp: String,
    environment: String,
    version: String,
    commit: String,
    started_at: String,
    instance: String,
    scheduler_leader: bool,
    trigger_scheduler: BTreeMap<String, Value>,
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/health", get(health))
        .route("/health/live", get(liveness))
        .route("/v1/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .route("/v1/health/ready", get(readiness))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let identity = state.identity;
    Json(HealthResponse {
        status: "ok",
        service: "kortix-api",
        timestamp: timestamp(),
        environment: identity.environment.clone(),
        version: identity.version.clone(),
        commit: identity.commit.clone(),
        started_at: identity.started_at.clone(),
        instance: identity.instance.clone(),
        scheduler_leader: false,
        trigger_scheduler: BTreeMap::new(),
    })
}

async fn liveness() -> Json<Value> {
    Json(json!({"status": "ok", "event_loop_lag_ms": 0}))
}

async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    if state.draining.load(Ordering::Acquire) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "draining", "reason": "shutdown in progress"})),
        );
    }
    if !state.ready.load(Ordering::Acquire) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "starting", "reason": "schema not ready"})),
        );
    }
    (StatusCode::OK, Json(json!({"status": "ok"})))
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
