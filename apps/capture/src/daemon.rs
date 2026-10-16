//! The action recorder's segments after they stop, and the headless service.
//!
//! - [`ingest_segment`]: a finished segment goes into the capture library
//!   (`memory::actions::ingest`); a segment of a segmented session
//!   (`production_ephemeral`) then leaves the recorder spool, unless it was
//!   recorded with raw debug capture. The library keeps its action store under
//!   `actions.local_cap_gb`.
//! - [`recover_segments`]: at start, segments a crash left behind are finalized
//!   (the processed file regenerated from the raw stream when it never flushed)
//!   and ingested, so nothing recorded is lost.
//! - [`run_service`] (`kortix-backend --service`): a segmented session kept
//!   running while the policy allows actions. The recorder's sync uploads what
//!   it adds to the library.

use crate::{
    config::Config,
    memory::{actions, paths::MemoryPaths, settings::Settings},
    models::{LocalArtifactsMode, StartRecordingRequest},
    recording_service::RecordingService,
    session::{self, AppState},
};
use anyhow::Context;
use chrono::Utc;
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc, time::Duration};

const LOCAL_CAP_GB_DEFAULT: f64 = 2.0;

/// `actions.local_cap_gb` (default 2) in bytes.
pub fn actions_cap_bytes(config: &Config) -> u64 {
    (config
        .get_f64("actions.local_cap_gb", LOCAL_CAP_GB_DEFAULT)
        .max(0.1)
        * 1024.0
        * 1024.0
        * 1024.0) as u64
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn is_ephemeral(metadata: &Value) -> bool {
    metadata.get("local_artifacts_mode").and_then(Value::as_str)
        == Some(LocalArtifactsMode::ProductionEphemeral.as_str())
}

/// Add a stopped segment to the library, then (segmented sessions only) delete
/// its spool and keep the action store under `cap_bytes`.
pub fn ingest_segment(
    recordings_dir: &Path,
    name: &str,
    cap_bytes: u64,
) -> anyhow::Result<Option<actions::Ingested>> {
    let paths = MemoryPaths::resolve();
    let dir = recordings_dir.join(name);
    let ingested = actions::ingest(&paths, &dir, name)
        .with_context(|| format!("add segment {name} to the library"))?;
    // A segment recorded with raw debug capture keeps its raw events (and its
    // metadata) on this computer for inspection; "Clean Raw Cache" frees them.
    let meta = read_json(&dir.join(format!("{name}_metadata.json")));
    if meta.as_ref().is_some_and(is_ephemeral) {
        let keep_raw = meta.as_ref().is_some_and(|m| m["save_raw_data"] == true);
        let res = if keep_raw {
            let keep = [format!("{name}_raw.jsonl"), format!("{name}_metadata.json")];
            fs::read_dir(&dir).map(|rd| {
                for e in rd.flatten() {
                    if !keep
                        .iter()
                        .any(|k| e.file_name().to_str() == Some(k.as_str()))
                    {
                        let _ = if e.path().is_dir() {
                            fs::remove_dir_all(e.path())
                        } else {
                            fs::remove_file(e.path())
                        };
                    }
                }
            })
        } else {
            fs::remove_dir_all(&dir)
        };
        if let Err(err) = res {
            tracing::warn!("failed to clear the spool of {name}: {err}");
        }
    }
    let sync_on = Settings::load(&paths).sync.enabled;
    if let Err(err) = actions::enforce_cap(&paths, cap_bytes, sync_on) {
        tracing::warn!("action store cap: {err:#}");
    }
    Ok(ingested)
}

/// Finalize and ingest every segmented-session spool except `exclude` (the
/// active one). Returns the segments added to the library.
pub fn recover_segments(recordings_dir: &Path, exclude: Option<&str>, cap_bytes: u64) -> usize {
    let Ok(entries) = fs::read_dir(recordings_dir) else {
        return 0;
    };
    let mut added = 0;
    for entry in entries.flatten().filter(|e| e.path().is_dir()) {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if Some(name.as_str()) == exclude {
            continue;
        }
        let Some(metadata) = read_json(&entry.path().join(format!("{name}_metadata.json"))) else {
            continue;
        };
        if !is_ephemeral(&metadata) {
            continue;
        }
        if let Err(err) = finalize_abandoned_segment(&entry.path(), &name) {
            tracing::warn!("failed to finalize abandoned segment {name}: {err:#}");
            continue;
        }
        match ingest_segment(recordings_dir, &name, cap_bytes) {
            Ok(Some(_)) => added += 1,
            Ok(None) => {}
            Err(err) => tracing::warn!("recovered segment {name}: {err:#}"),
        }
    }
    added
}

/// A segment killed mid-recording has no `end_time`, and its processed file
/// may be empty (the writer never flushed). Regenerate it from the raw stream
/// and close the metadata. Ok(true) when the segment was finalized now.
pub fn finalize_abandoned_segment(recording_dir: &Path, name: &str) -> anyhow::Result<bool> {
    let metadata_path = recording_dir.join(format!("{name}_metadata.json"));
    let Some(mut metadata) = read_json(&metadata_path) else {
        return Ok(false);
    };
    if metadata.get("end_time").and_then(Value::as_str).is_some() {
        return Ok(false);
    }
    let preprocessed = recording_dir.join(format!("{name}_preprocessed.jsonl"));
    if !has_bytes(&preprocessed) {
        let raw = recording_dir.join(format!("{name}_raw.jsonl"));
        if !has_bytes(&raw) {
            return Ok(false);
        }
        crate::processor::process_raw_to_preprocessed(&raw, &preprocessed)
            .with_context(|| format!("regenerate {} from raw", preprocessed.display()))?;
    }
    let end_time = ["preprocessed", "a11y", "raw"]
        .iter()
        .filter_map(|suffix| {
            fs::metadata(recording_dir.join(format!("{name}_{suffix}.jsonl")))
                .and_then(|m| m.modified())
                .ok()
                .map(chrono::DateTime::<Utc>::from)
        })
        .max()
        .unwrap_or_else(Utc::now);
    metadata["end_time"] = json!(end_time.to_rfc3339());
    if let Some(start) = metadata
        .get("start_time")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<chrono::DateTime<Utc>>().ok())
    {
        metadata["duration_seconds"] = json!((end_time - start).num_seconds().max(0));
    }
    metadata["recovered_after_unexpected_shutdown"] = json!(true);
    fs::write(&metadata_path, serde_json::to_vec_pretty(&metadata)?)
        .with_context(|| format!("write {}", metadata_path.display()))?;
    tracing::info!("finalized abandoned segment {}", recording_dir.display());
    Ok(true)
}

