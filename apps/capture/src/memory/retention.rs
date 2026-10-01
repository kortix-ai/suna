//! Storage management: keep the library under a size cap or a retention
//! window. Screenshots go; text, titles, URLs and search stay.
//!
//! `video.status`: 0 full resolution, 1 downscaled, 2 deleted (frames keep
//! their OCR text; queries report the screenshot as removed).

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::settings::Settings;
use super::store::now_ms;
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;
use std::time::Duration;

pub const STATUS_FULL: i64 = 0;
pub const STATUS_DOWNSCALED: i64 = 1;
pub const STATUS_DELETED: i64 = 2;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Usage {
    pub db_bytes: u64,
    pub video_bytes: u64,
    pub staged_bytes: u64,
    pub icon_bytes: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.db_bytes + self.video_bytes + self.staged_bytes + self.icon_bytes
    }
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()?.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

pub fn usage(paths: &MemoryPaths) -> Usage {
    let db = ["memory.db", "memory.db-wal", "memory.db-shm"]
        .iter()
        .filter_map(|f| std::fs::metadata(paths.root.join(f)).ok())
        .map(|m| m.len())
        .sum();
    Usage {
        db_bytes: db,
        video_bytes: dir_bytes(&paths.videos_dir()),
        staged_bytes: dir_bytes(&paths.frames_dir()),
        icon_bytes: dir_bytes(&paths.icons_dir()),
    }
}

pub fn enforce(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings) -> Result<()> {
    match s.storage.management_mode.as_str() {
        "storage_cap" => enforce_cap(conn, paths, engine, s),
        "retention" => enforce_retention(conn, paths, engine, s),
        _ => Ok(()),
    }
}

struct VideoRow {
    id: i64,
    path: String,
    num_frames: i64,

    size: i64,
}

