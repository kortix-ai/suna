//! Filesystem layout of the capture library.
//!
//! Everything lives under one data directory so backup, retention, and
//! "delete my data" are one `rm -rf`:
//!
//! ```text
//! <data_dir>/memory.db        SQLite index (frames, OCR, FTS5, segments, AX)
//! <data_dir>/frames/          staged JPEG stills awaiting video encode
//! <data_dir>/videos/          finalized 1 fps HEVC chunks (sha256 names)
//! <data_dir>/icons/           app icons and favicons
//! <data_dir>/audio/           audio memory segments (only once audio is turned on)
//! <data_dir>/audio/staging/   raw PCM of the open and unencoded segments
//! <data_dir>/settings.json    user settings (hot-reloaded by the recorder)
//! <data_dir>/recorder.json    recorder heartbeat/status
//! <data_dir>/recorder.lock    single-instance lock
//! <data_dir>/.kortix-storage-reserve  disk reserve, released when disk is critically low
//! ```

use std::path::{Path, PathBuf};

pub const DATA_DIR_ENV: &str = "KORTIX_CAPTURE_DIR";
pub const BUNDLE_ID: &str = "ai.kortix.capture";

/// Create `dir` (and parents) readable only by the owner on Unix: a library holds
/// everything the person saw on screen. A directory that exists keeps its mode,
/// except the library root, which is tightened.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

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
        for dir in [
            self.root.clone(),
            self.frames_dir(),
            self.videos_dir(),
            self.icons_dir(),
        ] {
            create_private_dir(&dir)?;
        }
        #[cfg(unix)]
        {
            // A library made by an older build may be world-readable.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))?;
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
    /// Created on the first recorded segment, never by `ensure`: audio is opt-in.
    pub fn audio_dir(&self) -> PathBuf {
        self.root.join("audio")
    }
    pub fn audio_staging_dir(&self) -> PathBuf {
        self.audio_dir().join("staging")
    }
    pub fn audio_status(&self) -> PathBuf {
        self.root.join("audio.json")
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
    /// Held by whoever runs a sync pass: one uploader per library.
    pub fn sync_lock(&self) -> PathBuf {
        self.root.join("sync.lock")
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn the_library_is_private_to_its_owner() {
        let root = std::env::temp_dir().join(format!("kcap-paths-{}", uuid::Uuid::new_v4().simple()));
        // An older build left the root world-readable.
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = MemoryPaths::at(&root);
        p.ensure().unwrap();
        for d in [&p.root, &p.frames_dir(), &p.videos_dir(), &p.icons_dir()] {
            let mode = std::fs::metadata(d).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", d.display());
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
