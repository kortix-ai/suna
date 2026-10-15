//! Rebuild a library from the bucket (`kortix-capture sync restore`) and list
//! the devices under the prefix (`kortix-capture sync devices`).
//!
//! Restore reads a device's daily index (`index/<day>.jsonl`), or, for a
//! device that has none, lists its sidecars. Per chunk it reads the manifest
//! and the frames sidecar, checks the sidecar's SHA-256 against the manifest,
//! and inserts frames, OCR text and boxes, windows, AX trees, apps, domains
//! and icons. Videos stay in the bucket: the rows are `STATUS_REMOTE` and
//! stream on demand like any uploaded chunk. Audio segments (index lines with
//! `kind: "audio"`) come back the same way: their row and transcript from the
//! manifest, the audio itself streams on demand. Action segments (`kind:
//! "actions"`) come back whole into the local store: the actions file and every
//! screenshot, each checked against its SHA-256. An item already in the library
//! is skipped, so restore can run again to resume or catch up. A manifest with a
//! schema newer than this app is refused.

use super::{open_blob, target, UploadTarget, MS_PER_DAY, SCHEMA, STATUS_REMOTE};
use crate::memory::recorder::SEGMENT_GAP_MS;
use crate::memory::{
    paths::MemoryPaths,
    store::{self, now_ms},
};
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub device_id: String,
    pub hostname: Option<String>,
    pub computer_name: Option<String>,
    pub os: Option<String>,
    pub app_version: Option<String>,
    pub encryption_key_id: Option<String>,
    pub first_chunk_ms: Option<i64>,
    pub last_chunk_ms: Option<i64>,
    pub updated_at: Option<String>,
}

/// Every device folder under the prefix, described by its `device.json`.
pub fn devices(t: &dyn UploadTarget) -> Result<Vec<Device>> {
    let root = t.key("");
    let (_, prefixes) = t.list(&root, Some("/"))?;
    let mut out = Vec::new();
    for p in prefixes {
        let id = p
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let info: Value = t
            .get_bytes(&t.key(&format!("{id}/device.json")))?
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let s = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_string);
        out.push(Device {
            device_id: id,
            hostname: s("hostname"),
            computer_name: s("computer_name"),
            os: s("os"),
            app_version: s("app_version"),
            encryption_key_id: info
                .pointer("/encryption/key_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            first_chunk_ms: info.get("first_chunk_ms").and_then(Value::as_i64),
            last_chunk_ms: info.get("last_chunk_ms").and_then(Value::as_i64),
            // Schema 2 writes epoch ms; schema 1 wrote RFC 3339.
            updated_at: s("updated_at").or_else(|| {
                info.get("updated_at_ms")
                    .and_then(Value::as_i64)
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|t| t.to_rfc3339())
            }),
        });
    }
    Ok(out)
}

/// One chunk in the bucket.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// `<device>/<YYYY>/<MM>/<DD>/<start_ms>-<video_id>`, relative to the prefix.
    pub base: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub manifest: bool,
    /// "chunk" (video + frames) or "audio".
    pub kind: String,
}

/// Fold index lines (`put` and `delete`) into the live chunks, by start time.
pub fn fold_index(text: &str) -> Vec<Entry> {
    let mut live: BTreeMap<String, Entry> = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(base) = v.get("base").and_then(Value::as_str) else {
            continue;
        };
        match v.get("op").and_then(Value::as_str) {
            Some("put") => {
                let start = v.get("start_ms").and_then(Value::as_i64).unwrap_or(0);
                live.insert(
                    base.to_string(),
                    Entry {
                        base: base.to_string(),
                        start_ms: start,
                        end_ms: v.get("end_ms").and_then(Value::as_i64).unwrap_or(start),
                        manifest: v.get("manifest").and_then(Value::as_bool).unwrap_or(false),
                        kind: v
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("chunk")
                            .to_string(),
                    },
                );
            }
            Some("delete") => {
                live.remove(base);
            }
            _ => {}
        }
    }
    let mut out: Vec<Entry> = live.into_values().collect();
    out.sort_by_key(|e| e.start_ms);
    out
}

