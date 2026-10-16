use crate::{
    config::{default_recordings_directory, Config},
    error::{AppError, AppResult},
    event_reorder::TimestampReorderedProcessor,
    memory::privacy::{action_gate, ActionPrivacyGate, ActionSessionPolicy},
    models::{
        LocalArtifactsMode, RecordingResponse, RecordingStatusResponse, StartRecordingRequest,
    },
    processor::RealTimeEventProcessor,
    recorders::{A11yHashHistory, EventCallback, RecorderBundle},
    streaming_writer::StreamingJsonlinesWriter,
    utils::Event,
};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

pub struct RecordingService {
    pub recordings_dir: PathBuf,
    config: Config,
    preprocessed_buffer_size: usize,
    a11y_buffer_size: usize,
    raw_data_buffer_size: usize,
    stop_screenshot_delay_ms: u64,
    pub is_recording: bool,
    pub current_recording_name: Option<String>,
    pub current_recording_dir: Option<PathBuf>,
    pub enable_audio: bool,
    pub start_time: Option<DateTime<Utc>>,
    start_instant: Option<Instant>,
    processor: Option<Arc<TimestampReorderedProcessor>>,
    raw_data_writer: Option<Arc<Mutex<StreamingJsonlinesWriter>>>,
    recorders: Option<RecorderBundle>,
    initial_metadata: Option<Value>,
    local_artifacts_mode: LocalArtifactsMode,
    privacy_gate: Arc<ActionPrivacyGate>,
    action_policy: Option<Arc<ActionSessionPolicy>>,
}