fn oldest_videos(conn: &Connection, max_status: i64, older_than_ms: Option<i64>, limit: i64) -> Result<Vec<VideoRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, num_frames, status, COALESCE(size_bytes, 0) FROM video
         WHERE status <= ?1 AND (?2 IS NULL OR COALESCE(end_timestamp, 0) < ?2)
         ORDER BY id LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![max_status, older_than_ms, limit], |r| {
        Ok(VideoRow { id: r.get(0)?, path: r.get(1)?, num_frames: r.get(2)?, size: r.get(4)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn delete_video(conn: &Connection, paths: &MemoryPaths, id: i64, path: &str) -> Result<()> {
    let _ = std::fs::remove_file(paths.videos_dir().join(path));
    conn.execute("UPDATE video SET status = ?1, size_bytes = 0 WHERE id = ?2", params![STATUS_DELETED, id])?;
    Ok(())
}

fn downscale_video(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings, v: &VideoRow) -> Result<i64> {
    let src = paths.videos_dir().join(&v.path);
    let tmp = paths.videos_dir().join(format!("{}.downscale.mp4", v.path));
    let resp = engine.request(
        json!({"cmd": "transcode", "video": src.to_string_lossy(), "out": tmp.to_string_lossy(),
               "frames": v.num_frames, "scale": s.storage.archived_scale, "quality": 0.4}),
        Duration::from_secs(300),
    )?;
    std::fs::rename(&tmp, &src)?;
    let size = resp.get("size_bytes").and_then(|x| x.as_i64()).unwrap_or(0);
    conn.execute(
        "UPDATE video SET status = ?1, size_bytes = ?2, width = ?3, height = ?4 WHERE id = ?5",
        params![
            STATUS_DOWNSCALED,
            size,
            resp.get("width").and_then(|x| x.as_i64()),
            resp.get("height").and_then(|x| x.as_i64()),
            v.id
        ],
    )?;
    Ok(v.size - size)
}

fn enforce_cap(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings) -> Result<()> {
    let limit = (s.storage.limit_gb * 1e9) as i64;
    if limit <= 0 {
        return Ok(());
    }
    let mut over = usage(paths).total() as i64 - limit;
    if over <= 0 {
        return Ok(());
    }
    // Free 5% headroom so the cap is not hit again on the next chunk.
    over += limit / 20;
    if s.storage.cap_action == "downscale" {
        while over > 0 {
            let batch = oldest_videos(conn, STATUS_FULL, None, 20)?;
            if batch.is_empty() {
                break;
            }
            for v in &batch {
                match downscale_video(conn, paths, engine, s, v) {
                    Ok(saved) => over -= saved,
                    Err(err) => {
                        tracing::warn!("downscale video {} failed: {err:#}; deleting instead", v.id);
                        delete_video(conn, paths, v.id, &v.path)?;
                        over -= v.size;
                    }
                }
                if over <= 0 {
                    break;
                }
            }
        }
    }
    while over > 0 {
        let batch = oldest_videos(conn, STATUS_DOWNSCALED, None, 200)?;
        if batch.is_empty() {
            break;
        }
        for v in batch {
            delete_video(conn, paths, v.id, &v.path)?;
            over -= v.size;
            if over <= 0 {
                break;
            }
        }
    }
    Ok(())
}

fn enforce_retention(conn: &Connection, paths: &MemoryPaths, engine: &mut Engine, s: &Settings) -> Result<()> {
    let cutoff = now_ms() - s.storage.retention_days as i64 * 86_400_000;
    if s.storage.retention_action == "downscale" {
        loop {
            let batch = oldest_videos(conn, STATUS_FULL, Some(cutoff), 20)?;
            if batch.is_empty() {
                break;
            }
            for v in &batch {
                if let Err(err) = downscale_video(conn, paths, engine, s, v) {
                    tracing::warn!("downscale video {} failed: {err:#}", v.id);
                    conn.execute("UPDATE video SET status = ?1 WHERE id = ?2", params![STATUS_DOWNSCALED, v.id])?;
                }
            }
        }
    } else {
        loop {
            let batch = oldest_videos(conn, STATUS_DOWNSCALED, Some(cutoff), 200)?;
            if batch.is_empty() {
                break;
            }
            for v in batch {
                delete_video(conn, paths, v.id, &v.path)?;
            }
        }
    }
    Ok(())
}

/// Preview what a policy would touch, without changing anything.
pub fn preview(conn: &Connection, paths: &MemoryPaths, s: &Settings) -> Result<serde_json::Value> {
    let u = usage(paths);
    let cutoff = now_ms() - s.storage.retention_days as i64 * 86_400_000;
    let (older_count, older_bytes): (i64, i64) = conn.query_row(
        "SELECT count(*), COALESCE(sum(size_bytes), 0) FROM video WHERE status < 2 AND COALESCE(end_timestamp, 0) < ?1",
        [cutoff],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(json!({
        "usage": u,
        "total_bytes": u.total(),
        "limit_bytes": (s.storage.limit_gb * 1e9) as i64,
        "videos_older_than_retention": older_count,
        "bytes_older_than_retention": older_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::store;

    #[test]
    fn delete_keeps_text_and_marks_video() {
        let dir = std::env::temp_dir().join(format!("kmem-ret-{}", std::process::id()));
        let paths = MemoryPaths::at(&dir);
        let conn = store::open(&paths).unwrap();
        std::fs::write(paths.videos_dir().join("abc"), b"xxxx").unwrap();
        conn.execute("INSERT INTO video(height, width, path, num_frames, size_bytes) VALUES (10, 10, 'abc', 1, 4)", []).unwrap();
        conn.execute("INSERT INTO frame(timestamp, video, video_index, foreground, ocr_status) VALUES (1, 1, 0, 'kept text', 1)", []).unwrap();
        delete_video(&conn, &paths, 1, "abc").unwrap();
        assert!(!paths.videos_dir().join("abc").exists());
        let (status, text): (i64, String) = conn
            .query_row("SELECT v.status, f.foreground FROM frame f JOIN video v ON v.id = f.video", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(status, STATUS_DELETED);
        assert_eq!(text, "kept text");
        let _ = std::fs::remove_dir_all(dir);
    }
}