/// `<start_ms>-<video_id>` from a chunk key.
fn parse_chunk_name(base: &str) -> Option<(i64, i64)> {
    let name = base.rsplit('/').next()?;
    let (start, id) = name.split_once('-')?;
    Some((start.parse().ok()?, id.parse().ok()?))
}

/// The device's chunks from its daily index, or from a listing when it has no index.
pub fn entries(
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    device: &str,
    from: Option<i64>,
) -> Result<(Vec<Entry>, &'static str)> {
    let (index, _) = t.list(&t.key(&format!("{device}/index/")), None)?;
    let mut out = if index.is_empty() {
        let (keys, _) = t.list(&t.key(&format!("{device}/")), None)?;
        let names: HashSet<&str> = keys.iter().map(|(k, _)| k.as_str()).collect();
        let mut v: Vec<Entry> = keys
            .iter()
            .filter_map(|(k, _)| k.strip_suffix(".frames.jsonl.zst"))
            .filter_map(|full| {
                let (start, _) = parse_chunk_name(full)?;
                Some(Entry {
                    base: t.rel(full).to_string(),
                    start_ms: start,
                    end_ms: i64::MAX,
                    manifest: names.contains(format!("{full}.manifest.json").as_str()),
                    kind: "chunk".into(),
                })
            })
            .chain(keys.iter().filter_map(|(k, _)| {
                let full = k.strip_suffix(".actions.jsonl.zst")?;
                let start = full.rsplit('/').next()?.split_once("-x")?.0.parse().ok()?;
                names
                    .contains(format!("{full}.manifest.json").as_str())
                    .then(|| Entry {
                        base: t.rel(full).to_string(),
                        start_ms: start,
                        end_ms: i64::MAX,
                        manifest: true,
                        kind: "actions".into(),
                    })
            }))
            .chain(keys.iter().filter_map(|(k, _)| {
                // Audio segments are found by their manifest (it is written last).
                let full = k.strip_suffix(".m4a")?;
                let start = full.rsplit('/').next()?.split_once("-a")?.0.parse().ok()?;
                names
                    .contains(format!("{full}.manifest.json").as_str())
                    .then(|| Entry {
                        base: t.rel(full).to_string(),
                        start_ms: start,
                        end_ms: i64::MAX,
                        manifest: true,
                        kind: "audio".into(),
                    })
            }))
            .collect();
        v.sort_by_key(|e| e.start_ms);
        (v, "listing")
    } else {
        // A chunk's day is its UTC start date; one extra day covers chunks that started before `from`.
        let from_day = from.map(|f| super::utc_day(f - MS_PER_DAY, "%Y-%m-%d"));
        let mut text = String::new();
        let mut days: Vec<&String> = index.iter().map(|(k, _)| k).collect();
        days.sort();
        for key in days {
            let day = key
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .trim_end_matches(".jsonl");
            if from_day.as_deref().is_some_and(|f| day < f) {
                continue;
            }
            if let Some(b) = t.get_bytes(key)? {
                text.push_str(&String::from_utf8_lossy(&open_blob(paths, b)?));
                text.push('\n');
            }
        }
        (fold_index(&text), "index")
    };
    if let Some(f) = from {
        out.0.retain(|e| e.end_ms >= f);
    }
    Ok(out)
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub device_id: String,
    /// "index" or "listing".
    pub source: String,
    pub chunks_listed: usize,
    pub chunks_restored: usize,
    pub chunks_already_present: usize,
    /// Listed in the index but no longer in the bucket (deleted remotely).
    pub chunks_missing: usize,
    pub frames: usize,
    pub icons: usize,
    pub audio_restored: usize,
    pub audio_already_present: usize,
    pub actions_restored: usize,
    pub actions_already_present: usize,
    /// Action screenshots downloaded into the local store.
    pub screenshots: usize,
    pub bytes_downloaded: u64,
    pub errors: Vec<String>,
}