impl RecordingService {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        let recordings_dir = default_recordings_directory(&config)?;
        fs::create_dir_all(&recordings_dir)?;
        Ok(Self {
            recordings_dir,
            preprocessed_buffer_size: config
                .get_usize("recordings.writers.buffer_sizes.preprocessed", 100),
            a11y_buffer_size: config.get_usize("recordings.writers.buffer_sizes.a11y", 5),
            raw_data_buffer_size: config.get_usize("recordings.writers.buffer_sizes.raw", 1000),
            stop_screenshot_delay_ms: config.get_usize("recordings.stop_screenshot_delay_ms", 350)
                as u64,
            config,
            is_recording: false,
            current_recording_name: None,
            current_recording_dir: None,
            enable_audio: true,
            start_time: None,
            start_instant: None,
            processor: None,
            raw_data_writer: None,
            recorders: None,
            initial_metadata: None,
            local_artifacts_mode: LocalArtifactsMode::Durable,
            privacy_gate: action_gate().clone(),
            action_policy: None,
        })
    }

    pub fn action_uploads_paused(&self) -> bool {
        self.privacy_gate.blocked()
    }

    pub fn status(&self) -> RecordingStatusResponse {
        RecordingStatusResponse {
            is_recording: self.is_recording,
            recording_name: self.current_recording_name.clone(),
            audio_enabled: self.is_recording.then_some(self.enable_audio),
            start_time: self.start_time.map(|dt| dt.to_rfc3339()),
            segmented: None,
            active_segment_name: None,
            ingested_segments: None,
            failed_segments: None,
            last_error: None,
        }
    }

    pub fn start_recording(
        &mut self,
        request: StartRecordingRequest,
    ) -> AppResult<RecordingResponse> {
        if self.is_recording {
            return Err(AppError::bad_request("Recording is already in progress"));
        }

        let name = request
            .name
            .unwrap_or_else(|| format!("recording_{}", Utc::now().format("%Y%m%d_%H%M%S")));
        let recording_dir = self.recordings_dir.join(&name);
        fs::create_dir_all(&recording_dir).map_err(|err| {
            AppError::internal(format!("Failed to create recording directory: {err}"))
        })?;

        let preprocessed_file_path = recording_dir.join(format!("{name}_preprocessed.jsonl"));
        let a11y_file_path = recording_dir.join(format!("{name}_a11y.jsonl"));
        let audio_file_path = recording_dir.join(format!("{name}_audio.flac"));
        let raw_data_file_path = recording_dir.join(format!("{name}_raw.jsonl"));
        let effective_audio_enabled = request.enable_audio && crate::recorders::audio_supported();
        if request.enable_audio && !effective_audio_enabled {
            tracing::warn!(
                "audio recording requested but unavailable in the Rust recorder; continuing without audio"
            );
        }

        let preprocessed_writer = StreamingJsonlinesWriter::new(
            &preprocessed_file_path,
            self.preprocessed_buffer_size,
            true,
        )
        .open()
        .map_err(AppError::from)?;
        let a11y_writer =
            StreamingJsonlinesWriter::new(&a11y_file_path, self.a11y_buffer_size, false)
                .open()
                .map_err(AppError::from)?;
        let a11y_hash_history = windows_a11y_hash_history();
        let a11y_hash_acceptor = a11y_hash_history
            .as_ref()
            .map(|history| windows_a11y_hash_acceptor(history.clone()));
        let processor = RealTimeEventProcessor::new_with_a11y_hash_acceptor(
            Some(preprocessed_writer),
            Some(a11y_writer),
            a11y_hash_acceptor,
        );
        let processor = Arc::new(TimestampReorderedProcessor::new(processor));

        let raw_writer = if request.save_raw_data {
            Some(Arc::new(Mutex::new(
                StreamingJsonlinesWriter::new(
                    &raw_data_file_path,
                    self.raw_data_buffer_size,
                    false,
                )
                .open()
                .map_err(AppError::from)?,
            )))
        } else {
            None
        };

        let callback_processor = processor.clone();
        let callback_raw_writer = raw_writer.clone();
        let callback: EventCallback = Arc::new(move |event: Event| {
            if let Some(writer) = &callback_raw_writer {
                let mut raw_event = event.clone();
                if let Some(object) = raw_event.as_object_mut() {
                    object.remove("event_screenshot_hash");
                }
                if let Err(err) = writer.lock().write(raw_event) {
                    tracing::error!("failed to write raw event: {err}");
                }
            }
            if let Err(err) = callback_processor.add_event(event) {
                tracing::error!("failed to process event: {err}");
            }
        });

        let action_policy = Arc::new(ActionSessionPolicy::new(self.privacy_gate.clone()));
        let exclusions = Arc::new(crate::memory::action_exclusions::ActionExclusions::new(
            &crate::memory::paths::MemoryPaths::resolve(),
            crate::memory::action_exclusions::ProbeFront::start(),
        ));
        let callback = guarded_action_callback(action_policy.clone(), Some(exclusions), callback);
        let mut recorders = RecorderBundle::new(
            callback,
            &self.config,
            effective_audio_enabled,
            effective_audio_enabled.then_some(audio_file_path.clone()),
            a11y_hash_history,
        );
        recorders
            .start()
            .map_err(|err| AppError::internal(format!("Failed to start recorders: {err}")))?;

        self.is_recording = true;
        self.current_recording_name = Some(name.clone());
        self.current_recording_dir = Some(recording_dir.clone());
        self.enable_audio = effective_audio_enabled;
        self.start_time = Some(Utc::now());
        self.start_instant = Some(Instant::now());
        self.processor = Some(processor);
        self.raw_data_writer = raw_writer;
        self.recorders = Some(recorders);
        self.action_policy = Some(action_policy);
        self.local_artifacts_mode = request.local_artifacts_mode;

        let metadata = self.generate_initial_metadata(
            &name,
            effective_audio_enabled,
            request.save_raw_data,
            request.detailed_events,
            request.local_artifacts_mode,
        );
        self.save_metadata(&name, &recording_dir, &metadata)?;
        self.initial_metadata = Some(metadata);

        Ok(RecordingResponse {
            status: "success".to_string(),
            name,
            file: Some(file_name_string(&preprocessed_file_path)),
            preprocessed_file_path: file_name_string(&preprocessed_file_path),
            a11y_file_path: Some(file_name_string(&a11y_file_path)),
            audio_file_path: effective_audio_enabled.then(|| file_name_string(&audio_file_path)),
            raw_data_file_path: request
                .save_raw_data
                .then(|| file_name_string(&raw_data_file_path)),
            metadata_file_path: Some(format!(
                "{}_metadata.json",
                self.current_recording_name.as_deref().unwrap_or_default()
            )),
            audio_enabled: Some(effective_audio_enabled),
            save_raw_data: Some(request.save_raw_data),
            detailed_events: Some(request.detailed_events),
            duration_seconds: None,
        })
    }

    pub fn stop_recording(&mut self) -> AppResult<RecordingResponse> {
        if !self.is_recording {
            return Err(AppError::bad_request("No recording in progress"));
        }

        let name = self
            .current_recording_name
            .clone()
            .ok_or_else(|| AppError::internal("Recording state is missing a name"))?;
        let recording_dir = self
            .current_recording_dir
            .clone()
            .ok_or_else(|| AppError::internal("Recording state is missing a directory"))?;
        if self.stop_screenshot_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(self.stop_screenshot_delay_ms));
        }

        if let Some(recorders) = self.recorders.as_mut() {
            recorders
                .stop()
                .map_err(|err| AppError::internal(format!("Failed to stop recorders: {err}")))?;
        }
        if let Some(processor) = &self.processor {
            processor.stop().map_err(AppError::from)?;
        }
        if let Some(raw_writer) = &self.raw_data_writer {
            raw_writer.lock().close().map_err(AppError::from)?;
        }

        let preprocessed_file_path = recording_dir.join(format!("{name}_preprocessed.jsonl"));
        let a11y_file_path = recording_dir.join(format!("{name}_a11y.jsonl"));
        let audio_file_path = recording_dir.join(format!("{name}_audio.flac"));
        let raw_data_file_path = recording_dir.join(format!("{name}_raw.jsonl"));
        let end_time = Utc::now();
        let monotonic_duration_seconds = self
            .start_instant
            .map(|start| i64::try_from(start.elapsed().as_secs()).unwrap_or(i64::MAX));
        let metadata = self.update_metadata_on_stop(
            &name,
            &recording_dir,
            end_time,
            monotonic_duration_seconds,
            self.enable_audio.then_some(audio_file_path.clone()),
            self.raw_data_writer
                .as_ref()
                .map(|_| raw_data_file_path.clone()),
        )?;
        let detailed_events = metadata
            .get("detailed_events")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let duration_seconds = metadata
            .get("duration_seconds")
            .and_then(value_duration_seconds);
        let metadata_file_path = self.save_metadata(&name, &recording_dir, &metadata)?;

        self.is_recording = false;
        self.current_recording_name = None;
        self.current_recording_dir = None;
        self.enable_audio = true;
        self.start_time = None;
        self.start_instant = None;
        self.processor = None;
        self.raw_data_writer = None;
        self.recorders = None;
        self.action_policy = None;
        self.initial_metadata = None;
        self.local_artifacts_mode = LocalArtifactsMode::Durable;

        Ok(RecordingResponse {
            status: "success".to_string(),
            name,
            preprocessed_file_path: preprocessed_file_path.to_string_lossy().to_string(),
            a11y_file_path: Some(a11y_file_path.to_string_lossy().to_string()),
            file: Some(preprocessed_file_path.to_string_lossy().to_string()),
            audio_file_path: is_nonempty_file(&audio_file_path)
                .then(|| audio_file_path.to_string_lossy().to_string()),
            raw_data_file_path: raw_data_file_path
                .exists()
                .then(|| raw_data_file_path.to_string_lossy().to_string()),
            metadata_file_path: Some(metadata_file_path.to_string_lossy().to_string()),
            audio_enabled: Some(is_nonempty_file(&audio_file_path)),
            save_raw_data: Some(raw_data_file_path.exists()),
            detailed_events: Some(detailed_events),
            duration_seconds,
        })
    }

    pub fn flush_active_buffers(&mut self) -> AppResult<()> {
        if !self.is_recording {
            return Ok(());
        }
        if let Some(processor) = &self.processor {
            processor.flush_writers().map_err(AppError::from)?;
        }
        if let Some(raw_writer) = &self.raw_data_writer {
            raw_writer.lock().flush(true).map_err(AppError::from)?;
        }
        Ok(())
    }

    fn generate_initial_metadata(
        &self,
        name: &str,
        enable_audio: bool,
        save_raw_data: bool,
        detailed_events: bool,
        local_artifacts_mode: LocalArtifactsMode,
    ) -> Value {
        let start_time = self.start_time.unwrap_or_else(Utc::now);
        json!({
            "name": name,
            "app_version": running_app_version(),
            "package_version": env!("CARGO_PKG_VERSION"),
            "release_tag": current_release_tag(),
            "build_sha": current_build_sha(),
            "start_time": start_time.to_rfc3339(),
            "end_time": null,
            "duration_seconds": null,
            "audio_enabled": enable_audio,
            "save_raw_data": save_raw_data,
            "detailed_events": detailed_events,
            "local_artifacts_mode": local_artifacts_mode.as_str(),
            "upload_status": "not_uploaded",
            "total_size_bytes": null,
            "device_info": {
                "platform": std::env::consts::OS,
                "platform_release": "",
                "platform_version": "",
                "machine": std::env::consts::ARCH,
            },
            "file_sizes": {
                "preprocessed": null,
                "a11y": null,
                "audio": null,
                "raw_data": null,
                "metadata": null
            },
            "file_paths": {
                "preprocessed": format!("{name}_preprocessed.jsonl"),
                "a11y": format!("{name}_a11y.jsonl"),
                "audio": enable_audio.then(|| format!("{name}_audio.flac")),
                "raw_data": save_raw_data.then(|| format!("{name}_raw.jsonl")),
                "metadata": format!("{name}_metadata.json")
            }
        })
    }

    fn update_metadata_on_stop(
        &self,
        name: &str,
        recording_dir: &PathBuf,
        end_time: DateTime<Utc>,
        duration_seconds: Option<i64>,
        audio_file_path: Option<PathBuf>,
        raw_data_file_path: Option<PathBuf>,
    ) -> AppResult<Value> {
        let metadata_file_path = recording_dir.join(format!("{name}_metadata.json"));
        let mut metadata = if metadata_file_path.exists() {
            fs::read_to_string(&metadata_file_path)
                .ok()
                .and_then(|data| serde_json::from_str::<Value>(&data).ok())
                .or_else(|| self.initial_metadata.clone())
                .unwrap_or_else(|| json!({}))
        } else {
            self.initial_metadata.clone().unwrap_or_else(|| json!({}))
        };

        metadata["name"] = json!(name);
        set_running_version_metadata(&mut metadata);
        metadata["end_time"] = json!(end_time.to_rfc3339());
        if let Some(duration_seconds) = duration_seconds {
            metadata["duration_seconds"] = json!(duration_seconds.max(0));
        } else if let Some(start_time) = metadata
            .get("start_time")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        {
            metadata["duration_seconds"] = json!((end_time - start_time.with_timezone(&Utc))
                .num_seconds()
                .max(0));
        }

        let preprocessed_path = recording_dir.join(format!("{name}_preprocessed.jsonl"));
        let a11y_path = recording_dir.join(format!("{name}_a11y.jsonl"));
        let metadata_path = recording_dir.join(format!("{name}_metadata.json"));
        let preprocessed_size = file_size(&preprocessed_path);
        let a11y_size = file_size(&a11y_path);
        let audio_size = audio_file_path.as_ref().map(file_size).unwrap_or(0);
        let raw_size = raw_data_file_path.as_ref().map(file_size).unwrap_or(0);
        let metadata_size = file_size(&metadata_path);

        metadata["file_sizes"]["preprocessed"] = json!(preprocessed_size);
        metadata["file_sizes"]["a11y"] = json!(a11y_size);
        metadata["file_sizes"]["audio"] = if audio_file_path
            .as_ref()
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            json!(audio_size)
        } else {
            Value::Null
        };
        metadata["file_sizes"]["raw_data"] = if raw_data_file_path
            .as_ref()
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            json!(raw_size)
        } else {
            Value::Null
        };
        metadata["file_sizes"]["metadata"] = json!(metadata_size);
        metadata["total_size_bytes"] =
            json!(preprocessed_size + a11y_size + audio_size + raw_size + metadata_size);
        metadata["audio_enabled"] = json!(audio_file_path
            .as_ref()
            .map(|p| is_nonempty_file(p))
            .unwrap_or(false));
        metadata["save_raw_data"] = json!(raw_data_file_path
            .as_ref()
            .map(|p| p.exists())
            .unwrap_or(false));

        Ok(metadata)
    }

    fn save_metadata(
        &self,
        name: &str,
        recording_dir: &PathBuf,
        metadata: &Value,
    ) -> AppResult<PathBuf> {
        let metadata_file_path = recording_dir.join(format!("{name}_metadata.json"));
        let bytes = serde_json::to_vec_pretty(metadata)
            .map_err(|err| AppError::internal(format!("Failed to serialize metadata: {err}")))?;
        fs::write(&metadata_file_path, bytes)
            .map_err(|err| AppError::internal(format!("Failed to save metadata: {err}")))?;
        Ok(metadata_file_path)
    }
}

