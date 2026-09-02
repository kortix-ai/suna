pub mod config;

use std::{
    collections::BTreeMap,
    fmt::Write as _,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::time::{sleep_until, Instant};

use config::Config;

#[derive(Clone)]
pub struct AppState {
    identity: Arc<ServiceIdentity>,
    ready: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    event_loop_lag: EventLoopLag,
    max_event_loop_lag_ms: u64,
    cors: Arc<CorsConfig>,
}

#[derive(Clone, Default)]
pub struct EventLoopLag(Arc<AtomicU64>);

impl EventLoopLag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_ms(&self, milliseconds: u64) {
        self.set_duration(Duration::from_millis(milliseconds));
    }

    pub fn set_duration(&self, duration: Duration) {
        self.0.store(
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX),
            Ordering::Release,
        );
    }

    fn nanoseconds(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }

    fn rounded_milliseconds(&self) -> u64 {
        self.nanoseconds().saturating_add(500_000) / 1_000_000
    }
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
            event_loop_lag: EventLoopLag::new(),
            max_event_loop_lag_ms: config.max_event_loop_lag_ms,
            cors: Arc::new(CorsConfig::new(config)),
        }
    }

    pub fn with_event_loop_lag(config: &Config, event_loop_lag: EventLoopLag) -> Self {
        let mut state = Self::new(config);
        state.event_loop_lag = event_loop_lag;
        state
    }

    pub fn event_loop_lag(&self) -> EventLoopLag {
        self.event_loop_lag.clone()
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
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, response_context))
}

const CLOUD_ORIGINS: &[&str] = &[
    "https://www.kortix.com",
    "https://kortix.com",
    "https://dev.kortix.com",
    "https://new-dev.kortix.com",
    "https://dev-new.kortix.com",
    "https://staging.kortix.com",
    "https://kortix.cloud",
    "https://www.kortix.cloud",
    "https://new.kortix.com",
];
const LOCAL_ORIGINS: &[&str] = &[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3010",
    "http://127.0.0.1:3010",
];
const ALLOW_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOW_HEADERS: &str = "Content-Type,Authorization,X-Kortix-Token,X-Api-Key,Accept,X-Kortix-Signature,X-Hub-Signature-256,traceparent,tracestate,X-Request-Id,Last-Event-ID,X-Kortix-Client,Cache-Control,X-Kortix-Impersonate,X-Kortix-Admin-Bypass";
const EXPOSE_HEADERS: &str = "X-Next-Cursor,X-Request-Id,X-Audit-Row-Count,X-Audit-Capped,X-Audit-Complete,X-Audit-Next-Cursor,X-Kortix-Proxy-Hop,X-Kortix-Upstream-Status,X-Kortix-Boot-Phase,Server-Timing";
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
struct CorsConfig {
    environment: String,
    extra_origins: Vec<String>,
}

impl CorsConfig {
    fn new(config: &Config) -> Self {
        Self {
            environment: config.environment.clone(),
            extra_origins: config.cors_allowed_origins.clone(),
        }
    }

    fn allows(&self, origin: &str) -> bool {
        CLOUD_ORIGINS.contains(&origin)
            || LOCAL_ORIGINS.contains(&origin)
            || self.extra_origins.iter().any(|allowed| allowed == origin)
            || (self.environment == "preview" && is_preview_origin(origin))
    }
}

async fn response_context(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let started = std::time::Instant::now();
    let incoming_traceparent = request
        .headers()
        .get("traceparent")
        .and_then(|value| value.to_str().ok());
    let traceparent = create_traceparent(incoming_traceparent);
    let allowed_origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| state.cors.allows(origin))
        .map(str::to_owned);
    let is_preflight = request.method() == Method::OPTIONS
        && request.headers().contains_key(header::ORIGIN)
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);

    let mut response = if is_preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };

    let headers = response.headers_mut();
    headers.insert(
        "x-request-id",
        HeaderValue::from_str(&request_id()).unwrap(),
    );
    headers.insert("traceparent", HeaderValue::from_str(&traceparent).unwrap());
    headers.insert(
        "server-timing",
        HeaderValue::from_str(&format!("api;dur={}", started.elapsed().as_millis())).unwrap(),
    );
    merge_vary_origin(headers);
    if let Some(origin) = allowed_origin {
        apply_cors_headers(headers, &origin, is_preflight);
    }
    response
}