/// Rebuild the library at `paths` from `device`'s objects. Frames before
/// `from` (epoch ms) are skipped by chunk.
pub fn restore(
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    device: &str,
    from: Option<i64>,
    progress: &mut dyn FnMut(&Report),
) -> Result<Report> {
    let conn = store::open(paths)?;
    let (list, source) = entries(paths, t, device, from)?;
    let mut r = Report {
        device_id: device.into(),
        source: source.into(),
        chunks_listed: list.len(),
        ..Default::default()
    };
    for e in &list {
        let full = t.key(&e.base);
        if e.kind == "actions" {
            if conn
                .query_row(
                    "SELECT 1 FROM action_segment WHERE remote_key = ?1",
                    [&full],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                r.actions_already_present += 1;
                continue;
            }
            match restore_actions(&conn, paths, t, &e.base, &full, &mut r) {
                Ok(true) => r.actions_restored += 1,
                Ok(false) => r.chunks_missing += 1,
                Err(err) => {
                    if target::classify(&err).halts() {
                        return Err(err);
                    }
                    r.errors.push(format!("{}: {err:#}", e.base));
                }
            }
            progress(&r);
            continue;
        }
        if e.kind == "audio" {
            if conn
                .query_row("SELECT 1 FROM audio WHERE remote_key = ?1", [&full], |_| {
                    Ok(())
                })
                .optional()?
                .is_some()
            {
                r.audio_already_present += 1;
                continue;
            }
            match restore_audio(&conn, paths, t, &full, &mut r) {
                Ok(true) => r.audio_restored += 1,
                Ok(false) => r.chunks_missing += 1,
                Err(err) => {
                    if target::classify(&err).halts() {
                        return Err(err);
                    }
                    r.errors.push(format!("{}: {err:#}", e.base));
                }
            }
            progress(&r);
            continue;
        }
        if conn
            .query_row("SELECT 1 FROM video WHERE remote_key = ?1", [&full], |_| {
                Ok(())
            })
            .optional()?
            .is_some()
        {
            r.chunks_already_present += 1;
            continue;
        }
        match restore_chunk(&conn, paths, t, e, &full, &mut r) {
            Ok(true) => r.chunks_restored += 1,
            Ok(false) => r.chunks_missing += 1,
            Err(err) => {
                if target::classify(&err).halts() {
                    return Err(err);
                }
                r.errors.push(format!("{}: {err:#}", e.base));
            }
        }
        progress(&r);
    }
    Ok(r)
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty())
}

/// A text field as recorded: null stays NULL, "" stays "".
fn raw<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(Value::as_i64)
}

/// Download one icon asset into `icons/` (verified by its content hash).
fn ensure_icon(
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    device: &str,
    name: &str,
    r: &mut Report,
) -> Result<Option<String>> {
    let Some(hash) = crate::memory::actions::asset_digest(name) else {
        return Ok(None);
    };
    let file = paths.icons_dir().join(name);
    if !file.exists() {
        let Some(bytes) = t.get_bytes(&t.key(&format!("{device}/assets/{name}")))? else {
            return Ok(None);
        };
        r.bytes_downloaded += bytes.len() as u64;
        let plain = open_blob(paths, bytes)?;
        if target::hex(&Sha256::digest(&plain)) != hash {
            bail!("icon {name}: content does not match its hash");
        }
        std::fs::write(&file, plain)?;
        r.icons += 1;
    }
    Ok(Some(paths.rel(&file)))
}

/// A reader rejects a manifest whose schema is newer than it knows.
fn check_schema(m: &Value) -> Result<()> {
    let schema = i(m, "schema").unwrap_or(1);
    if schema > SCHEMA {
        bail!("manifest schema {schema} is newer than this app understands ({SCHEMA}); update Kortix Capture");
    }
    Ok(())
}

