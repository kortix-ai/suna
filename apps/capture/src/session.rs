//! The action recorder's segmented session, run by `kortix-backend --service`.
//!
//! A session records back-to-back segments of `segment_seconds` (default 60). Each finished
//! segment goes into the capture library as an action segment
//! (`memory::actions::ingest`), its recorder spool is removed, and the library's
//! sync engine uploads it in the Kortix Capture format when sync is on. The
//! library keeps the action store under `actions.local_cap_gb` (default 2).
//! A session refuses to start, and stops within one segment flush, while the
//! operator's policy turns actions off or pauses recording.

use crate::{
    config::Config,
    daemon,
    error::{AppError, AppResult},
    memory::{paths::MemoryPaths, settings::Settings, store::now_ms},
    models::StartRecordingRequest,
    recording_service::RecordingService,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
};
use uuid::Uuid;

const SEGMENT_SECONDS_DEFAULT: u64 = 60;
const SEGMENT_SECONDS_MIN: u64 = 5;
const SEGMENT_FLUSH_SECONDS: u64 = 5;

pub struct AppState {
    pub recording_service: Mutex<RecordingService>,
    pub session: Mutex<Option<Arc<SegmentedSession>>>,
}

impl AppState {
    pub fn new(recording_service: RecordingService) -> Self {
        Self {
            recording_service: Mutex::new(recording_service),
            session: Mutex::new(None),
        }
    }
}

pub struct SegmentedSession {
    session_id: String,
    session_name: String,
    segment_seconds: u64,
    config: Config,
    recordings_dir: PathBuf,
    request_template: StartRecordingRequest,
    stop_requested: AtomicBool,
    wake: Notify,
    operation_lock: Mutex<()>,
    task: Mutex<Option<JoinHandle<()>>>,
    state: Mutex<SessionState>,
}

#[derive(Debug, Default)]
struct SessionState {
    next_sequence: u64,
    active_sequence: Option<u64>,
    active_segment_name: Option<String>,
    completed_segments: u64,
    ingested_segments: u64,
    failed_segments: u64,
    recorded_seconds: i64,
    last_error: Option<String>,
}

#[derive(Debug, Clone)]
struct StoppedSegment {
    name: String,
    sequence: u64,
}

impl SegmentedSession {
    fn new(
        session_name: String,
        segment_seconds: u64,
        config: Config,
        recordings_dir: PathBuf,
        mut request_template: StartRecordingRequest,
    ) -> Self {
        request_template.name = None;
        request_template.segmented = false;
        request_template.segment_seconds = None;
        request_template.start_online = true;
        Self {
            session_id: format!("rec_{}", Uuid::new_v4().simple()),
            session_name,
            segment_seconds,
            config,
            recordings_dir,
            request_template,
            stop_requested: AtomicBool::new(false),
            wake: Notify::new(),
            operation_lock: Mutex::new(()),
            task: Mutex::new(None),
            state: Mutex::new(SessionState {
                next_sequence: 1,
                ..SessionState::default()
            }),
        }
    }

    async fn active_segment_name(&self) -> Option<String> {
        self.state.lock().await.active_segment_name.clone()
    }
}

/// Why actions may not record now under the operator's policy.
pub fn actions_blocked_by_policy() -> Option<&'static str> {
    Settings::effective(&MemoryPaths::resolve()).actions_blocked(now_ms())
}

/// Start a segmented session, unless the policy blocks actions or one runs.
pub async fn start(state: Arc<AppState>, request: StartRecordingRequest) -> AppResult<()> {
    if let Some(reason) = actions_blocked_by_policy() {
        return Err(AppError::conflict(if reason == "policy_paused" {
            "Your organization's policy has paused recording on this computer."
        } else {
            "Your organization's policy turns action recording off on this computer."
        }));
    }
    start_session(state, request).await
}

