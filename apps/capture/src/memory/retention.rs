//! Storage management: keep the library under a size cap or a retention
//! window. Screenshots go; text, titles, URLs and search stay.
//!
//! `video.status`: 0 full resolution, 1 downscaled, 2 deleted (frames keep
//! their OCR text; the UI shows "removed to save storage").
//!
//! Audio segments count toward the same budget. The cap removes the oldest
//! media first, video or audio; audio cannot be shrunk, so "downscale" shrinks
//! video and removes audio. Retention mode removes audio older than
//! `retention_days` whatever the action. Transcripts stay searchable.

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
/// The local file was removed after a verified cloud upload; playback fetches it back.
pub const STATUS_REMOTE: i64 = 3;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct Usage {
    pub db_bytes: u64,
    pub video_bytes: u64,
    pub staged_bytes: u64,
    pub icon_bytes: u64,
    /// Audio segments and staged audio.
    pub audio_bytes: u64,
    /// The disk-reserve file (see `reserve.rs`). Not part of `total()`.
    pub reserve_bytes: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.db_bytes + self.video_bytes + self.staged_bytes + self.icon_bytes + self.audio_bytes
    }
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok()?.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
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
        audio_bytes: super::audio::usage_bytes(paths),
        reserve_bytes: super::reserve::size(paths),
    }
}

pub fn enforce(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
) -> Result<()> {
    match s.storage.management_mode.as_str() {
        "storage_cap" => enforce_cap(conn, paths, engine, s),
        // By age first; the library size cap still holds (a busy week, an upload backlog).
        "retention" => {
            enforce_retention(conn, paths, engine, s)?;
            enforce_cap(conn, paths, engine, s)
        }
        _ => Ok(()),
    }
}

struct VideoRow {
    id: i64,
    path: String,
    num_frames: i64,

    size: i64,
}

/// With sync on, a chunk that has not been uploaded is spared until it is this old when the
/// disk-cap mode frees space. The retention-by-age mode never deletes an unsent chunk.
const UNSENT_GRACE_MS: i64 = 7 * 86_400_000;

/// Unsent chunks before this time may go. `None`: everything may (sync off).
/// By-age retention (`older_than_ms` set) spares every unsent chunk: 0 matches none.
fn unsent_cutoff(s: &Settings, older_than_ms: Option<i64>) -> Option<i64> {
    s.sync.enabled.then(|| {
        if older_than_ms.is_some() {
            0
        } else {
            now_ms() - UNSENT_GRACE_MS
        }
    })
}