/// Download one object and check it against the manifest's description
/// (stored size and SHA-256); returns the plaintext.
fn fetch_checked(
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    obj: &Value,
    full_key: &str,
    r: &mut Report,
) -> Result<Option<Vec<u8>>> {
    let Some(bytes) = t.get_bytes(full_key)? else {
        return Ok(None);
    };
    r.bytes_downloaded += bytes.len() as u64;
    if let Some(want) = obj.get("sha256").and_then(Value::as_str) {
        let got = target::hex(&Sha256::digest(&bytes));
        if got != want {
            bail!("{full_key}: SHA-256 {got} does not match the manifest {want}");
        }
    }
    if let Some(want) = obj.get("size").and_then(Value::as_u64) {
        if bytes.len() as u64 != want {
            bail!(
                "{full_key}: size {} does not match the manifest {want}",
                bytes.len()
            );
        }
    }
    Ok(Some(open_blob(paths, bytes)?))
}

/// One action segment, whole, into the local store: the screenshots first
/// (checked against their names), then the actions file (checked against the
/// manifest), then the row. Ok(false) when the manifest is gone.
fn restore_actions(
    conn: &Connection,
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    base: &str,
    full: &str,
    r: &mut Report,
) -> Result<bool> {
    use crate::memory::actions;
    let Some(b) = t.get_bytes(&format!("{full}.manifest.json"))? else {
        return Ok(false);
    };
    r.bytes_downloaded += b.len() as u64;
    let m: Value =
        serde_json::from_slice(&open_blob(paths, b)?).context("actions manifest is not JSON")?;
    check_schema(&m)?;
    let device = base.split('/').next().unwrap_or_default();
    let start = i(&m, "start_ms").ok_or_else(|| anyhow!("actions manifest has no start_ms"))?;
    let shots: Vec<String> = m
        .get("screenshots")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    std::fs::create_dir_all(actions::assets_dir(paths))?;
    for name in &shots {
        let digest = actions::asset_digest(name)
            .ok_or_else(|| anyhow!("bad screenshot name {name}"))?
            .to_string();
        let file = actions::assets_dir(paths).join(name);
        if file.exists() {
            continue;
        }
        let Some(plain) = fetch_checked(
            paths,
            t,
            &Value::Null,
            &t.key(&format!("{device}/assets/{name}")),
            r,
        )?
        else {
            bail!("screenshot {name} is missing from the bucket");
        };
        if target::hex(&Sha256::digest(&plain)) != digest {
            bail!("screenshot {name}: content does not match its name");
        }
        std::fs::write(&file, plain)?;
        r.screenshots += 1;
    }
    let obj = m
        .pointer("/objects/actions")
        .cloned()
        .unwrap_or(Value::Null);
    let key = obj
        .get("key")
        .and_then(Value::as_str)
        .map(|k| t.key(k))
        .unwrap_or_else(|| format!("{full}.actions.jsonl.zst"));
    let Some(plain) = fetch_checked(paths, t, &obj, &key, r)? else {
        return Ok(false);
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO action_segment(start_ms, end_ms, path, size_bytes, event_count, screenshots, pii_redacted,
                                    uploaded_at, remote_key, remote_sha256)
         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            start,
            i(&m, "end_ms").unwrap_or(start),
            plain.len() as i64,
            i(&m, "event_count").unwrap_or(0),
            serde_json::to_string(&shots)?,
            m.pointer("/privacy/redact_pii").and_then(Value::as_bool).unwrap_or(false) as i64,
            now_ms(),
            full,
            obj.get("sha256").and_then(Value::as_str),
        ],
    )?;
    let id = tx.last_insert_rowid();
    let name = actions::file_name(start, id);
    std::fs::create_dir_all(actions::dir(paths))?;
    std::fs::write(actions::dir(paths).join(&name), &plain)?;
    tx.execute(
        "UPDATE action_segment SET path = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    tx.commit()?;
    Ok(true)
}

