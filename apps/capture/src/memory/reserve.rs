//! Disk reserve: a pre-allocated file in the library that the recorder deletes
//! when free disk space is critically low.
//!
//! SQLite (WAL) and the video finalizer need a little room to commit. If the
//! disk fills completely, a commit fails and the library can stall. The reserve
//! holds `storage.reserve_mb` of real, non-sparse bytes. When free space drops
//! below `CRITICAL_FREE_GB` the recorder deletes the file, which hands that space
//! back at once. When free space recovers the file grows again, one slice per
//! check, so refilling never causes a burst of disk writes.
//!
//! The file is not part of `retention::usage().total()`, so it never counts
//! against the storage cap.

use super::paths::MemoryPaths;
use super::settings::Settings;
use std::io::Write;
use std::path::PathBuf;

pub const FILE: &str = ".kortix-storage-reserve";
/// The reserve grows by this much per maintenance call (every ~60 s).
pub const SLICE_BYTES: u64 = 50 * 1024 * 1024;
/// Free space below this releases the reserve.
pub const CRITICAL_FREE_GB: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Nothing,
    Grew(u64),
    Shrunk(u64),
    /// Free space is critical: the reserve was deleted, `u64` bytes returned.
    Released(u64),
}

pub fn path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join(FILE)
}

pub fn size(paths: &MemoryPaths) -> u64 {
    std::fs::metadata(path(paths)).map(|m| m.len()).unwrap_or(0)
}

/// One maintenance step for the settings in force. `free_gb` is None when unknown.
pub fn maintain(paths: &MemoryPaths, s: &Settings, free_gb: Option<f64>) -> Action {
    step(
        paths,
        s.storage.reserve_mb * 1024 * 1024,
        SLICE_BYTES,
        free_gb,
        s.storage.min_free_gb,
    )
}

fn step(
    paths: &MemoryPaths,
    target: u64,
    slice: u64,
    free_gb: Option<f64>,
    min_free_gb: f64,
) -> Action {
    let file = path(paths);
    let current = size(paths);
    if free_gb.is_some_and(|gb| gb < CRITICAL_FREE_GB) || target == 0 {
        return if current > 0 && std::fs::remove_file(&file).is_ok() {
            Action::Released(current)
        } else {
            Action::Nothing
        };
    }
    if current > target {
        return match std::fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .and_then(|f| f.set_len(target))
        {
            Ok(()) => Action::Shrunk(current - target),
            Err(_) => Action::Nothing,
        };
    }
    if current == target {
        return Action::Nothing;
    }
    let add = slice.min(target - current);
    // Never grow into the space the recording gate protects.
    if free_gb.is_some_and(|gb| gb - add as f64 / 1e9 < min_free_gb) {
        return Action::Nothing;
    }
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)?;
        // A non-zero pattern: no filesystem compresses it away, so the blocks are really taken.
        let block = vec![0xA5u8; 1024 * 1024];
        let mut left = add;
        while left > 0 {
            let n = left.min(block.len() as u64) as usize;
            f.write_all(&block[..n])?;
            left -= n as u64;
        }
        f.sync_all()
    };
    match write() {
        Ok(()) => Action::Grew(add),
        Err(_) => {
            // A full disk mid-write: give the partial slice back.
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .open(&file)
                .and_then(|f| f.set_len(current));
            Action::Nothing
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn lib() -> (Dir, MemoryPaths) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "kmem-reserve-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&root).unwrap();
        (Dir(root.clone()), MemoryPaths::at(root))
    }

    #[test]
    fn grows_one_slice_at_a_time_to_the_target() {
        let (_d, p) = lib();
        let (target, slice) = (2500, 1000);
        assert_eq!(
            step(&p, target, slice, Some(100.0), 5.0),
            Action::Grew(1000)
        );
        assert_eq!(size(&p), 1000);
        assert_eq!(
            step(&p, target, slice, Some(100.0), 5.0),
            Action::Grew(1000)
        );
        assert_eq!(step(&p, target, slice, Some(100.0), 5.0), Action::Grew(500));
        assert_eq!(size(&p), 2500);
        assert_eq!(step(&p, target, slice, Some(100.0), 5.0), Action::Nothing);
        assert!(
            std::fs::read(path(&p)).unwrap().iter().all(|b| *b == 0xA5),
            "real bytes, not a sparse hole"
        );
    }

    #[test]
    fn releases_when_free_disk_is_critical_and_regrows_after() {
        let (_d, p) = lib();
        step(&p, 2000, 2000, Some(100.0), 5.0);
        assert_eq!(size(&p), 2000);
        assert_eq!(step(&p, 2000, 2000, Some(0.4), 5.0), Action::Released(2000));
        assert!(!path(&p).exists());
        assert_eq!(
            step(&p, 2000, 2000, Some(0.4), 5.0),
            Action::Nothing,
            "nothing left to release"
        );
        // Low but not critical (below min_free_gb): do not regrow into the protected space.
        assert_eq!(step(&p, 2000, 2000, Some(4.0), 5.0), Action::Nothing);
        assert_eq!(size(&p), 0);
        assert_eq!(step(&p, 2000, 2000, Some(50.0), 5.0), Action::Grew(2000));
    }

    #[test]
    fn unknown_free_space_still_maintains_and_a_smaller_target_shrinks() {
        let (_d, p) = lib();
        assert_eq!(step(&p, 3000, 3000, None, 5.0), Action::Grew(3000));
        assert_eq!(step(&p, 1000, 3000, None, 5.0), Action::Shrunk(2000));
        assert_eq!(size(&p), 1000);
        assert_eq!(
            step(&p, 0, 3000, None, 5.0),
            Action::Released(1000),
            "reserve_mb = 0 turns it off"
        );
        assert!(!path(&p).exists());
    }

    #[test]
    fn the_reserve_does_not_count_toward_the_storage_cap() {
        let (_d, p) = lib();
        p.ensure().unwrap();
        step(&p, 4096, 4096, Some(100.0), 5.0);
        assert_eq!(super::super::retention::usage(&p).total(), 0);
    }
}
