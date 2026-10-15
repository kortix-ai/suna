//! Action segments in the library: the action recorder's processed segments
//! (clicks, drags, scrolls, key presses, typed text, with screenshots) as
//! items of the Kortix Capture format, kind `actions`.
//!
//! When a segment of the action recorder ends, [`ingest`] turns its
//! `<name>_preprocessed.jsonl` into `actions/<start_ms>-x<id>.actions.jsonl.zst`
//! (one line per processed event, see [`line`]) and moves every screenshot into
//! `actions/assets/sha256-<hex>.<ext>`, stored once however many events show it.
//! The `action_segment` row carries the sync columns `video` and `audio` have,
//! so the sync engine uploads, offloads, retains, forgets and restores actions
//! like screen chunks and audio segments.
//!
//! App and window come from the screen memory frame closest before the event
//! (when screen memory recorded one within 5 s), else the window title from the
//! segment's accessibility snapshots. `target` is the accessibility element
//! under a click or drag when a snapshot covers it.

use super::{
    paths::MemoryPaths,
    retention::STATUS_REMOTE,
    store::{self, now_ms},
};
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

/// Kinds of processed events that become lines (the recorder's raw input
/// events never do).
const KINDS: &[&str] = &[
    "click",
    "drag",
    "scroll",
    "press",
    "hotkey",
    "typewrite",
    "sleep",
    "screenshot",
];
/// A screen memory frame names the app of an event when it is this close before it.
const FRAME_WINDOW_MS: i64 = 5_000;

pub fn dir(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("actions")
}

pub fn assets_dir(paths: &MemoryPaths) -> PathBuf {
    dir(paths).join("assets")
}

/// `<start_ms>-x<id>.actions.jsonl.zst`, the local and the remote file name.
pub fn file_name(start_ms: i64, id: i64) -> String {
    format!("{start_ms}-x{id}.actions.jsonl.zst")
}

/// `sha256-<hex>.<ext>` of `bytes`.
pub fn asset_name(bytes: &[u8], ext: &str) -> String {
    format!("sha256-{:x}.{ext}", Sha256::digest(bytes))
}

/// The hex digest an asset name promises, when it is a content-addressed name
/// (`sha256-<hex>.<ext>`, or schema 1's `<hex>.<ext>`).
pub fn asset_digest(name: &str) -> Option<&str> {
    if name.contains('/') || name.contains("..") {
        return None;
    }
    let stem = name.split('.').next()?;
    let hex = stem.strip_prefix("sha256-").unwrap_or(stem);
    (hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
}

fn image_ext(bytes: &[u8], declared: Option<&str>) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "jpg"
    } else {
        match declared.map(str::to_ascii_lowercase).as_deref() {
            Some("png") => "png",
            Some("webp") => "webp",
            _ => "jpg",
        }
    }
}

fn decode_image(image: &str) -> Option<Vec<u8>> {
    let t = image.trim();
    let payload = t
        .split_once(',')
        .filter(|(p, _)| p.starts_with("data:"))
        .map(|(_, b)| b)
        .unwrap_or(t);
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()
        .filter(|b| !b.is_empty())
}

/// Store an image in `actions/assets/` (once per content) and return its name.
fn store_asset(paths: &MemoryPaths, image: &str, declared: Option<&str>) -> Result<Option<String>> {
    let Some(bytes) = decode_image(image) else {
        return Ok(None);
    };
    let name = asset_name(&bytes, image_ext(&bytes, declared));
    let file = assets_dir(paths).join(&name);
    if !file.exists() {
        std::fs::create_dir_all(assets_dir(paths))?;
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &file)?;
    }
    Ok(Some(name))
}