fn guarded_action_callback(
    policy: Arc<ActionSessionPolicy>,
    exclusions: Option<Arc<crate::memory::action_exclusions::ActionExclusions>>,
    callback: EventCallback,
) -> EventCallback {
    Arc::new(move |event| {
        // Every native source converges here while screenshots/AX/keys are still
        // in RAM. Drop before the raw writer and the timestamp processor: first
        // whatever an excluded app, website or private window was in front of,
        // then privacy mode's masking.
        if exclusions.as_ref().is_some_and(|x| !x.admit(&event)) {
            return;
        }
        if let Some(event) = policy.sanitize(event) {
            callback(event);
        }
    })
}

fn file_name_string(path: &PathBuf) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

fn set_running_version_metadata(metadata: &mut Value) {
    metadata["app_version"] = json!(running_app_version());
    metadata["package_version"] = json!(env!("CARGO_PKG_VERSION"));
    metadata["release_tag"] = json!(current_release_tag());
    metadata["build_sha"] = json!(current_build_sha());
}

fn running_app_version() -> &'static str {
    let release_tag = current_release_tag();
    if release_tag.trim().is_empty() || release_tag == "dev" {
        env!("CARGO_PKG_VERSION")
    } else {
        release_tag
    }
}

fn current_release_tag() -> &'static str {
    option_env!("KORTIX_RELEASE_TAG").unwrap_or("dev")
}