/// One audio segment from its manifest: the row (remote only, playable on
/// demand) and its transcript lines. Ok(false) when the manifest is gone.
fn restore_audio(
    conn: &Connection,
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    full: &str,
    r: &mut Report,
) -> Result<bool> {
    let Some(b) = t.get_bytes(&format!("{full}.manifest.json"))? else {
        return Ok(false);
    };
    r.bytes_downloaded += b.len() as u64;
    let m: Value =
        serde_json::from_slice(&open_blob(paths, b)?).context("audio manifest is not JSON")?;
    check_schema(&m)?;
    let start = i(&m, "start_ms").ok_or_else(|| anyhow!("audio manifest has no start_ms"))?;
    let end = i(&m, "end_ms").unwrap_or(start);
    let name = s(&m, "audio_name")
        .map(str::to_string)
        .unwrap_or_else(|| format!("{start}.m4a"));
    if name.contains('/') || name.contains("..") {
        bail!("bad audio name {name}");
    }
    let sources: Vec<&str> = m
        .get("sources")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let lines: Vec<&Value> = m
        .get("transcript")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources, status, transcript_status, pii_redacted,
                           uploaded_at, remote_key, remote_sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            start,
            end,
            name,
            m.pointer("/objects/audio/plain_size").and_then(Value::as_i64).unwrap_or(0),
            sources.join(","),
            STATUS_REMOTE,
            if lines.is_empty() {
                crate::memory::audio::TRANSCRIPT_NONE
            } else {
                crate::memory::audio::TRANSCRIPT_DONE
            },
            m.get("pii_redacted").and_then(Value::as_bool).unwrap_or(false) as i64,
            now_ms(),
            full,
            m.pointer("/objects/audio/sha256").and_then(Value::as_str),
        ],
    )?;
    let id = tx.last_insert_rowid();
    for line in lines {
        let Some(text) = s(line, "text") else {
            continue;
        };
        let a = i(line, "start_ms").unwrap_or(start);
        tx.execute(
            "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (?1, ?2, ?3, ?4)",
            params![id, a, i(line, "end_ms").unwrap_or(a), text],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

/// Ok(false) when the chunk's objects are gone from the bucket.
fn restore_chunk(
    conn: &Connection,
    paths: &MemoryPaths,
    t: &dyn UploadTarget,
    e: &Entry,
    full: &str,
    r: &mut Report,
) -> Result<bool> {
    let device = e.base.split('/').next().unwrap_or_default().to_string();
    let manifest: Option<Value> = if e.manifest {
        let Some(b) = t.get_bytes(&format!("{full}.manifest.json"))? else {
            return Ok(false);
        };
        r.bytes_downloaded += b.len() as u64;
        let m: Value =
            serde_json::from_slice(&open_blob(paths, b)?).context("manifest is not JSON")?;
        check_schema(&m)?;
        Some(m)
    } else {
        None
    };
    let Some(sidecar) = t.get_bytes(&format!("{full}.frames.jsonl.zst"))? else {
        return Ok(false);
    };
    r.bytes_downloaded += sidecar.len() as u64;
    if let Some(want) = manifest
        .as_ref()
        .and_then(|m| m.pointer("/objects/frames/sha256"))
        .and_then(Value::as_str)
    {
        let got = target::hex(&Sha256::digest(&sidecar));
        if got != want {
            bail!("frames sidecar SHA-256 {got} does not match the manifest {want}");
        }
    }
    let jsonl = zstd::decode_all(open_blob(paths, sidecar)?.as_slice())
        .context("frames sidecar is not zstd")?;
    let frames: Vec<Value> = jsonl
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(serde_json::from_slice)
        .collect::<Result<_, _>>()?;
    if frames.is_empty() {
        return Ok(true);
    }
    // Icons first: they are files, and their paths go into the rows.
    let mut icon_paths: BTreeMap<String, Option<String>> = BTreeMap::new();
    for f in &frames {
        for name in [f.pointer("/app/icon"), f.get("domain_icon")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !icon_paths.contains_key(name) {
                let p = ensure_icon(paths, t, &device, name, r).unwrap_or_else(|err| {
                    r.errors.push(format!("icon {name}: {err:#}"));
                    None
                });
                icon_paths.insert(name.to_string(), p);
            }
        }
    }
    let m = manifest.as_ref();
    let mget = |p: &str| m.and_then(|m| m.pointer(p));
    let (start, id) =
        parse_chunk_name(&e.base).ok_or_else(|| anyhow!("bad chunk key {}", e.base))?;
    let video_name = mget("/video_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{start}-{id}.mp4"));
    if video_name.contains('/') || video_name.contains("..") {
        bail!("bad video name {video_name}");
    }
    let first = &frames[0];
    let width = mget("/width")
        .and_then(Value::as_i64)
        .or_else(|| i(first, "width"))
        .unwrap_or(0);
    let height = mget("/height")
        .and_then(Value::as_i64)
        .or_else(|| i(first, "height"))
        .unwrap_or(0);
    let end = frames
        .iter()
        .filter_map(|f| i(f, "ts_ms"))
        .max()
        .unwrap_or(start);

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO video(height, width, path, num_frames, status, size_bytes, start_timestamp, end_timestamp,
                           uploaded_at, remote_key, remote_sha256, display_id, display)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            height,
            width,
            video_name,
            frames.len() as i64,
            STATUS_REMOTE,
            mget("/objects/video/plain_size").and_then(Value::as_i64),
            frames.iter().filter_map(|f| i(f, "ts_ms")).min().unwrap_or(start),
            end,
            now_ms(),
            full,
            mget("/objects/video/sha256").and_then(Value::as_str),
            mget("/display/id").and_then(Value::as_i64),
            mget("/display").map(Value::to_string),
        ],
    )?;
    let video_id = tx.last_insert_rowid();
    // Sidecars without a segment id: continue the previous frame's segment like
    // the recorder does (same app, domain and URL, less than 5 min apart).
    let mut seg: Option<((Option<i64>, Option<i64>, Option<String>), i64, i64)> = tx
        .query_row(
            "SELECT s.application, s.domain, s.url, f.segment, f.timestamp FROM frame f JOIN segment s ON s.id = f.segment
             WHERE f.timestamp < ?1 ORDER BY f.timestamp DESC LIMIT 1",
            [frames.iter().filter_map(|f| i(f, "ts_ms")).min().unwrap_or(start)],
            |r| Ok(((r.get(0)?, r.get(1)?, r.get(2)?), r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    for (n, f) in frames.iter().enumerate() {
        let app = f.get("app").cloned().unwrap_or(Value::Null);
        let app_id = match s(&app, "bundle_id") {
            Some(bundle) => {
                let row = store::upsert_application(
                    &tx,
                    bundle,
                    s(&app, "version").unwrap_or(""),
                    s(&app, "name").unwrap_or(bundle),
                )?;
                if let Some(user) = app.get("is_user_app").and_then(Value::as_bool) {
                    tx.execute(
                        "UPDATE application SET is_user_app = ?1 WHERE id = ?2",
                        params![user as i64, row.id],
                    )?;
                }
                if let Some(Some(p)) = s(&app, "icon").and_then(|n| icon_paths.get(n)) {
                    tx.execute("UPDATE application SET icon_path = ?1 WHERE bundle_id = ?2 AND icon_path IS NULL", params![p, bundle])?;
                }
                Some(row.id)
            }
            None => None,
        };
        let domain_id = match s(f, "domain") {
            Some(d) => {
                let id = store::upsert_domain(&tx, d)?;
                if let Some(Some(p)) = s(f, "domain_icon").and_then(|n| icon_paths.get(n)) {
                    tx.execute(
                        "UPDATE domain SET icon_path = ?1 WHERE id = ?2 AND icon_path IS NULL",
                        params![p, id],
                    )?;
                }
                Some(id)
            }
            None => None,
        };
        let url = raw(f, "url").map(str::to_string);
        let key = (app_id, domain_id, url.clone());
        let ts = i(f, "ts_ms").unwrap_or(start);
        let new_segment = |tx: &Connection| -> Result<i64> {
            tx.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (0, ?1, ?2, ?3)", params![app_id, domain_id, url])?;
            Ok(tx.last_insert_rowid())
        };
        let seg_id = match i(f, "segment") {
            Some(remote) => {
                let mapped: Option<i64> = tx
                    .query_row(
                        "SELECT m.segment FROM sync_segment m JOIN segment s ON s.id = m.segment WHERE m.device = ?1 AND m.remote = ?2",
                        params![device, remote],
                        |r| r.get(0),
                    )
                    .optional()?;
                match mapped {
                    Some(id) => id,
                    None => {
                        let id = new_segment(&tx)?;
                        tx.execute("INSERT OR REPLACE INTO sync_segment(device, remote, segment) VALUES (?1, ?2, ?3)", params![device, remote, id])?;
                        id
                    }
                }
            }
            None => match &seg {
                Some((k, id, last)) if *k == key && ts - last < SEGMENT_GAP_MS => *id,
                _ => new_segment(&tx)?,
            },
        };
        let ocr = f.get("ocr").cloned().unwrap_or(Value::Null);
        let (fg, bg) = (raw(&ocr, "foreground"), raw(&ocr, "background"));
        let disp = f.get("display").cloned().unwrap_or(Value::Null);
        let df = |k: &str| disp.get(k).and_then(Value::as_f64);
        tx.execute(
            "INSERT INTO frame(timestamp, video, video_index, width, height, title, foreground, background, segment, is_inactive,
                               capture_display_x, capture_display_y, capture_display_width, capture_display_height,
                               capture_reason, dhash, image_hash, ocr_status, pii_redacted,
                               display_id, display_name, display_main, display_focused, display_scale)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18, ?19, ?20, ?21, ?22, ?23)",
            params![
                ts,
                video_id,
                i(f, "frame_index").unwrap_or(n as i64),
                i(f, "width"),
                i(f, "height"),
                raw(f, "title"),
                fg,
                bg,
                seg_id,
                f.get("inactive").and_then(Value::as_bool).unwrap_or(false) as i64,
                df("x"),
                df("y"),
                df("w"),
                df("h"),
                raw(f, "capture_reason"),
                raw(f, "dhash"),
                raw(f, "image_hash"),
                f.get("pii_redacted").and_then(Value::as_bool).unwrap_or(false) as i64,
                disp.get("id").and_then(Value::as_i64),
                disp.get("name").and_then(Value::as_str),
                disp.get("main").and_then(Value::as_bool).map(i64::from),
                disp.get("focused").and_then(Value::as_bool).map(i64::from),
                mget("/display/scale").and_then(Value::as_f64),
            ],
        )?;
        let frame_id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE segment SET start_frame_id = ?1 WHERE id = ?2 AND start_frame_id = 0",
            params![frame_id, seg_id],
        )?;
        seg = Some((key, seg_id, ts));

        // OCR boxes index into foreground || background (chars). Sidecars from
        // before `off`/`len` existed are located by searching the text in order.
        let text: Vec<char> = fg
            .unwrap_or("")
            .chars()
            .chain(bg.unwrap_or("").chars())
            .collect();
        let mut cursor = 0usize;
        for line in ocr
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (off, len) = match (i(line, "off"), i(line, "len")) {
                (Some(o), Some(l)) => (o, l),
                _ => {
                    let needle: Vec<char> = s(line, "text").unwrap_or("").chars().collect();
                    let found = (cursor..=text.len().saturating_sub(needle.len()))
                        .find(|&p| !needle.is_empty() && text[p..].starts_with(&needle))
                        .unwrap_or(cursor);
                    cursor = found + needle.len();
                    (found as i64, needle.len() as i64)
                }
            };
            tx.execute(
                "INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![frame_id, i(line, "x").unwrap_or(0), i(line, "y").unwrap_or(0), i(line, "w").unwrap_or(0), i(line, "h").unwrap_or(0), off, len],
            )?;
        }
        for w in f
            .get("windows")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let bundle = s(w, "app").unwrap_or("");
            let win_app: i64 = match tx
                .query_row(
                    "SELECT id FROM application WHERE bundle_id = ?1 ORDER BY id DESC LIMIT 1",
                    [bundle],
                    |r| r.get(0),
                )
                .optional()?
            {
                Some(id) => id,
                None => {
                    store::upsert_application(&tx, bundle, "", s(w, "app_name").unwrap_or(bundle))?
                        .id
                }
            };
            tx.execute(
                "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, window_layer, z_order, url, is_focussed_window)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    frame_id,
                    win_app,
                    raw(w, "title"),
                    i(w, "x").unwrap_or(0),
                    i(w, "y").unwrap_or(0),
                    i(w, "w").unwrap_or(0),
                    i(w, "h").unwrap_or(0),
                    i(w, "layer").unwrap_or(0),
                    i(w, "z").unwrap_or(0),
                    raw(w, "url"),
                    w.get("focused").and_then(Value::as_bool).unwrap_or(false) as i64,
                ],
            )?;
        }
        if let Some(tree) = f.get("ax_tree") {
            let payload = serde_json::to_vec(tree)?;
            let hash = Sha256::digest(&payload).to_vec();
            tx.execute(
                "INSERT OR IGNORE INTO ax_blob(hash, payload) VALUES (?1, ?2)",
                params![hash, zstd::encode_all(payload.as_slice(), 3)?],
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO ax_snapshot(frame_id, hash, timestamp_ms, application_name, bundle_id, process_identifier, node_count, is_partial_tree)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
                params![
                    frame_id,
                    hash,
                    ts,
                    s(&app, "name").unwrap_or(""),
                    s(&app, "bundle_id").unwrap_or(""),
                    i(f, "ax_nodes").unwrap_or(0),
                    f.get("ax_partial").and_then(Value::as_bool).unwrap_or(false) as i64,
                ],
            )?;
            tx.execute(
                "UPDATE frame SET ax_root_hash = ?1 WHERE id = ?2",
                params![hash, frame_id],
            )?;
        }
        r.frames += 1;
    }
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_folds_puts_and_deletes() {
        let text = r#"{"op":"put","base":"d/2026/10/02/2000-2","start_ms":2000,"end_ms":2500,"manifest":true}
{"op":"put","base":"d/2026/10/02/1000-1","start_ms":1000,"end_ms":1500,"manifest":true}
not json
{"op":"put","base":"d/2026/10/02/3000-3","start_ms":3000,"end_ms":3500,"manifest":false}
{"op":"delete","base":"d/2026/10/02/2000-2"}
{"op":"put","kind":"audio","base":"d/2026/10/02/4000-a1","start_ms":4000,"end_ms":64000,"manifest":true}
"#;
        let e = fold_index(text);
        assert_eq!(
            e.iter().map(|e| e.base.as_str()).collect::<Vec<_>>(),
            [
                "d/2026/10/02/1000-1",
                "d/2026/10/02/3000-3",
                "d/2026/10/02/4000-a1"
            ]
        );
        assert!(e[0].manifest && !e[1].manifest);
        assert_eq!(e[1].end_ms, 3500);
        assert_eq!((e[0].kind.as_str(), e[2].kind.as_str()), ("chunk", "audio"));
    }

    #[test]
    fn chunk_names_parse() {
        assert_eq!(
            parse_chunk_name("kc/dev/2026/10/02/1790985599000-42"),
            Some((1_790_985_599_000, 42))
        );
        assert_eq!(parse_chunk_name("kc/dev/device.json"), None);
    }
}
