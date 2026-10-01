//! Filesystem layout of the capture library.
//!
//! Everything lives under one data directory so backup, retention, and
//! "delete my data" are one `rm -rf`:
//!
//! ```text
//! <data_dir>/memory.db        SQLite index (frames, OCR, FTS5, segments, AX)
//! <data_dir>/frames/          staged JPEG stills awaiting video encode
//! <data_dir>/videos/          finalized 1 fps H.264 chunks (sha256 names)
//! <data_dir>/icons/           app icons
//! <data_dir>/settings.json    user settings (hot-reloaded by the recorder)
//! <data_dir>/recorder.json    recorder heartbeat/status
//! <data_dir>/recorder.lock    single-instance lock
//! ```

use std::path::{Path, PathBuf};

pub const DATA_DIR_ENV: &str = "KORTIX_CAPTURE_DIR";
pub const BUNDLE_ID: &str = "ai.kortix.capture";

#[derive(Debug, Clone)]
pub struct MemoryPaths {
    pub root: PathBuf,
}

impl MemoryPaths {
    /// `$KORTIX_CAPTURE_DIR` (tests, alternate libraries) or the platform data dir.
    pub fn resolve() -> Self {
        if let Ok(dir) = std::env::var(DATA_DIR_ENV) {
            if !dir.trim().is_empty() {
                return Self::at(dir);
            }
        }
        let base = directories::BaseDirs::new()
            .map(|b| b.data_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        Self::at(base.join(BUNDLE_ID))
    }

    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for dir in [self.root.clone(), self.frames_dir(), self.videos_dir(), self.icons_dir()] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn db(&self) -> PathBuf {
        self.root.join("memory.db")
    }
    pub fn frames_dir(&self) -> PathBuf {
        self.root.join("frames")
    }
    pub fn videos_dir(&self) -> PathBuf {
        self.root.join("videos")
    }
    pub fn icons_dir(&self) -> PathBuf {
        self.root.join("icons")
    }
    pub fn settings(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn status(&self) -> PathBuf {
        self.root.join("recorder.json")
    }
    pub fn lock(&self) -> PathBuf {
        self.root.join("recorder.lock")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn export_dir() -> PathBuf {
        std::env::temp_dir().join("kortix-capture")
    }

    /// Resolve a path stored in the DB (relative to the root) to an absolute path.
    pub fn abs(&self, stored: &str) -> PathBuf {
        let p = Path::new(stored);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        }
    }

    /// Store paths relative to the root so the library can be moved.
    pub fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }
}
