//! Frame image access shared by the CLI and the OCR worker.

use super::engine::Engine;
use super::paths::MemoryPaths;
use super::retention::STATUS_DELETED;
use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum FrameImage {
    /// Staged still (not yet encoded).
    Still(PathBuf),
    /// Frame `index` of a 1 fps HEVC chunk.
    Video { path: PathBuf, index: i64, downscaled: bool },
    /// Screenshot removed by retention; text is still available.
    Removed,
    Missing,
}

pub fn locate(conn: &Connection, paths: &MemoryPaths, frame_id: i64) -> Result<FrameImage> {
    let row: Option<(Option<String>, Option<i64>, Option<String>, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT f.image_path, f.video_index, v.path, v.status, f.video
             FROM frame f LEFT JOIN video v ON v.id = f.video WHERE f.id = ?1",
            [frame_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((still, index, video, status, video_id)) = row else { bail!("frame {frame_id} not found") };
    if let (Some(v), Some(i)) = (video, index) {
        if status == Some(STATUS_DELETED) {
            return Ok(FrameImage::Removed);
        }
        let path = paths.videos_dir().join(v);
        return Ok(if path.exists() {
            FrameImage::Video { path, index: i, downscaled: status == Some(1) }
        } else {
            FrameImage::Missing
        });
    }
    if video_id.is_some() {
        return Ok(FrameImage::Missing);
    }
    if let Some(s) = still {
        let p = paths.abs(&s);
        if p.exists() {
            return Ok(FrameImage::Still(p));
        }
    }
    Ok(FrameImage::Missing)
}

/// Write the frame image to `out` (PNG or JPEG by extension), optionally cropped
/// to a rect in image pixels.
pub fn export(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    frame_id: i64,
    out: &std::path::Path,
    crop: Option<(i64, i64, i64, i64)>,
) -> Result<PathBuf> {
    let crop_json = crop.map(|(x, y, w, h)| json!({"x": x, "y": y, "w": w, "h": h}));
    let req = match locate(conn, paths, frame_id)? {
        FrameImage::Still(p) => json!({"cmd": "convert", "path": p.to_string_lossy(), "out": out.to_string_lossy(), "crop": crop_json}),
        FrameImage::Video { path, index, .. } => json!({
            "cmd": "extract", "video": path.to_string_lossy(), "index": index,
            "out": out.to_string_lossy(), "crop": crop_json
        }),
        FrameImage::Removed => bail!("frame {frame_id}: screenshot was removed to save storage (text is still searchable)"),
        FrameImage::Missing => bail!("frame {frame_id}: screenshot not available"),
    };
    engine.request(req, Duration::from_secs(30)).with_context(|| format!("export frame {frame_id}"))?;
    Ok(out.to_path_buf())
}

/// Focused-window rect of a frame in image pixels (for `--crop`).
pub fn focused_crop(conn: &Connection, frame_id: i64) -> Result<Option<(i64, i64, i64, i64)>> {
    let row: Option<(i64, i64, i64, i64, f64, f64, f64, f64, i64, i64)> = conn
        .query_row(
            "SELECT w.x, w.y, w.width, w.height, f.capture_display_x, f.capture_display_y,
                    f.capture_display_width, f.capture_display_height, f.width, f.height
             FROM window_bound w JOIN frame f ON f.id = w.frame
             WHERE w.frame = ?1 AND w.is_focussed_window = 1 LIMIT 1",
            [frame_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                    r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    r.get::<_, Option<i64>>(9)?.unwrap_or(0),
                ))
            },
        )
        .optional()?;
    Ok(row.and_then(|(x, y, w, h, dx, dy, dw, dh, iw, ih)| {
        if dw <= 0.0 || dh <= 0.0 {
            return None;
        }
        let (sx, sy) = (iw as f64 / dw, ih as f64 / dh);
        Some((((x as f64 - dx) * sx) as i64, ((y as f64 - dy) * sy) as i64, (w as f64 * sx) as i64, (h as f64 * sy) as i64))
    }))
}