/// Accessibility snapshots of a segment: (absolute ms, focused window tree).
fn a11y_snapshots(path: &Path, start_ms: i64) -> Vec<(i64, Value)> {
    let Ok(f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, Value)> = BufReader::new(f)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .filter_map(|v| {
            let ts = v.get("timestamp")?.as_f64()?;
            let tree = v.pointer("/data/a11y/windows_data/0")?.clone();
            Some((start_ms + (ts * 1000.0) as i64, tree))
        })
        .collect();
    out.sort_by_key(|(t, _)| *t);
    out
}

/// The smallest element whose bbox `[x0, y0, x1, y1]` contains the point.
fn element_at(node: &Value, x: f64, y: f64) -> Option<&Value> {
    let inside = node
        .get("bbox")
        .and_then(Value::as_array)
        .filter(|b| b.len() == 4)
        .and_then(|b| {
            let v: Vec<f64> = b.iter().filter_map(Value::as_f64).collect();
            (v.len() == 4).then(|| x >= v[0] && x <= v[2] && y >= v[1] && y <= v[3])
        })
        .unwrap_or(false);
    let child = node
        .get("children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|c| element_at(c, x, y));
    child.or(inside.then_some(node))
}

/// App and window of the screen memory frame closest before `ts_ms`.
fn frame_context(conn: &Connection, ts_ms: i64) -> Option<(Value, Option<String>)> {
    conn.query_row(
        "SELECT a.bundle_id, a.display_name, f.title, f.pii_redacted FROM frame f
         LEFT JOIN segment s ON s.id = f.segment LEFT JOIN application a ON a.id = s.application
         WHERE f.timestamp BETWEEN ?1 AND ?2 ORDER BY f.timestamp DESC LIMIT 1",
        params![ts_ms - FRAME_WINDOW_MS, ts_ms],
        |r| {
            let redacted = r.get::<_, i64>(3)? != 0;
            Ok((
                json!({"bundle_id": r.get::<_, Option<String>>(0)?,
                       "name": if redacted { Some("[redacted]".to_string()) } else { r.get::<_, Option<String>>(1)? }}),
                r.get::<_, Option<String>>(2)?,
            ))
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Context the lines of one segment share.
struct SegmentCtx<'a> {
    paths: &'a MemoryPaths,
    conn: &'a Connection,
    start_ms: i64,
    a11y: Vec<(i64, Value)>,
    screen: Option<(f64, f64)>,
    shots: BTreeSet<String>,
}

/// One line of the actions object, from one processed event, or None for an
/// event that is not an action (raw input). Images move to assets: `args.image`
/// becomes `screenshot`, each `args.displays[].image` its display's `screenshot`.
fn line(ctx: &mut SegmentCtx, event: &Value) -> Result<Option<Value>> {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    if !KINDS.contains(&kind) {
        return Ok(None);
    }
    let ts = event
        .get("timestamp")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let ts_ms = ctx.start_ms + (ts * 1000.0) as i64;
    let start_ms = event
        .get("start_timestamp")
        .and_then(Value::as_f64)
        .map(|s| ctx.start_ms + (s * 1000.0) as i64)
        .unwrap_or(ts_ms);
    let mut args: Map<String, Value> = event
        .get("args")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let declared = args
        .get("encoding")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut screenshot = None;
    if let Some(image) = args
        .remove("image")
        .and_then(|v| v.as_str().map(str::to_string))
    {
        screenshot = store_asset(ctx.paths, &image, declared.as_deref())?;
    }
    let mut displays = Vec::new();
    if let Some(list) = args.remove("displays").and_then(|v| v.as_array().cloned()) {
        for mut d in list {
            if let Some(obj) = d.as_object_mut() {
                let shot = match obj
                    .remove("image")
                    .and_then(|v| v.as_str().map(str::to_string))
                {
                    Some(image) => store_asset(ctx.paths, &image, declared.as_deref())?,
                    None => None,
                };
                if let Some(s) = &shot {
                    ctx.shots.insert(s.clone());
                }
                obj.insert("screenshot".into(), json!(shot));
            }
            displays.push(d);
        }
    }
    if let Some(s) = &screenshot {
        ctx.shots.insert(s.clone());
    }
    let snapshot = ctx
        .a11y
        .iter()
        .rev()
        .find(|(t, _)| *t <= ts_ms + 1_000)
        .map(|(_, tree)| tree);
    let (app, mut window) = match frame_context(ctx.conn, ts_ms) {
        Some((app, title)) => (app, title),
        None => (Value::Null, None),
    };
    if window.is_none() {
        window = snapshot
            .and_then(|t| t.get("name"))
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
    }
    let target = match (kind, snapshot, ctx.screen) {
        ("click" | "drag", Some(tree), Some((w, h))) => {
            let (x, y) = (
                args.get("x").and_then(Value::as_f64),
                args.get("y").and_then(Value::as_f64),
            );
            match (x, y) {
                // Processed coordinates are a fraction of the display.
                (Some(x), Some(y)) if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) => {
                    element_at(tree, x * w, y * h).map(|e| {
                        json!({"role": e.get("friendly_class_name").or_else(|| e.get("class_name")),
                               "name": e.get("name"), "bbox": e.get("bbox")})
                    })
                }
                _ => None,
            }
        }
        _ => None,
    };
    let mut out = json!({
        "ts_ms": ts_ms,
        "start_ms": start_ms,
        "kind": kind,
        "command": event.get("command").and_then(Value::as_str).unwrap_or(""),
        "args": args,
        "app": app,
        "window": window,
        "target": target,
        "screenshot": screenshot,
    });
    if !displays.is_empty() {
        out["displays"] = Value::Array(displays);
    }
    Ok(Some(out))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Ingested {
    pub id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub event_count: i64,
    pub screenshots: Vec<String>,
    pub size_bytes: u64,
}

fn rfc3339_ms(v: Option<&Value>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v?.as_str()?)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Add one finished action-recorder segment (`<recording_dir>/<name>_*`) to
/// the library. Idempotent by `name`: a segment ingested before returns None.
/// A segment without a processed file, or without any action, adds nothing.
pub fn ingest(paths: &MemoryPaths, recording_dir: &Path, name: &str) -> Result<Option<Ingested>> {
    let conn = store::open(paths)?;
    if conn
        .query_row(
            "SELECT 1 FROM action_segment WHERE source = ?1",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(None);
    }
    let processed = recording_dir.join(format!("{name}_preprocessed.jsonl"));
    if !processed.is_file() {
        return Ok(None);
    }
    let meta: Value = std::fs::read(recording_dir.join(format!("{name}_metadata.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let Some(start_ms) = rfc3339_ms(meta.get("start_time")) else {
        bail!("segment {name} has no start_time in its metadata");
    };
    let a11y = a11y_snapshots(&recording_dir.join(format!("{name}_a11y.jsonl")), start_ms);
    let mut ctx = SegmentCtx {
        paths,
        conn: &conn,
        start_ms,
        screen: None,
        a11y,
        shots: BTreeSet::new(),
    };
    // Accessibility boxes are in screen points; the snapshot metadata names the screen size.
    ctx.screen = std::fs::read_to_string(recording_dir.join(format!("{name}_a11y.jsonl")))
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                let v: Value = serde_json::from_str(l).ok()?;
                let m = v.pointer("/data/a11y/metadata")?;
                Some((
                    m.get("screen_width")?.as_f64()?,
                    m.get("screen_height")?.as_f64()?,
                ))
            })
        });
    let mut plain = Vec::new();
    let mut count = 0i64;
    let mut last_ms = start_ms;
    for l in BufReader::new(std::fs::File::open(&processed)?).lines() {
        let l = l?;
        let Ok(event) = serde_json::from_str::<Value>(&l) else {
            continue;
        };
        if let Some(out) = line(&mut ctx, &event)? {
            last_ms = last_ms.max(out["ts_ms"].as_i64().unwrap_or(start_ms));
            serde_json::to_writer(&mut plain, &out)?;
            plain.push(b'\n');
            count += 1;
        }
    }
    if count == 0 {
        return Ok(None);
    }
    let end_ms = rfc3339_ms(meta.get("end_time"))
        .unwrap_or(last_ms)
        .max(last_ms);
    let shots: Vec<String> = ctx.shots.into_iter().collect();
    let body = zstd::encode_all(plain.as_slice(), 9)?;
    let private = super::privacy::ActionPrivacyGate::new(paths).blocked();
    std::fs::create_dir_all(dir(paths))?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO action_segment(start_ms, end_ms, path, size_bytes, event_count, screenshots, source, pii_redacted)
         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7)",
        params![start_ms, end_ms, body.len() as i64, count, serde_json::to_string(&shots)?, name, private as i64],
    )?;
    let id = tx.last_insert_rowid();
    let file = file_name(start_ms, id);
    let tmp = dir(paths).join(format!("{file}.tmp"));
    std::fs::File::create(&tmp)?.write_all(&body)?;
    std::fs::rename(&tmp, dir(paths).join(&file))?;
    tx.execute(
        "UPDATE action_segment SET path = ?1 WHERE id = ?2",
        params![file, id],
    )?;
    tx.commit()?;
    Ok(Some(Ingested {
        id,
        start_ms,
        end_ms,
        event_count: count,
        screenshots: shots,
        size_bytes: body.len() as u64,
    }))
}