fn current_build_sha() -> &'static str {
    option_env!("GITHUB_SHA").unwrap_or("dev")
}

fn windows_a11y_hash_history() -> Option<A11yHashHistory> {
    #[cfg(all(feature = "native-recorders", target_os = "windows"))]
    {
        Some(Arc::new(std::sync::Mutex::new(
            std::collections::VecDeque::with_capacity(20),
        )))
    }

    #[cfg(not(all(feature = "native-recorders", target_os = "windows")))]
    {
        None
    }
}

fn windows_a11y_hash_acceptor(
    history: A11yHashHistory,
) -> Arc<dyn Fn(String) + Send + Sync + 'static> {
    Arc::new(move |hash| {
        if let Some(hash) = parse_a11y_hash(&hash) {
            let mut hashes = history.lock().unwrap_or_else(|err| err.into_inner());
            if hashes.len() >= 20 {
                hashes.pop_front();
            }
            hashes.push_back(hash);
        }
    })
}

fn parse_a11y_hash(hash: &str) -> Option<u64> {
    let trimmed = hash.trim();
    if trimmed.is_empty() {
        return None;
    }
    u64::from_str_radix(trimmed, 16)
        .ok()
        .or_else(|| trimmed.parse::<u64>().ok())
}

fn file_size(path: &PathBuf) -> u64 {
    path.metadata().map(|meta| meta.len()).unwrap_or(0)
}