fn oldest_videos(
    conn: &Connection,
    s: &Settings,
    max_status: i64,
    older_than_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<VideoRow>> {
    let unsent_before = unsent_cutoff(s, older_than_ms);
    let mut stmt = conn.prepare(
        "SELECT id, path, num_frames, status, COALESCE(size_bytes, 0) FROM video
         WHERE status <= ?1 AND (?2 IS NULL OR COALESCE(end_timestamp, 0) < ?2)
           AND (?4 IS NULL OR uploaded_at IS NOT NULL OR local_only = 1 OR COALESCE(end_timestamp, 0) < ?4)
         ORDER BY id LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        params![max_status, older_than_ms, limit, unsent_before],
        |r| {
            Ok(VideoRow {
                id: r.get(0)?,
                path: r.get(1)?,
                num_frames: r.get(2)?,
                size: r.get(4)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

struct AudioRow {
    id: i64,
    path: String,
    end_ms: i64,
    size: i64,
}

/// Oldest local audio segments, sparing unsent ones like [`oldest_videos`].
fn oldest_audio(
    conn: &Connection,
    s: &Settings,
    older_than_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<AudioRow>> {
    let unsent_before = unsent_cutoff(s, older_than_ms);
    let mut stmt = conn.prepare(
        "SELECT id, path, end_ms, size_bytes FROM audio
         WHERE status = 0 AND (?1 IS NULL OR end_ms < ?1)
           AND (?3 IS NULL OR uploaded_at IS NOT NULL OR local_only = 1 OR end_ms < ?3)
         ORDER BY start_ms LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![older_than_ms, limit, unsent_before], |r| {
        Ok(AudioRow {
            id: r.get(0)?,
            path: r.get(1)?,
            end_ms: r.get(2)?,
            size: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn video_end(conn: &Connection, id: i64) -> i64 {
    conn.query_row(
        "SELECT COALESCE(end_timestamp, start_timestamp, 0) FROM video WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn delete_video(conn: &Connection, paths: &MemoryPaths, id: i64, path: &str) -> Result<()> {
    let _ = std::fs::remove_file(paths.videos_dir().join(path));
    // An uploaded chunk stays playable from the cloud.
    conn.execute(
        "UPDATE video SET status = CASE WHEN remote_key IS NOT NULL THEN ?1 ELSE ?2 END,
                          size_bytes = CASE WHEN remote_key IS NOT NULL THEN size_bytes ELSE 0 END
         WHERE id = ?3",
        params![STATUS_REMOTE, STATUS_DELETED, id],
    )?;
    Ok(())
}

fn downscale_video(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
    v: &VideoRow,
) -> Result<i64> {
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

fn enforce_cap(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
) -> Result<()> {
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
            let batch = oldest_videos(conn, s, STATUS_FULL, None, 20)?;
            if batch.is_empty() {
                break;
            }
            for v in &batch {
                match downscale_video(conn, paths, engine, s, v) {
                    Ok(saved) => over -= saved,
                    Err(err) => {
                        tracing::warn!(
                            "downscale video {} failed: {err:#}; deleting instead",
                            v.id
                        );
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
    // Delete the oldest media, video or audio, until the library fits.
    while over > 0 {
        let videos = oldest_videos(conn, s, STATUS_DOWNSCALED, None, 200)?;
        let audio = oldest_audio(conn, s, None, 200)?;
        if videos.is_empty() && audio.is_empty() {
            break;
        }
        let (mut vi, mut ai) = (videos.iter().peekable(), audio.iter().peekable());
        while over > 0 {
            let take_video = match (vi.peek(), ai.peek()) {
                (Some(v), Some(a)) => video_end(conn, v.id) <= a.end_ms,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };
            if take_video {
                let v = vi.next().expect("peeked");
                delete_video(conn, paths, v.id, &v.path)?;
                over -= v.size;
            } else {
                let a = ai.next().expect("peeked");
                super::audio::delete_local(conn, paths, a.id, &a.path)?;
                over -= a.size;
            }
        }
    }
    Ok(())
}

fn enforce_retention(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
) -> Result<()> {
    let cutoff = now_ms() - s.storage.retention_days as i64 * 86_400_000;
    // Audio cannot be shrunk: past the retention period it goes, whatever the action.
    loop {
        let batch = oldest_audio(conn, s, Some(cutoff), 200)?;
        if batch.is_empty() {
            break;
        }
        for a in batch {
            super::audio::delete_local(conn, paths, a.id, &a.path)?;
        }
    }
    if s.storage.retention_action == "downscale" {
        loop {
            let batch = oldest_videos(conn, s, STATUS_FULL, Some(cutoff), 20)?;
            if batch.is_empty() {
                break;
            }
            for v in &batch {
                if let Err(err) = downscale_video(conn, paths, engine, s, v) {
                    tracing::warn!("downscale video {} failed: {err:#}", v.id);
                    conn.execute(
                        "UPDATE video SET status = ?1 WHERE id = ?2",
                        params![STATUS_DOWNSCALED, v.id],
                    )?;
                }
            }
        }
    } else {
        loop {
            let batch = oldest_videos(conn, s, STATUS_DOWNSCALED, Some(cutoff), 200)?;
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
    fn age_retention_never_deletes_what_is_not_uploaded_yet() {
        let dir = std::env::temp_dir().join(format!("kmem-ret-unsent-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        let conn = store::open(&paths).unwrap();
        // Two old chunks: one uploaded, one not; one local-only (made before a destination switch).
        for (name, uploaded, local) in [("sent", 1, 0), ("unsent", 0, 0), ("local", 0, 1)] {
            std::fs::write(paths.videos_dir().join(name), b"x").unwrap();
            conn.execute(
                "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp, uploaded_at, local_only)
                 VALUES (10, 10, ?1, 1, 1, 1000, 2000, CASE WHEN ?2 = 1 THEN 5 END, ?3)",
                rusqlite::params![name, uploaded, local],
            )
            .unwrap();
        }
        let mut s = Settings::default();
        s.sync.enabled = true;
        let old = Some(now_ms());
        let names: Vec<String> = oldest_videos(&conn, &s, STATUS_FULL, old, 10)
            .unwrap()
            .into_iter()
            .map(|v| v.path)
            .collect();
        assert_eq!(names, vec!["sent", "local"], "the unsent chunk stays");
        s.sync.enabled = false;
        assert_eq!(oldest_videos(&conn, &s, STATUS_FULL, old, 10).unwrap().len(), 3, "sync off: all may go");
        let _ = std::fs::remove_dir_all(dir);
    }

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
            .query_row(
                "SELECT v.status, f.foreground FROM frame f JOIN video v ON v.id = f.video",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, STATUS_DELETED);
        assert_eq!(text, "kept text");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn storage_cap_removes_the_oldest_media_audio_or_video_and_keeps_transcripts() {
        let dir = std::env::temp_dir().join(format!("kmem-ret-audio-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        let conn = store::open(&paths).unwrap();
        std::fs::create_dir_all(paths.audio_dir()).unwrap();
        // Oldest first: audio (t=1000), video (t=2000), audio (t=3000). 400 KB each.
        let blob = vec![0u8; 400_000];
        std::fs::write(paths.audio_dir().join("1000.m4a"), &blob).unwrap();
        std::fs::write(paths.videos_dir().join("v.mp4"), &blob).unwrap();
        std::fs::write(paths.audio_dir().join("3000.m4a"), &blob).unwrap();
        conn.execute("INSERT INTO audio(start_ms, end_ms, path, size_bytes) VALUES (1000, 1500, '1000.m4a', 400000)", []).unwrap();
        conn.execute("INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (1, 1, 'v.mp4', 1, 400000, 2000, 2500)", []).unwrap();
        conn.execute("INSERT INTO audio(start_ms, end_ms, path, size_bytes) VALUES (3000, 3500, '3000.m4a', 400000)", []).unwrap();
        conn.execute("INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (1, 1000, 1500, 'kept words')", []).unwrap();
        let used = usage(&paths);
        assert_eq!(
            used.audio_bytes, 800_000,
            "audio counts toward storage usage"
        );
        // A cap that forces about two files out.
        let mut s = Settings::default();
        s.storage.management_mode = "storage_cap".into();
        s.storage.limit_gb = (used.total() as f64 - 700_000.0) / 1e9;
        let mut engine = crate::memory::engine::Engine::without_process_for_test();
        enforce(&conn, &paths, &mut engine, &s).unwrap();
        let status = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            status("SELECT status FROM audio WHERE id = 1"),
            STATUS_DELETED,
            "oldest (audio) goes first"
        );
        assert_eq!(
            status("SELECT status FROM video WHERE id = 1"),
            STATUS_DELETED,
            "then the video"
        );
        assert_eq!(
            status("SELECT status FROM audio WHERE id = 2"),
            0,
            "the newest audio stays"
        );
        assert!(!paths.audio_dir().join("1000.m4a").exists());
        assert_eq!(
            status("SELECT count(*) FROM audio_fts WHERE audio_fts MATCH 'kept'"),
            1,
            "the transcript stays searchable"
        );
        // Retention mode removes audio past the window whatever the action.
        conn.execute("UPDATE audio SET end_ms = 1 WHERE id = 2", [])
            .unwrap();
        s.storage.management_mode = "retention".into();
        s.storage.retention_action = "downscale".into();
        enforce(&conn, &paths, &mut engine, &s).unwrap();
        assert_eq!(
            status("SELECT status FROM audio WHERE id = 2"),
            STATUS_DELETED
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keep_seven_days_still_holds_the_size_cap() {
        let dir = std::env::temp_dir().join(format!("kmem-ret-cap-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        let conn = store::open(&paths).unwrap();
        std::fs::create_dir_all(paths.audio_dir()).unwrap();
        // Two recent audio segments, well inside 7 days; the cap has room for one.
        let now = now_ms();
        for (i, t) in [now - 2_000, now - 1_000].iter().enumerate() {
            std::fs::write(paths.audio_dir().join(format!("{i}.m4a")), vec![0u8; 400_000]).unwrap();
            conn.execute(
                "INSERT INTO audio(start_ms, end_ms, path, size_bytes) VALUES (?1, ?2, ?3, 400000)",
                rusqlite::params![t, t + 500, format!("{i}.m4a")],
            )
            .unwrap();
        }
        let mut s = Settings::default();
        assert_eq!(s.storage.management_mode, "retention");
        s.storage.limit_gb = (usage(&paths).total() as f64 - 300_000.0) / 1e9;
        let mut engine = crate::memory::engine::Engine::without_process_for_test();
        enforce(&conn, &paths, &mut engine, &s).unwrap();
        let st = |id: i64| -> i64 {
            conn.query_row("SELECT status FROM audio WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!((st(1), st(2)), (STATUS_DELETED, 0), "the oldest goes to fit the cap");
        let _ = std::fs::remove_dir_all(dir);
    }

}