/// Asset names an `action_segment` row references.
pub fn screenshots_of(json_list: &str) -> Vec<String> {
    serde_json::from_str(json_list).unwrap_or_default()
}

/// Remove local assets no segment with a local file references any more.
pub fn gc_assets(conn: &Connection, paths: &MemoryPaths) -> Result<usize> {
    let mut keep = HashSet::new();
    for list in conn
        .prepare("SELECT screenshots FROM action_segment WHERE status != ?1")?
        .query_map([STATUS_REMOTE], |r| r.get::<_, String>(0))?
    {
        keep.extend(screenshots_of(&list?));
    }
    let mut removed = 0;
    if let Ok(rd) = std::fs::read_dir(assets_dir(paths)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !keep.contains(&name) && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Bytes the local action store holds (segment files and assets).
pub fn local_bytes(paths: &MemoryPaths) -> u64 {
    let size = |d: PathBuf| -> u64 {
        std::fs::read_dir(d)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.metadata().ok())
                    .filter(|m| m.is_file())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0)
    };
    size(dir(paths)) + size(assets_dir(paths))
}

/// Keep the local action store under `cap_bytes`, oldest segments first. An
/// uploaded segment keeps its row (remote only). One that never uploaded goes
/// whole, unless sync is on and it is younger than 7 days (it waits for its
/// upload). Returns the segments freed.
pub fn enforce_cap(paths: &MemoryPaths, cap_bytes: u64, sync_on: bool) -> Result<usize> {
    let mut total = local_bytes(paths);
    if total <= cap_bytes {
        return Ok(0);
    }
    let conn = store::open(paths)?;
    let rows: Vec<(i64, String, i64, bool)> = conn
        .prepare(
            "SELECT id, path, start_ms, remote_key IS NOT NULL AND uploaded_at IS NOT NULL
             FROM action_segment WHERE status != ?1 ORDER BY start_ms",
        )?
        .query_map([STATUS_REMOTE], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let week_ago = now_ms() - 7 * 86_400_000;
    let mut freed = 0;
    for (id, path, start, uploaded) in rows {
        if total <= cap_bytes {
            break;
        }
        if !uploaded && sync_on && start > week_ago {
            continue;
        }
        let _ = std::fs::remove_file(dir(paths).join(&path));
        if uploaded {
            conn.execute(
                "UPDATE action_segment SET status = ?1 WHERE id = ?2",
                params![STATUS_REMOTE, id],
            )?;
        } else {
            conn.execute("DELETE FROM action_segment WHERE id = ?1", [id])?;
        }
        freed += 1;
        gc_assets(&conn, paths)?;
        total = local_bytes(paths);
    }
    Ok(freed)
}

/// `<library>/actions.json`: the action recorder's heartbeat, written by the
/// service every tick (30 s) while it runs, so the recorder's sync thread can
/// report it in status.json.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(default)]
pub struct Heartbeat {
    pub recording: bool,
    /// Why it is not recording when the person wanted it: `policy_off`, `policy_paused`.
    pub blocked: Option<String>,
    pub updated_at_ms: i64,
}

pub fn heartbeat_path(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("actions.json")
}

pub fn write_heartbeat(paths: &MemoryPaths, recording: bool, blocked: Option<&str>) {
    let hb = Heartbeat {
        recording,
        blocked: blocked.map(str::to_string),
        updated_at_ms: now_ms(),
    };
    let tmp = heartbeat_path(paths).with_extension("json.tmp");
    if std::fs::create_dir_all(&paths.root).is_ok()
        && serde_json::to_vec(&hb)
            .ok()
            .and_then(|b| std::fs::write(&tmp, b).ok())
            .is_some()
    {
        let _ = std::fs::rename(tmp, heartbeat_path(paths));
    }
}

/// The action recorder is recording now (a heartbeat younger than 90 s, three
/// service ticks, says so).
pub fn read_heartbeat(paths: &MemoryPaths) -> Option<Heartbeat> {
    let hb: Heartbeat = serde_json::from_slice(&std::fs::read(heartbeat_path(paths)).ok()?).ok()?;
    (now_ms() - hb.updated_at_ms < 90_000).then_some(hb)
}

/// The lines of a segment's local file.
pub fn read_lines(paths: &MemoryPaths, path: &str) -> Result<Vec<Value>> {
    let bytes = std::fs::read(dir(paths).join(path)).with_context(|| format!("read {path}"))?;
    let plain = zstd::decode_all(bytes.as_slice())?;
    plain
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| Ok(serde_json::from_slice(l)?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(seed: u8) -> String {
        base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff, seed, 1, 2, 3])
    }

    fn segment(root: &Path, name: &str, lines: &[Value]) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(dir.join(format!("{name}_preprocessed.jsonl")), text).unwrap();
        std::fs::write(
            dir.join(format!("{name}_metadata.json")),
            json!({"start_time": "2026-10-01T09:00:00Z", "end_time": "2026-10-01T09:01:00Z"})
                .to_string(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn the_heartbeat_reads_back_until_it_is_three_ticks_old() {
        let root =
            std::env::temp_dir().join(format!("kcap-actions-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(root.join("lib"));
        assert_eq!(read_heartbeat(&paths), None);
        write_heartbeat(&paths, true, None);
        assert!(read_heartbeat(&paths).is_some_and(|h| h.recording));
        // One service tick (30 s) later it still counts; past 90 s it does not.
        let aged = |ms: i64| {
            let hb = Heartbeat {
                recording: true,
                blocked: None,
                updated_at_ms: now_ms() - ms,
            };
            std::fs::write(heartbeat_path(&paths), serde_json::to_vec(&hb).unwrap()).unwrap();
            read_heartbeat(&paths).is_some()
        };
        assert!(aged(31_000));
        assert!(!aged(91_000));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ingest_writes_lines_and_stores_each_screenshot_once() {
        let root =
            std::env::temp_dir().join(format!("kcap-actions-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(root.join("lib"));
        let shot = jpeg(1);
        let dir = segment(
            &root,
            "seg_a",
            &[
                json!({"type": "screenshot", "timestamp": 0.5, "command": "", "args": {"image": shot, "width": 4, "height": 4}}),
                json!({"type": "click", "timestamp": 1.25, "start_timestamp": 1.0, "command": "click(x=0.5000, y=0.5000)",
                       "args": {"x": 0.5, "y": 0.5, "button": "left", "clicks": 1}}),
                json!({"type": "key_down", "timestamp": 1.3, "data": {"key": "a"}}),
                json!({"type": "screenshot", "timestamp": 1.5, "command": "", "args": {"image": shot, "displays": [{"display_id": 1, "image": jpeg(2)}]}}),
            ],
        );
        let got = ingest(&paths, &dir, "seg_a").unwrap().unwrap();
        assert_eq!(got.event_count, 3, "the raw key_down is not an action");
        assert_eq!(
            got.screenshots.len(),
            2,
            "the repeated screenshot is stored once"
        );
        assert!(got
            .screenshots
            .iter()
            .all(|s| s.starts_with("sha256-") && s.ends_with(".jpg")));
        let start = chrono::DateTime::parse_from_rfc3339("2026-10-01T09:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!((got.start_ms, got.end_ms), (start, start + 60_000));
        let lines = read_lines(&paths, &file_name(start, got.id)).unwrap();
        assert_eq!(lines[1]["kind"], "click");
        assert_eq!(lines[1]["ts_ms"], start + 1250);
        assert_eq!(lines[1]["start_ms"], start + 1000);
        assert!(lines[1]["screenshot"].is_null());
        assert_eq!(lines[0]["screenshot"], lines[2]["screenshot"]);
        assert!(
            lines[2]["args"].get("displays").is_none()
                && lines[2]["displays"][0]["screenshot"].is_string()
        );
        assert!(
            !lines.iter().any(|l| l.to_string().contains(&shot)),
            "no base64 image survives"
        );
        for name in &got.screenshots {
            let bytes = std::fs::read(assets_dir(&paths).join(name)).unwrap();
            assert_eq!(
                asset_digest(name),
                Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
            );
        }
        assert!(
            ingest(&paths, &dir, "seg_a").unwrap().is_none(),
            "ingest is idempotent"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_cap_frees_uploaded_segments_and_waits_for_unsent_ones() {
        let root =
            std::env::temp_dir().join(format!("kcap-actions-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(root.join("lib"));
        for n in ["s1", "s2"] {
            let dir = segment(
                &root,
                n,
                &[
                    json!({"type": "screenshot", "timestamp": 0.5, "command": "", "args": {"image": jpeg(n.as_bytes()[1])}}),
                ],
            );
            ingest(&paths, &dir, n).unwrap().unwrap();
        }
        let conn = store::open(&paths).unwrap();
        conn.execute("UPDATE action_segment SET start_ms = ?1", [now_ms()])
            .unwrap();
        conn.execute(
            "UPDATE action_segment SET uploaded_at = 1, remote_key = 'k' WHERE source = 's1'",
            [],
        )
        .unwrap();
        assert_eq!(
            enforce_cap(&paths, 0, true).unwrap(),
            1,
            "only the uploaded one goes"
        );
        let s1: i64 = conn
            .query_row(
                "SELECT status FROM action_segment WHERE source = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(s1, STATUS_REMOTE);
        assert_eq!(std::fs::read_dir(assets_dir(&paths)).unwrap().count(), 1);
        assert_eq!(
            enforce_cap(&paths, 0, false).unwrap(),
            1,
            "sync off: the unsent one goes too"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM action_segment", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn asset_names_are_content_addresses() {
        let n = asset_name(b"x", "jpg");
        assert!(n.starts_with("sha256-") && n.ends_with(".jpg"));
        assert!(asset_digest(&n).is_some());
        assert!(
            asset_digest(&format!("{}.png", "a".repeat(64))).is_some(),
            "schema 1 icon names"
        );
        assert_eq!(asset_digest("../x.jpg"), None);
        assert_eq!(asset_digest("sha256-zz.jpg"), None);
    }
}
