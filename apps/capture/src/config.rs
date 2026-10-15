use anyhow::Context;
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    data: Value,
}

impl Config {
    pub fn load() -> Self {
        let mut data = default_config();
        let config_path = env::var("KORTIX_CONFIG").unwrap_or_else(|_| "config.yaml".to_string());
        if let Ok(contents) = fs::read_to_string(&config_path) {
            match serde_yaml::from_str::<serde_yaml::Value>(&contents)
                .ok()
                .and_then(|v| serde_json::to_value(v).ok())
            {
                Some(file_data) => merge(&mut data, file_data),
                None => tracing::warn!("Ignoring invalid config file: {}", config_path),
            }
        }
        Self { data }
    }

    pub fn get_value<'a>(&'a self, path: &str) -> Option<&'a Value> {
        let mut current = &self.data;
        for part in path.split('.') {
            current = current.get(part)?;
        }
        Some(current)
    }

    pub fn get_bool(&self, path: &str, default: bool) -> bool {
        self.get_value(path)
            .and_then(Value::as_bool)
            .unwrap_or(default)
    }

    pub fn get_usize(&self, path: &str, default: usize) -> usize {
        self.get_value(path)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .unwrap_or(default)
    }

    pub fn get_u32(&self, path: &str, default: u32) -> u32 {
        self.get_value(path)
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(default)
    }

    pub fn get_f64(&self, path: &str, default: f64) -> f64 {
        self.get_value(path)
            .and_then(Value::as_f64)
            .unwrap_or(default)
    }

    pub fn get_string(&self, path: &str) -> Option<String> {
        self.get_value(path)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }

    #[cfg(test)]
    pub(crate) fn from_value(update: Value) -> Self {
        let mut data = default_config();
        merge(&mut data, update);
        Self { data }
    }
}

pub fn default_recordings_directory(config: &Config) -> anyhow::Result<PathBuf> {
    if let Some(path) = config.get_string("recordings.directory") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    Ok(app_data_directory()?.join("recordings"))
}

pub fn app_data_directory() -> anyhow::Result<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        directories::BaseDirs::new()
            .map(|dirs| dirs.home_dir().join("Library/Application Support/Kortix"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Kortix"))
    } else {
        directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".local/share/kortix"))
    };

    base.context("failed to determine an app data directory")
}

pub fn log_directory() -> anyhow::Result<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        directories::BaseDirs::new().map(|dirs| dirs.home_dir().join("Library/Logs/Kortix"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Kortix").join("Logs"))
    } else {
        directories::BaseDirs::new().map(|dirs| dirs.home_dir().join(".local/share/kortix/logs"))
    };

    base.context("failed to determine a log directory")
}

fn default_config() -> Value {
    json!({
        "screen_recorder": {
            "fps": 5,
            "burst_fps": 5,
            "burst_after_seconds": 1.0,
            "idle_interval_seconds": 15.0,
            "idle_after_seconds": 3.0,
            "idle_dedupe_distance": 3,
            "idle_heartbeat_seconds": 300.0,
            "quality": 60,
            "scale_factor": 0.5,
            "capture_mode": "all_displays"
        },
        "a11y_recorder": {
            "enabled": false,
            "interval_seconds": 10.0,
            "max_depth": 12,
            "max_children": 200,
            "max_nodes": 3000
        },
        "audio_recorder": {
            "sample_rate": 16000,
            "channels": 1,
            "flush_interval_seconds": 60.0
        },
        "recordings": {
            "directory": null,
            "writers": {
                "buffer_sizes": {
                    "preprocessed": 100,
                    "a11y": 5,
                    "raw": 1000
                }
            },
            "autostart": {
                "enabled": false,
                "recording_prefix": "startup",
                "enable_audio": false,
                "save_raw_data": true,
                "detailed_events": true
            },
            "stop_screenshot_delay_ms": 350
        },
        "actions": {
            "local_cap_gb": 2.0
        },
        "debug": {
            "enabled": false
        }
    })
}

fn merge(base: &mut Value, update: Value) {
    match (base, update) {
        (Value::Object(base_map), Value::Object(update_map)) => {
            for (key, value) in update_map {
                merge(base_map.entry(key).or_insert(Value::Null), value);
            }
        }
        (base_slot, update_value) => *base_slot = update_value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_screen_recorder_cadence_is_stable_five_fps() {
        let config = Config::from_value(json!({}));

        assert_eq!(config.get_u32("screen_recorder.fps", 0), 5);
        assert_eq!(config.get_u32("screen_recorder.burst_fps", 0), 5);
        assert_eq!(
            config.get_f64("screen_recorder.idle_interval_seconds", 0.0),
            15.0
        );
        assert_eq!(
            config.get_f64("screen_recorder.idle_after_seconds", 0.0),
            3.0
        );
        assert_eq!(config.get_u32("screen_recorder.idle_dedupe_distance", 0), 3);
        assert_eq!(
            config.get_f64("screen_recorder.idle_heartbeat_seconds", 0.0),
            300.0
        );
        assert_eq!(config.get_f64("actions.local_cap_gb", 0.0), 2.0);
    }
}