fn is_nonempty_file(path: &PathBuf) -> bool {
    path.metadata().map(|meta| meta.len() > 0).unwrap_or(false)
}

fn value_duration_seconds(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| {
            value
                .as_u64()
                .and_then(|seconds| i64::try_from(seconds).ok())
        })
        .or_else(|| value.as_f64().map(|seconds| seconds.floor() as i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::LocalArtifactsMode;
    use uuid::Uuid;

    #[test]
    fn privacy_callback_filters_before_raw_and_processed_writes_and_switches_off() {
        use crate::memory::{paths::MemoryPaths, settings::Settings};
        let (_, root) = recording_service_with_temp_dir();
        let paths = MemoryPaths::at(root.join("screen-library"));
        let gate = Arc::new(ActionPrivacyGate::new(&paths));
        let mut settings = Settings::default();
        settings.privacy.redact_pii = true;
        settings.save(&paths).unwrap();
        let raw = Arc::new(Mutex::new(
            StreamingJsonlinesWriter::new(root.join("raw.jsonl"), 1, false)
                .open()
                .unwrap(),
        ));
        let processed = StreamingJsonlinesWriter::new(root.join("processed.jsonl"), 1, true)
            .open()
            .unwrap();
        let processor = Arc::new(TimestampReorderedProcessor::new(
            RealTimeEventProcessor::new(Some(processed), None),
        ));
        let (sink, process) = (raw.clone(), processor.clone());
        let callback = guarded_action_callback(
            Arc::new(ActionSessionPolicy::new(gate)),
            None,
            Arc::new(move |event| {
                sink.lock().write(event.clone()).unwrap();
                process.add_event(event).unwrap();
            }),
        );
        let screenshot = json!({"type":"screenshot", "timestamp":0.0,"data":{"width":16,"height":12,"image":"synthetic-raw-image","encoding":"jpg"}});
        callback(screenshot.clone());
        for (i, character) in "alice@example.com".chars().enumerate() {
            callback(
                json!({"type":"key_down","timestamp":0.1+i as f64/100.0,"data":{"key":character.to_string(),"native_key_code":i,"active_modifiers":[]}}),
            );
            callback(
                json!({"type":"key_up","timestamp":0.105+i as f64/100.0,"data":{"key":character.to_string(),"native_key_code":i}}),
            );
        }
        callback(
            json!({"type":"mouse_down","timestamp":0.5,"data":{"x":0.2,"y":0.3,"button":"left","active_modifiers":[]}}),
        );
        callback(
            json!({"type":"mouse_up","timestamp":0.6,"data":{"x":0.2,"y":0.3,"button":"left","active_modifiers":[]}}),
        );
        let mut after = screenshot;
        after["timestamp"] = json!(1.0);
        callback(after);
        processor.stop().unwrap();
        let saved = fs::read_to_string(root.join("raw.jsonl")).unwrap();
        for line in saved.lines() {
            let event: Value = serde_json::from_str(line).unwrap();
            if event["type"].as_str().unwrap().starts_with("key_") {
                assert_eq!(event["data"]["key"], "[redacted]");
                assert!(event["data"].get("native_key_code").is_none());
            }
        }
        assert!(!saved.contains("synthetic-raw-image"));
        let processed = fs::read_to_string(root.join("processed.jsonl")).unwrap();
        assert!(!processed.contains("alice"));
        assert!(!processed.contains("synthetic-raw-image"));
        assert!(processed.contains("click"));
        assert!(processed.contains("screenshot"));
        assert!(processed.contains("redacted"));
        settings.privacy.redact_pii = false;
        settings.save(&paths).unwrap();
        // Separate sink after the processor has stopped verifies exact opt-out
        // pass-through without native hooks or a production library.
        let plain = Arc::new(Mutex::new(Vec::new()));
        let sink = plain.clone();
        let callback = guarded_action_callback(
            Arc::new(ActionSessionPolicy::new(Arc::new(ActionPrivacyGate::new(
                &paths,
            )))),
            None,
            Arc::new(move |event| sink.lock().push(event)),
        );
        let event =
            json!({"type":"key_down","timestamp":2.0,"data":{"key":"a","native_key_code":0}});
        callback(event.clone());
        assert_eq!(plain.lock().as_slice(), &[event]);
        raw.lock().close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn excluded_front_windows_leave_no_action_in_raw_or_processed_files() {
        use crate::memory::action_exclusions::tests::{front, library, FakeFront};
        use crate::memory::{action_exclusions::ActionExclusions, settings::Settings};
        let (_, root) = recording_service_with_temp_dir();
        let mut settings = Settings::default();
        settings.excluded_bundle_ids = vec!["com.example.Secret".into()];
        settings.excluded_domains = vec!["bank.example".into()];
        let paths = library(&settings);
        let fake = Arc::new(FakeFront::default());
        let exclusions = Arc::new(ActionExclusions::new(&paths, fake.clone()));
        let raw = Arc::new(Mutex::new(
            StreamingJsonlinesWriter::new(root.join("raw.jsonl"), 1, false)
                .open()
                .unwrap(),
        ));
        let processed = StreamingJsonlinesWriter::new(root.join("processed.jsonl"), 1, true)
            .open()
            .unwrap();
        let processor = Arc::new(TimestampReorderedProcessor::new(
            RealTimeEventProcessor::new(Some(processed), None),
        ));
        let (sink, process) = (raw.clone(), processor.clone());
        let callback = guarded_action_callback(
            Arc::new(ActionSessionPolicy::new(Arc::new(ActionPrivacyGate::new(
                &paths,
            )))),
            Some(exclusions.clone()),
            Arc::new(move |event| {
                sink.lock().write(event.clone()).unwrap();
                process.add_event(event).unwrap();
            }),
        );
        let mut t = 0.0;
        let mut type_text = |text: &str, image: &str| {
            callback(
                json!({"type":"screenshot","timestamp":t,"data":{"width":16,"height":12,"image":image,"encoding":"jpg"}}),
            );
            for (i, c) in text.chars().enumerate() {
                t += 0.01;
                callback(
                    json!({"type":"key_down","timestamp":t,"data":{"key":c.to_string(),"native_key_code":i,"active_modifiers":[]}}),
                );
                callback(
                    json!({"type":"key_up","timestamp":t+0.005,"data":{"key":c.to_string(),"native_key_code":i}}),
                );
            }
            t += 0.1;
            callback(
                json!({"type":"mouse_down","timestamp":t,"data":{"x":5.0,"y":5.0,"button":"left"}}),
            );
            callback(
                json!({"type":"mouse_up","timestamp":t+0.05,"data":{"x":5.0,"y":5.0,"button":"left"}}),
            );
            t += 0.5;
        };
        *fake.now.lock() = Some(front("com.example.Secret", None, "Vault"));
        type_text("vaultsecret", "image-of-vault");
        *fake.now.lock() = Some(front(
            "com.google.Chrome",
            Some("https://login.bank.example/"),
            "Bank",
        ));
        type_text("banksecret", "image-of-bank");
        *fake.now.lock() = Some(front(
            "com.google.Chrome",
            Some("https://news.example/"),
            "Incognito - News",
        ));
        type_text("privatesecret", "image-of-private");
        *fake.now.lock() = Some(front("com.apple.TextEdit", None, "Notes"));
        type_text("visible", "image-of-notes");
        processor.stop().unwrap();
        raw.lock().close().unwrap();

        let saved = fs::read_to_string(root.join("raw.jsonl")).unwrap();
        let done = fs::read_to_string(root.join("processed.jsonl")).unwrap();
        for written in [&saved, &done] {
            for secret in ["image-of-vault", "image-of-bank", "image-of-private"] {
                assert!(!written.contains(secret), "{secret} was written");
            }
        }
        let raw_keys: String = saved
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|e| e["type"] == "key_down")
            .map(|e| e["data"]["key"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(raw_keys, "visible");
        assert!(saved.contains("image-of-notes") && done.contains("visible"));
        exclusions.flush();
        let dropped = crate::memory::action_exclusions::status(&paths)["excluded_events"]
            .as_u64()
            .unwrap();
        // Per excluded window: 1 screenshot + 2 events per character + 2 mouse events.
        assert_eq!(
            dropped,
            (1 + 2 * 11 + 2) + (1 + 2 * 10 + 2) + (1 + 2 * 13 + 2)
        );
        fs::remove_dir_all(root).unwrap();
        let _ = fs::remove_dir_all(&paths.root);
    }

    #[test]
    fn initial_metadata_includes_running_version() {
        let (mut service, root) = recording_service_with_temp_dir();
        service.start_time = Some(Utc::now());

        let metadata = service.generate_initial_metadata(
            "versioned",
            false,
            true,
            true,
            LocalArtifactsMode::Durable,
        );

        assert_eq!(metadata["app_version"], running_app_version());
        assert_eq!(metadata["package_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(metadata["release_tag"], current_release_tag());
        assert_eq!(metadata["build_sha"], current_build_sha());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stop_metadata_backfills_running_version() {
        let (service, root) = recording_service_with_temp_dir();
        let name = "versioned_stop";
        let recording_dir = root.join(name);
        fs::create_dir_all(&recording_dir).expect("create recording dir");
        let mut metadata = service.generate_initial_metadata(
            name,
            false,
            false,
            true,
            LocalArtifactsMode::Durable,
        );
        let object = metadata.as_object_mut().expect("metadata object");
        object.remove("app_version");
        object.remove("package_version");
        object.remove("release_tag");
        object.remove("build_sha");
        service
            .save_metadata(name, &recording_dir, &metadata)
            .expect("save metadata");

        let updated = service
            .update_metadata_on_stop(name, &recording_dir, Utc::now(), Some(0), None, None)
            .expect("update metadata");

        assert_eq!(updated["app_version"], running_app_version());
        assert_eq!(updated["package_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(updated["release_tag"], current_release_tag());
        assert_eq!(updated["build_sha"], current_build_sha());

        let _ = fs::remove_dir_all(root);
    }

    fn recording_service_with_temp_dir() -> (RecordingService, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("kortix-recording-service-test-{}", Uuid::new_v4()));
        let config = Config::from_value(json!({
            "recordings": {
                "directory": root.to_string_lossy()
            }
        }));
        (
            RecordingService::new(config).expect("create recording service"),
            root,
        )
    }
}