fn has_bytes(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

#[derive(Debug, Clone)]
pub struct ServiceOptions {
    pub segment_seconds: u64,
    pub save_raw_data: bool,
}

/// `kortix-backend --service`: runs until SIGINT/SIGTERM. The supervisor
/// (`kortix-capture service run`) starts it and restarts it when it exits.
pub async fn run_service(config: Config, options: ServiceOptions) -> anyhow::Result<()> {
    let recording_service = RecordingService::new(config.clone())?;
    let recordings_dir = recording_service.recordings_dir.clone();
    let cap = actions_cap_bytes(&config);
    let recovered = {
        let dir = recordings_dir.clone();
        tokio::task::spawn_blocking(move || recover_segments(&dir, None, cap)).await?
    };
    if recovered > 0 {
        tracing::info!(
            recovered,
            "added segments left by an earlier run to the library"
        );
    }
    let state = Arc::new(AppState::new(recording_service));
    tracing::info!("kortix-backend service running");
    let mut shutdown = Box::pin(shutdown_signal());
    loop {
        ensure_recording(&state, &options).await;
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
        }
    }
    if state.session.lock().await.is_some() {
        let _ = session::stop_session(state.clone()).await;
    }
    Ok(())
}

/// Keep a segmented session running unless the policy blocks actions (the
/// session stops itself when it does; this starts it again once allowed).
async fn ensure_recording(state: &Arc<AppState>, o: &ServiceOptions) {
    if state.session.lock().await.is_some() {
        return;
    }
    let request = StartRecordingRequest {
        name: Some(format!("service_{}", Utc::now().format("%Y%m%d_%H%M%S"))),
        enable_audio: false,
        save_raw_data: o.save_raw_data,
        detailed_events: o.save_raw_data,
        start_online: true,
        local_artifacts_mode: LocalArtifactsMode::ProductionEphemeral,
        segmented: true,
        segment_seconds: Some(o.segment_seconds),
    };
    if let Err(err) = session::start(state.clone(), request).await {
        tracing::info!("action recording not started: {}", err.detail);
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::terminate()) {
        Ok(mut term) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