async fn start_session(state: Arc<AppState>, request: StartRecordingRequest) -> AppResult<()> {
    let config = Config::load();
    let recordings_dir = state.recording_service.lock().await.recordings_dir.clone();
    let session_name = request
        .name
        .clone()
        .unwrap_or_else(|| format!("service_{}", Utc::now().format("%Y%m%d_%H%M%S")));
    let segment_seconds = request
        .segment_seconds
        .unwrap_or(SEGMENT_SECONDS_DEFAULT)
        .max(SEGMENT_SECONDS_MIN);
    let session = Arc::new(SegmentedSession::new(
        session_name,
        segment_seconds,
        config,
        recordings_dir,
        request,
    ));
    {
        let mut slot = state.session.lock().await;
        if slot.is_some() {
            return Err(AppError::conflict(
                "Segmented recording is already in progress",
            ));
        }
        let mut service = state.recording_service.lock().await;
        if service.is_recording {
            return Err(AppError::conflict("Recording is already in progress"));
        }
        start_next_segment(&mut service, &session).await?;
        *slot = Some(session.clone());
    }
    let worker_state = state.clone();
    let worker_session = session.clone();
    let handle = tokio::spawn(async move {
        session_worker(worker_state, worker_session).await;
    });
    *session.task.lock().await = Some(handle);
    Ok(())
}

pub async fn stop_session(state: Arc<AppState>) -> AppResult<()> {
    let session = state
        .session
        .lock()
        .await
        .take()
        .ok_or_else(|| AppError::bad_request("No recording in progress"))?;
    session.stop_requested.store(true, Ordering::SeqCst);
    session.wake.notify_waiters();
    {
        let _guard = session.operation_lock.lock().await;
        let stopped = {
            let mut service = state.recording_service.lock().await;
            stop_active_segment(&mut service, &session).await?
        };
        if let Some(segment) = stopped {
            ingest_segment(&session, &segment).await;
        }
    }
    if let Some(handle) = session.task.lock().await.take() {
        handle.abort();
    }
    Ok(())
}

async fn session_worker(state: Arc<AppState>, session: Arc<SegmentedSession>) {
    use tokio::time::Instant as TokioInstant;

    let segment_duration = std::time::Duration::from_secs(session.segment_seconds);
    let flush_duration = std::time::Duration::from_secs(SEGMENT_FLUSH_SECONDS);
    let segment_sleep = tokio::time::sleep(segment_duration);
    tokio::pin!(segment_sleep);

    loop {
        let flush_sleep = tokio::time::sleep(flush_duration);
        tokio::pin!(flush_sleep);
        tokio::select! {
            _ = &mut segment_sleep => {
                if session.stop_requested.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(err) = rotate_segment(&state, &session).await {
                    session.state.lock().await.last_error = Some(format!("segment rotation failed: {err}"));
                    tracing::error!("action segment rotation failed: {err}");
                }
                segment_sleep.as_mut().reset(TokioInstant::now() + segment_duration);
            }
            _ = &mut flush_sleep => {
                if session.stop_requested.load(Ordering::SeqCst) {
                    return;
                }
                // The operator turned actions off or paused recording: stop within one flush.
                if let Some(reason) = tokio::task::spawn_blocking(actions_blocked_by_policy).await.ok().flatten() {
                    tracing::info!(reason, "stopping action recording: the policy turned it off");
                    let _ = stop_session(state.clone()).await;
                    return;
                }
                flush_active_segment(&state, &session).await;
            }
            _ = session.wake.notified() => {}
        }
        if session.stop_requested.load(Ordering::SeqCst) {
            return;
        }
    }
}

async fn flush_active_segment(state: &Arc<AppState>, session: &Arc<SegmentedSession>) {
    let _guard = session.operation_lock.lock().await;
    let mut service = state.recording_service.lock().await;
    let expected = session.active_segment_name().await;
    if expected.as_deref() != service.current_recording_name.as_deref() {
        return;
    }
    if let Err(err) = service.flush_active_buffers() {
        session.state.lock().await.last_error = Some(format!("segment flush failed: {err}"));
        tracing::warn!("failed to flush the active action segment: {err}");
    }
}

async fn rotate_segment(state: &Arc<AppState>, session: &Arc<SegmentedSession>) -> AppResult<()> {
    let _guard = session.operation_lock.lock().await;
    let stopped = {
        let mut service = state.recording_service.lock().await;
        let stopped = stop_active_segment(&mut service, session).await?;
        if !session.stop_requested.load(Ordering::SeqCst) {
            start_next_segment(&mut service, session).await?;
        }
        stopped
    };
    if let Some(segment) = stopped {
        ingest_segment(session, &segment).await;
    }
    Ok(())
}

