use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRecordingRequest {
    pub name: Option<String>,
    #[serde(default = "default_true")]
    pub enable_audio: bool,
    #[serde(default)]
    pub save_raw_data: bool,
    #[serde(default = "default_true")]
    pub detailed_events: bool,
    #[serde(default)]
    pub start_online: bool,
    #[serde(default)]
    pub local_artifacts_mode: LocalArtifactsMode,
    /// Record back-to-back segments that go into the capture library (the tray's mode).
    #[serde(default)]
    pub segmented: bool,
    #[serde(default)]
    pub segment_seconds: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalArtifactsMode {
    Durable,
    ProductionEphemeral,
}

impl Default for LocalArtifactsMode {
    fn default() -> Self {
        Self::Durable
    }
}

impl LocalArtifactsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Durable => "durable",
            Self::ProductionEphemeral => "production_ephemeral",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingResponse {
    pub status: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub preprocessed_file_path: String,
    pub audio_file_path: Option<String>,
    pub raw_data_file_path: Option<String>,
    pub a11y_file_path: Option<String>,
    pub metadata_file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_raw_data: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed_events: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingStatusResponse {
    pub is_recording: bool,
    pub recording_name: Option<String>,
    pub audio_enabled: Option<bool>,
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segmented: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_segment_name: Option<String>,
    /// Segments added to the capture library (they sync from there).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ingested_segments: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_segments: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