fn merge_vary_origin(headers: &mut HeaderMap) {
    let already_varies = headers.get_all(header::VARY).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|name| name == "*" || name.eq_ignore_ascii_case("origin"))
        })
    });
    if !already_varies {
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
    }
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: &str, is_preflight: bool) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_str(origin).unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
    if is_preflight {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOW_METHODS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOW_HEADERS),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
    }
}

fn is_preview_origin(origin: &str) -> bool {
    let lower = origin.to_ascii_lowercase();
    let Some(host) = lower.strip_prefix("https://") else {
        return false;
    };
    [".vercel.app", ".preview.kortix.com"].iter().any(|suffix| {
        host.strip_suffix(suffix).is_some_and(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    })
}

fn request_id() -> String {
    let milliseconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}", base36(milliseconds), base36(u128::from(sequence)))
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut output = [0_u8; 26];
    let mut index = output.len();
    loop {
        index -= 1;
        output[index] = DIGITS[(value % 36) as usize];
        value /= 36;
        if value == 0 {
            break;
        }
    }
    String::from_utf8(output[index..].to_vec()).unwrap()
}

fn create_traceparent(incoming: Option<&str>) -> String {
    let parsed = incoming.and_then(parse_traceparent);
    let trace_id = parsed
        .as_ref()
        .map(|(trace_id, _, _)| trace_id.clone())
        .unwrap_or_else(|| random_nonzero_hex::<16>(None));
    let parent_span = parsed.as_ref().map(|(_, span_id, _)| span_id.as_str());
    let span_id = random_nonzero_hex::<8>(parent_span);
    let flags = parsed
        .as_ref()
        .map(|(_, _, flags)| flags.as_str())
        .unwrap_or("01");
    format!("00-{trace_id}-{span_id}-{flags}")
}

fn parse_traceparent(value: &str) -> Option<(String, String, String)> {
    let normalized = value.trim().to_ascii_lowercase();
    let mut parts = normalized.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some()
        || version != "00"
        || !valid_hex(trace_id, 32)
        || !valid_hex(span_id, 16)
        || !valid_hex(flags, 2)
        || trace_id.bytes().all(|byte| byte == b'0')
        || span_id.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    Some((trace_id.to_owned(), span_id.to_owned(), flags.to_owned()))
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_nonzero_hex<const N: usize>(not_equal: Option<&str>) -> String {
    loop {
        let mut bytes = [0_u8; N];
        getrandom::getrandom(&mut bytes).expect("operating system random source unavailable");
        if bytes.iter().all(|byte| *byte == 0) {
            continue;
        }
        let mut value = String::with_capacity(N * 2);
        for byte in bytes {
            write!(&mut value, "{byte:02x}").unwrap();
        }
        if not_equal != Some(value.as_str()) {
            return value;
        }
    }
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

async fn liveness(State(state): State<AppState>) -> impl IntoResponse {
    let lag_ns = state.event_loop_lag.nanoseconds();
    let lag = state.event_loop_lag.rounded_milliseconds();
    let threshold_ns = state.max_event_loop_lag_ms.saturating_mul(1_000_000);
    if lag_ns > threshold_ns {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "degraded",
                "event_loop_lag_ms": lag,
                "threshold_ms": state.max_event_loop_lag_ms,
            })),
        );
    }
    (
        StatusCode::OK,
        Json(json!({"status": "ok", "event_loop_lag_ms": lag})),
    )
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

pub fn spawn_event_loop_lag_sampler(state: EventLoopLag) -> tokio::task::JoinHandle<()> {
    tokio::spawn(sample_event_loop_lag(state, Duration::from_secs(1)))
}

async fn sample_event_loop_lag(state: EventLoopLag, interval: Duration) {
    loop {
        let deadline = Instant::now() + interval;
        sleep_until(deadline).await;
        let lag = Instant::now().saturating_duration_since(deadline);
        state.set_duration(lag);
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vary_origin_merges_without_replacing_or_duplicating_values() {
        let mut headers = HeaderMap::new();
        headers.append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        merge_vary_origin(&mut headers);
        merge_vary_origin(&mut headers);
        let values = headers
            .get_all(header::VARY)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values, ["Accept-Encoding", "Origin"]);
    }
}