async fn start_next_segment(
    service: &mut RecordingService,
    session: &Arc<SegmentedSession>,
) -> AppResult<String> {
    let sequence = {
        let mut st = session.state.lock().await;
        let sequence = st.next_sequence;
        st.next_sequence += 1;
        sequence
    };
    let name = segment_name(&session.session_name, sequence);
    let mut request = session.request_template.clone();
    request.name = Some(name.clone());
    service.start_recording(request)?;
    if let Err(err) = write_session_metadata(&session.recordings_dir, &name, session, sequence) {
        tracing::warn!("failed to persist session metadata for {name}: {err}");
    }
    let mut st = session.state.lock().await;
    st.active_sequence = Some(sequence);
    st.active_segment_name = Some(name.clone());
    Ok(name)
}

async fn stop_active_segment(
    service: &mut RecordingService,
    session: &Arc<SegmentedSession>,
) -> AppResult<Option<StoppedSegment>> {
    let (expected, sequence) = {
        let st = session.state.lock().await;
        (st.active_segment_name.clone(), st.active_sequence)
    };
    if !service.is_recording {
        let mut st = session.state.lock().await;
        st.active_sequence = None;
        st.active_segment_name = None;
        return Ok(None);
    }
    if let Some(expected) = expected.as_deref() {
        if service.current_recording_name.as_deref() != Some(expected) {
            return Err(AppError::conflict(format!(
                "Active recording is {}, expected segment {expected}",
                service
                    .current_recording_name
                    .as_deref()
                    .unwrap_or("unknown")
            )));
        }
    }
    let response = service.stop_recording()?;
    let mut st = session.state.lock().await;
    st.completed_segments += 1;
    st.recorded_seconds += response.duration_seconds.unwrap_or(0).max(0);
    st.active_sequence = None;
    st.active_segment_name = None;
    Ok(Some(StoppedSegment {
        name: response.name,
        sequence: sequence.unwrap_or(0),
    }))
}

/// Into the library, off the spool. A failure leaves the spool for the next
/// start's recovery (`daemon::recover_segments`).
async fn ingest_segment(session: &Arc<SegmentedSession>, segment: &StoppedSegment) {
    let (dir, name, cap) = (
        session.recordings_dir.clone(),
        segment.name.clone(),
        daemon::actions_cap_bytes(&session.config),
    );
    let res = tokio::task::spawn_blocking(move || daemon::ingest_segment(&dir, &name, cap))
        .await
        .map_err(|e| anyhow::anyhow!("ingest task: {e}"))
        .and_then(|r| r);
    let mut st = session.state.lock().await;
    match res {
        Ok(_) => st.ingested_segments += 1,
        Err(err) => {
            tracing::warn!(segment = %segment.name, sequence = segment.sequence, "action segment not added to the library: {err:#}");
            st.failed_segments += 1;
            st.last_error = Some(format!("{err:#}"));
        }
    }
}

fn write_session_metadata(
    recordings_dir: &std::path::Path,
    name: &str,
    session: &SegmentedSession,
    sequence: u64,
) -> Result<(), String> {
    let path = recordings_dir
        .join(name)
        .join(format!("{name}_metadata.json"));
    let mut metadata: Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    metadata["recording_session_id"] = json!(session.session_id);
    metadata["recording_session_name"] = json!(session.session_name);
    metadata["recording_session_sequence"] = json!(sequence);
    fs::write(
        &path,
        serde_json::to_vec_pretty(&metadata).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

fn segment_name(session_name: &str, sequence: u64) -> String {
    let base: String = session_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let base = base.trim_matches('_');
    let base = if base.is_empty() { "service" } else { base };
    format!(
        "{base}_chunk_{sequence:04}_{}",
        Utc::now().format("%Y%m%d_%H%M%S")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_names_are_safe_and_sequenced() {
        let n = segment_name("service 2026/10/01", 7);
        assert!(n.starts_with("service_2026_10_01_chunk_0007_"), "{n}");
        assert!(segment_name("///", 1).starts_with("service_chunk_0001_"));
    }
}
