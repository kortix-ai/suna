//! Request handler behind the `kmem://` custom protocol.
//!
//! One pure entry point, [`Ctx::handle`]: `(method, uri, range, body)` in,
//! [`Response`] out. The window wires it to wry; tests call it directly.
//! No TCP port is ever opened.

use super::super::engine::Engine;
use super::super::frames::{self, FrameImage};
use super::super::paths::MemoryPaths;
use super::super::settings::{exclusion_groups, resolution_preset, Settings, RESOLUTION_PRESETS};
use super::super::{cli, store, sync};
use anyhow::{anyhow, Result};
use rusqlite::{params_from_iter, types::Value as Sql, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const INDEX_HTML: &str = include_str!("../../../ui/memory/index.html");
const APP_CSS: &str = include_str!("../../../ui/memory/app.css");
const APP_JS: &str = include_str!("../../../ui/memory/app.js");
// Kortix brand kit tokens, copied unmodified from the kit.
const APP_ICON_PNG: &[u8] = include_bytes!("../../../assets/icons/app-256.png");
const BRAND_TOKENS_CSS: &str = include_str!("../../../ui/memory/brand/tokens.css");

/// A gap longer than this between two frames splits a segment run.
const RUN_GAP_MS: i64 = 60_000;
/// Raw FTS rows fetched before near-duplicate frames are collapsed.
const SEARCH_RAW_CAP: i64 = 1500;

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.into(),
            headers: Vec::new(),
            body,
        }
    }
    fn json(value: Value) -> Self {
        let mut r = Self::new(
            200,
            "application/json",
            serde_json::to_vec(&value).unwrap_or_default(),
        );
        r.headers.push(("Cache-Control".into(), "no-store".into()));
        r
    }
    fn error(status: u16, msg: &str) -> Self {
        let mut r = Self::new(
            status,
            "application/json",
            serde_json::to_vec(&json!({"error": msg})).unwrap_or_default(),
        );
        r.headers.push(("Cache-Control".into(), "no-store".into()));
        r
    }
    fn cached(mut self, seconds: u32) -> Self {
        self.headers
            .push(("Cache-Control".into(), format!("public, max-age={seconds}")));
        self
    }
}

pub struct Ctx {
    pub paths: MemoryPaths,
    engine: Mutex<Option<Engine>>,
    /// Long actions (`now`, `restore`, `connect`) run on a thread; the window polls their state.
    jobs: Arc<Mutex<HashMap<String, Value>>>,
    /// Open the Kortix approval page in the browser when connecting. Headless runs set false.
    pub open_browser: bool,
}

type Query = HashMap<String, String>;

/// Run this program again with `args`, detached (`permissions --request` waits on a dialog).
/// A synced recording stays on this computer for this long (10 years); "Keep for" in
/// Storage is what removes it.
const KEEP_LOCAL_HOURS: u64 = 87_600;

fn spawn_self(args: &[&str]) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = crate::os_proc::no_window(&mut std::process::Command::new(exe))
            .args(args)
            .spawn();
    }
}

/// Show a folder in Finder, Explorer or the desktop's file manager.
fn open_path(dir: &std::path::Path) {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    let _ = cmd.arg(dir).spawn();
}

fn parse_query(q: &str) -> Query {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            let dec = |s: &str| {
                urlencoding::decode(&s.replace('+', " "))
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| s.to_string())
            };
            (dec(k), dec(v))
        })
        .collect()
}

fn qi(q: &Query, key: &str) -> Option<i64> {
    q.get(key).and_then(|v| v.parse().ok())
}

fn list(q: &Query, key: &str) -> Vec<String> {
    q.get(key)
        .map(|v| {
            v.split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Parse `bytes=a-b` | `bytes=a-` | `bytes=-n` against a file of `len` bytes.
/// `None` = not satisfiable.
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n.min(len)), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn serve_file(path: &Path, content_type: &str, range: Option<&str>) -> Response {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Response::error(404, "not found");
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return Response::error(404, "not found");
    };
    let mut resp = Response::new(200, content_type, Vec::new());
    resp.headers.push(("Accept-Ranges".into(), "bytes".into()));
    let (start, end) = match range {
        Some(h) => match parse_range(h, len) {
            Some(r) => {
                resp.status = 206;
                resp.headers.push((
                    "Content-Range".into(),
                    format!("bytes {}-{}/{}", r.0, r.1, len),
                ));
                r
            }
            None => {
                resp.status = 416;
                resp.headers
                    .push(("Content-Range".into(), format!("bytes */{len}")));
                return resp;
            }
        },
        None => (0, len.saturating_sub(1)),
    };
    if len > 0 {
        let mut buf = vec![0u8; (end - start + 1) as usize];
        if file
            .seek(SeekFrom::Start(start))
            .and_then(|_| file.read_exact(&mut buf))
            .is_err()
        {
            return Response::error(500, "read failed");
        }
        resp.body = buf;
    }
    resp
}

/// A stored relative path must stay inside `base`.
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(base.join(rel))
}

fn mime_of(path: &Path) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

impl Ctx {
    pub fn new(paths: MemoryPaths) -> Self {
        Self {
            paths,
            engine: Mutex::new(None),
            jobs: Arc::default(),
            open_browser: true,
        }
    }

    fn conn(&self) -> Result<Connection> {
        store::open_readonly(&self.paths)
    }

    pub fn handle(&self, method: &str, uri: &str, range: Option<&str>, body: &[u8]) -> Response {
        let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
        let path = urlencoding::decode(path)
            .map(|p| p.into_owned())
            .unwrap_or_else(|_| path.to_string());
        let q = parse_query(query);
        match self.route(method, &path, &q, range, body) {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!("{method} {path}: {err:#}");
                Response::error(500, &sync::view::humanize_text(&format!("{err:#}"), None))
            }
        }
    }

    fn route(
        &self,
        method: &str,
        path: &str,
        q: &Query,
        range: Option<&str>,
        body: &[u8],
    ) -> Result<Response> {
        Ok(match (method, path) {
            (_, "/" | "/index.html") => {
                Response::new(200, "text/html; charset=utf-8", INDEX_HTML.into())
            }
            (_, "/app.css") => Response::new(200, "text/css; charset=utf-8", APP_CSS.into()),
            (_, "/app.js") => Response::new(200, "text/javascript; charset=utf-8", APP_JS.into()),
            (_, "/brand/tokens.css") => {
                Response::new(200, "text/css; charset=utf-8", BRAND_TOKENS_CSS.into())
            }
            (_, "/brand/app-icon.png") => Response::new(200, "image/png", APP_ICON_PNG.into()),
            ("GET", "/api/status") => Response::json(cli::status_value(&self.paths)),
            ("GET", "/api/app") => Response::json(self.app_info()),
            ("POST", "/api/app/onboarding") => {
                let b = json_body(body)?;
                match b["state"].as_str().and_then(super::super::onboarding::State::parse) {
                    Some(st @ (super::super::onboarding::State::Done | super::super::onboarding::State::Skipped)) => {
                        super::super::onboarding::set(&self.paths, st);
                        Response::json(json!({"ok": true}))
                    }
                    _ => Response::error(400, "State must be done or skipped."),
                }
            }
            ("POST", "/api/app/permissions") => {
                cli::grant_permissions(&self.paths);
                Response::json(json!({"ok": true}))
            }
            ("POST", "/api/app/logs") => {
                let dir = self.paths.logs_dir();
                let _ = std::fs::create_dir_all(&dir);
                open_path(&dir);
                Response::json(json!({"ok": true}))
            }
            // Sign out of Kortix: sync goes off, the recording goes on.
            ("POST", "/api/app/signout") => match cli::sign_out_keep_recording(&self.paths) {
                Ok(v) => Response::json(v),
                Err(e) => Response::error(409, &sync::view::humanize(&e)),
            },
            ("GET", "/api/bounds") => self.bounds()?,
            ("GET", "/api/nearest") => self.nearest(q)?,
            ("GET", "/api/segments") => self.segments(q)?,
            ("GET", "/api/search") => self.search(q)?,
            ("GET", "/api/heatmap") => self.heatmap(q)?,
            ("GET", "/api/days") => self.days(store::now_ms())?,
            ("GET", "/api/audio") => self.audio(q)?,
            ("GET", "/api/audio/devices") => self.audio_devices(),
            ("POST", "/api/audio/permission") => self.audio_permission(),
            ("GET", "/api/apps") => self.apps()?,
            ("GET", "/api/domains") => self.domains()?,
            ("GET", "/api/settings") => self.settings_get(),
            ("POST", "/api/settings") => self.settings_set(body)?,
            ("GET", "/api/privacy-model") => {
                Response::json(super::super::privacy_model::status(&self.paths))
            }
            ("POST", "/api/privacy-model/install") => {
                super::super::privacy_model::start_install(&self.paths)?;
                Response::json(super::super::privacy_model::status(&self.paths))
            }
            ("GET", "/api/sync") => self.sync_get(),
            ("POST", p) if p.starts_with("/api/sync/") || p.starts_with("/api/kortix/") => {
                match self.sync_action(&p["/api/".len()..], body) {
                    Ok(r) => r,
                    // A refused action is the person's to fix: one sentence; the detail is in the log.
                    Err(e) => Response::error(400, &sync::view::humanize(&e)),
                }
            }
            ("POST", "/api/storage/forget") => {
                let b = json_body(body)?;
                match cli::storage_forget(
                    &self.paths,
                    b["tr"].as_str().unwrap_or_default(),
                    b["yes"] == true,
                ) {
                    Ok(r) => Response::json(serde_json::to_value(r)?),
                    Err(e) => Response::error(400, &sync::view::humanize(&e)),
                }
            }
            ("GET", p) if p.starts_with("/api/frame/") => {
                self.frame(p["/api/frame/".len()..].parse()?)?
            }
            ("GET", p) if p.starts_with("/media/video/") => {
                let rel = &p["/media/video/".len()..];
                match safe_join(&self.paths.videos_dir(), rel) {
                    // A remote-only chunk was fetched into the sync cache by `frames::locate`.
                    Some(f) if !f.exists() => {
                        match safe_join(&super::super::sync::cache_dir(&self.paths), rel) {
                            Some(cached) => serve_file(&cached, "video/mp4", range),
                            None => Response::error(400, "bad path"),
                        }
                    }
                    Some(f) => serve_file(&f, "video/mp4", range),
                    None => Response::error(400, "bad path"),
                }
            }
            ("GET", p) if p.starts_with("/media/audio/") => {
                let id: i64 = p["/media/audio/".len()..].parse()?;
                match super::super::audio::locate(&self.conn()?, &self.paths, id) {
                    Ok(Some(f)) => serve_file(&f, "audio/mp4", range).cached(3600),
                    Ok(None) => Response::error(404, "audio not found"),
                    Err(e) => Response::error(502, &format!("{e:#}")),
                }
            }
            ("GET", p) if p.starts_with("/media/frame/") => {
                self.still(p["/media/frame/".len()..].parse()?)?
            }
            ("GET", p) if p.starts_with("/media/thumb/") => {
                self.thumb(p["/media/thumb/".len()..].parse()?)?
            }
            ("GET", p) if p.starts_with("/media/icon/app/") => {
                self.icon("application", p["/media/icon/app/".len()..].parse()?)?
            }
            ("GET", p) if p.starts_with("/media/icon/domain/") => {
                self.icon("domain", p["/media/icon/domain/".len()..].parse()?)?
            }
            _ => Response::error(404, "not found"),
        })
    }

    // ---- timeline -------------------------------------------------------

    fn bounds(&self) -> Result<Response> {
        let Ok(conn) = self.conn() else {
            return Ok(Response::json(json!({"count": 0})));
        };
        let (first, last, count): (Option<i64>, Option<i64>, i64) = conn.query_row(
            "SELECT min(timestamp), max(timestamp), count(*) FROM frame",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok(Response::json(
            json!({"first_ms": first, "last_ms": last, "count": count, "interval_ms": Settings::load(&self.paths).interval_ms}),
        ))
    }

    /// Frame nearest to `t` (ms). `dir` 0 = nearest, 1 = strictly after, -1 = strictly before.
    /// `n` steps (default 1) and `seg=1` (jump to another segment) apply to dir != 0.
    fn nearest(&self, q: &Query) -> Result<Response> {
        let conn = self.conn()?;
        let t = qi(q, "t").ok_or_else(|| anyhow!("t required"))?;
        let dir = qi(q, "dir").unwrap_or(0);
        let n = qi(q, "n").unwrap_or(1).clamp(1, 100_000);
        let row = |r: &rusqlite::Row| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?));
        let found: Option<(i64, i64)> = if dir == 0 {
            let after = conn.query_row("SELECT id, timestamp FROM frame WHERE timestamp >= ?1 ORDER BY timestamp LIMIT 1", [t], row).optional()?;
            let before = conn.query_row("SELECT id, timestamp FROM frame WHERE timestamp <= ?1 ORDER BY timestamp DESC LIMIT 1", [t], row).optional()?;
            match (before, after) {
                (Some(b), Some(a)) => Some(if t - b.1 <= a.1 - t { b } else { a }),
                (b, a) => b.or(a),
            }
        } else if q.get("seg").map(String::as_str) == Some("1") {
            let cur: Option<i64> = conn
                .query_row("SELECT segment FROM frame WHERE timestamp <= ?1 ORDER BY timestamp DESC LIMIT 1", [t], |r| r.get(0))
                .optional()?
                .flatten();
            let sql = if dir > 0 {
                "SELECT id, timestamp FROM frame WHERE timestamp > ?1 AND segment IS NOT ?2 ORDER BY timestamp LIMIT 1"
            } else {
                "SELECT id, timestamp FROM frame WHERE timestamp < ?1 AND segment IS NOT ?2 ORDER BY timestamp DESC LIMIT 1"
            };
            let hit = conn
                .query_row(sql, rusqlite::params![t, cur], row)
                .optional()?;
            match hit {
                // Backwards: land on the first frame of that earlier segment.
                Some((id, ts)) if dir < 0 => {
                    let seg: Option<i64> =
                        conn.query_row("SELECT segment FROM frame WHERE id = ?1", [id], |r| {
                            r.get(0)
                        })?;
                    conn.query_row("SELECT id, timestamp FROM frame WHERE segment IS ?1 ORDER BY timestamp LIMIT 1", [seg], row)
                        .optional()?
                        .or(Some((id, ts)))
                }
                other => other,
            }
        } else {
            let sql = if dir > 0 {
                "SELECT id, timestamp FROM frame WHERE timestamp > ?1 ORDER BY timestamp LIMIT 1 OFFSET ?2"
            } else {
                "SELECT id, timestamp FROM frame WHERE timestamp < ?1 ORDER BY timestamp DESC LIMIT 1 OFFSET ?2"
            };
            conn.query_row(sql, rusqlite::params![t, n - 1], row)
                .optional()?
        };
        Ok(Response::json(match found {
            Some((id, ts)) => json!({"id": id, "t": ts}),
            None => json!({"id": null}),
        }))
    }

    /// Runs of consecutive frames sharing a domain (browser) or application, for the timeline strip.
    /// Video status plays no part: removed or remote-only frames still count.
    fn segments(&self, q: &Query) -> Result<Response> {
        let conn = self.conn()?;
        let from = qi(q, "from").ok_or_else(|| anyhow!("from required"))?;
        let to = qi(q, "to").ok_or_else(|| anyhow!("to required"))?;
        let mut stmt = conn.prepare("SELECT id, timestamp, segment FROM frame WHERE timestamp BETWEEN ?1 AND ?2 ORDER BY timestamp")?;
        let mut runs: Vec<(Option<i64>, i64, i64, i64)> = Vec::new(); // segment, start, end, first frame
        for r in stmt.query_map([from, to], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?,
            ))
        })? {
            let (id, ts, seg) = r?;
            match runs.last_mut() {
                Some(last) if last.0 == seg && ts - last.2 <= RUN_GAP_MS => last.2 = ts,
                _ => runs.push((seg, ts, ts, id)),
            }
        }
        let mut meta: HashMap<Option<i64>, Value> = HashMap::new();
        let mut out: Vec<Value> = Vec::with_capacity(runs.len());
        // Adjacent runs with the same key merge. The key is the web domain for browser
        // frames and the application otherwise, so the client can color a run by its site.
        let mut last_key: Option<String> = None;
        for (seg, s, e, first) in runs {
            let m = match meta.get(&seg) {
                Some(m) => m.clone(),
                None => {
                    let m = self.segment_meta(&conn, seg)?;
                    meta.insert(seg, m.clone());
                    m
                }
            };
            let key = match (m["domain"]["id"].as_i64(), m["app"]["id"].as_i64()) {
                (Some(d), _) => Some(format!("d{d}")),
                (None, Some(a)) => Some(format!("a{a}")),
                _ => None,
            };
            if let (Some(last), true) = (out.last_mut(), key.is_some() && key == last_key) {
                if s - last["e"].as_i64().unwrap_or(s) <= RUN_GAP_MS {
                    last["e"] = json!(e);
                    continue;
                }
            }
            last_key = key.clone();
            out.push(json!({"s": s, "e": e, "frame": first, "seg": seg, "k": key, "app": m["app"], "domain": m["domain"]}));
        }
        Ok(Response::json(json!({ "segments": out })))
    }

    /// Audio segments overlapping `[from, to]` for the timeline: where audio exists
    /// and the URL each one plays from (cloud-only segments download on first play).
    fn audio(&self, q: &Query) -> Result<Response> {
        let from = qi(q, "from").ok_or_else(|| anyhow!("from required"))?;
        let to = qi(q, "to").ok_or_else(|| anyhow!("to required"))?;
        let Ok(conn) = self.conn() else {
            return Ok(Response::json(json!({"segments": []})));
        };
        let segs: Vec<Value> = super::super::audio::segments(&conn, from, to)?
            .into_iter()
            .map(|a| {
                json!({"id": a.id, "s": a.start_ms, "e": a.end_ms, "url": format!("/media/audio/{}", a.id),
                       "sources": a.sources, "remote": a.status == 3})
            })
            .collect();
        Ok(Response::json(json!({ "segments": segs })))
    }

    fn with_engine(&self, req: Value, secs: u64) -> Result<Value> {
        let mut guard = self.engine.lock().map_err(|_| anyhow!("engine lock"))?;
        if guard.is_none() {
            *guard = Some(Engine::new()?);
        }
        guard
            .as_mut()
            .expect("engine")
            .request(req, std::time::Duration::from_secs(secs))
    }

    /// Input devices for the settings window, plus the microphone permission.
    fn audio_devices(&self) -> Response {
        let devices = self.with_engine(json!({"cmd": "audio_devices"}), 10);
        let perms = self.with_engine(json!({"cmd": "permissions"}), 10).ok();
        match devices {
            Ok(v) => Response::json(json!({"devices": v["devices"], "default": v["default"],
                                           "microphone": perms.as_ref().map(|p| p["microphone"].clone())})),
            Err(e) => Response::json(json!({"devices": [], "error": format!("{e:#}")})),
        }
    }

    /// The person clicked "Allow microphone": show the macOS prompt once.
    fn audio_permission(&self) -> Response {
        match self.with_engine(
            json!({"cmd": "request_permissions", "only": ["microphone"]}),
            120,
        ) {
            Ok(v) => Response::json(json!({"microphone": v["microphone"]})),
            Err(e) => Response::error(500, &format!("{e:#}")),
        }
    }

    fn segment_meta(&self, conn: &Connection, seg: Option<i64>) -> Result<Value> {
        let Some(seg) = seg else {
            return Ok(json!({"app": null, "domain": null}));
        };
        let row = conn
            .query_row(
                "SELECT a.id, a.display_name, a.bundle_id, a.dominant_color, a.icon_path IS NOT NULL,
                        d.id, d.normalized_domain, d.dominant_color, d.icon_path IS NOT NULL
                 FROM segment s LEFT JOIN application a ON a.id = s.application LEFT JOIN domain d ON d.id = s.domain
                 WHERE s.id = ?1",
                [seg],
                |r| Ok(app_domain_json(r, 0)),
            )
            .optional()?;
        Ok(row.unwrap_or_else(|| json!({"app": null, "domain": null})))
    }

    fn frame(&self, id: i64) -> Result<Response> {
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT f.id, f.timestamp, f.width, f.height, f.title, f.foreground, f.background, f.segment,
                        a.id, a.display_name, a.bundle_id, a.dominant_color, a.icon_path IS NOT NULL,
                        d.id, d.normalized_domain, d.dominant_color, s.url,
                        (SELECT w.url FROM window_bound w WHERE w.frame = f.id AND w.is_focussed_window = 1 AND w.url IS NOT NULL LIMIT 1),
                        (SELECT w.window_title FROM window_bound w WHERE w.frame = f.id AND w.is_focussed_window = 1 LIMIT 1),
                        v.status, v.path, f.video_index
                 FROM frame f
                 LEFT JOIN segment s ON s.id = f.segment
                 LEFT JOIN application a ON a.id = s.application
                 LEFT JOIN domain d ON d.id = s.domain
                 LEFT JOIN video v ON v.id = f.video
                 WHERE f.id = ?1",
                [id],
                |r| {
                    let mut meta = app_domain_json(r, 8);
                    let fg: String = r.get::<_, Option<String>>(5)?.unwrap_or_default();
                    let bg: String = r.get::<_, Option<String>>(6)?.unwrap_or_default();
                    let seg_url: Option<String> = r.get(16)?;
                    let win_url: Option<String> = r.get(17)?;
                    let win_title: Option<String> = r.get(18)?;
                    let title: Option<String> = r.get(4)?;
                    meta["id"] = json!(r.get::<_, i64>(0)?);
                    meta["t"] = json!(r.get::<_, i64>(1)?);
                    meta["w"] = json!(r.get::<_, Option<i64>>(2)?);
                    meta["h"] = json!(r.get::<_, Option<i64>>(3)?);
                    meta["title"] = json!(win_title.filter(|s| !s.is_empty()).or(title));
                    meta["url"] = json!(win_url.or(seg_url));
                    meta["segment"] = json!(r.get::<_, Option<i64>>(7)?);
                    meta["video_status"] = json!(r.get::<_, Option<i64>>(19)?);
                    meta["video_path"] = json!(r.get::<_, Option<String>>(20)?);
                    meta["video_index"] = json!(r.get::<_, Option<i64>>(21)?);
                    Ok((meta, fg, bg))
                },
            )
            .optional()?;
        let Some((mut meta, fg, bg)) = row else {
            return Ok(Response::error(404, "frame not found"));
        };
        let media = match frames::locate(&conn, &self.paths, id)? {
            FrameImage::Still(_) => json!({"kind": "still", "url": format!("/media/frame/{id}")}),
            FrameImage::Video {
                index, downscaled, ..
            } => {
                let path = meta["video_path"]
                    .as_str()
                    .unwrap_or_default()
                    .split('/')
                    .map(|s| urlencoding::encode(s).into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                json!({"kind": "video", "url": format!("/media/video/{path}"), "index": index, "downscaled": downscaled})
            }
            FrameImage::Removed => json!({"kind": "removed"}),
            FrameImage::Missing => json!({"kind": "missing"}),
        };
        let text: Vec<char> = fg.chars().chain(bg.chars()).collect();
        let mut stmt = conn.prepare("SELECT x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?1 ORDER BY id")?;
        let boxes: Vec<Value> = stmt
            .query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)))?
            .filter_map(Result::ok)
            .map(|(x, y, w, h, off, len)| {
                let a = (off.max(0) as usize).min(text.len());
                let b = ((off + len).max(0) as usize).min(text.len());
                json!({"x": x, "y": y, "w": w, "h": h, "text": text[a..b].iter().collect::<String>()})
            })
            .collect();
        meta["media"] = media;
        meta["boxes"] = json!(boxes);
        meta["fg_chars"] = json!(fg.chars().count());
        Ok(Response::json(meta))
    }

    // ---- search ---------------------------------------------------------

    fn search(&self, q: &Query) -> Result<Response> {
        let conn = self.conn()?;
        let text = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
        let limit = qi(q, "limit").unwrap_or(48).clamp(1, 200) as usize;
        let offset = qi(q, "offset").unwrap_or(0).max(0) as usize;
        let mut rows = match self.search_rows(&conn, &text, q) {
            Ok(r) => r,
            // FTS5 syntax error: retry with every word as a quoted term.
            Err(_) if !text.is_empty() => {
                let quoted = text
                    .split_whitespace()
                    .map(|w| format!("\"{}\"", w.replace('"', "")))
                    .collect::<Vec<_>>()
                    .join(" ");
                self.search_rows(&conn, &quoted, q)?
            }
            Err(e) => return Err(e),
        };
        // Collapse near-identical consecutive frames: keep one per segment and minute.
        let mut seen = std::collections::HashSet::new();
        rows.retain(|r| seen.insert((r.segment, r.t / 60_000)));
        let mut all: Vec<(i64, Value)> = rows
            .into_iter()
            .map(|r| (r.t, json!({"source": "screen", "id": r.id, "t": r.t, "title": r.title, "snippet": r.snippet, "removed": r.removed, "app": r.meta["app"], "domain": r.meta["domain"]})))
            .collect();
        // Spoken words (audio memory) merge in by time. They have no app or site,
        // so an app or website filter leaves them out.
        if !text.is_empty() && list(q, "app").is_empty() && list(q, "domain").is_empty() {
            let range = super::super::timerange::TimeRange {
                start: qi(q, "from"),
                end: qi(q, "to").map(|t| t - 1),
            };
            for h in super::super::query::audio_hits(&conn, &text, range, SEARCH_RAW_CAP as usize)?
            {
                let near = super::super::query::closest_frame(&conn, h.start_ms)?
                    .filter(|(_, d)| *d <= 600_000)
                    .map(|(id, _)| id);
                all.push((h.start_ms, json!({"source": "audio", "id": near, "audio_id": h.audio_id, "t": h.start_ms,
                                             "end": h.end_ms, "title": "Heard", "snippet": h.snippet, "removed": false,
                                             "app": null, "domain": null})));
            }
            all.sort_by(|a, b| b.0.cmp(&a.0));
        }
        let total = all.len();
        let results: Vec<Value> = all
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, v)| v)
            .collect();
        Ok(Response::json(
            json!({"results": results, "total": total, "capped": total as i64 >= SEARCH_RAW_CAP}),
        ))
    }

    fn search_rows(&self, conn: &Connection, text: &str, q: &Query) -> Result<Vec<SearchRow>> {
        let (where_sql, mut args) = filters_sql(q);
        let (from_sql, select_snippet, mut all_args) = if text.is_empty() {
            ("frame f", "f.title", Vec::new())
        } else {
            (
                "ocr_fts JOIN frame f ON f.id = ocr_fts.rowid",
                "snippet(ocr_fts, -1, char(1), char(2), '…', 16)",
                vec![Sql::Text(text.to_string())],
            )
        };
        all_args.append(&mut args);
        let fts = if text.is_empty() {
            ""
        } else {
            "ocr_fts MATCH ?1 AND "
        };
        let sql = format!(
            "SELECT f.id, f.timestamp, f.title, f.segment, {select_snippet},
                    a.id, a.display_name, a.bundle_id, a.dominant_color, a.icon_path IS NOT NULL,
                    d.id, d.normalized_domain, d.dominant_color,
                    (SELECT status FROM video WHERE id = f.video)
             FROM {from_sql}
             LEFT JOIN segment s ON s.id = f.segment
             LEFT JOIN application a ON a.id = s.application
             LEFT JOIN domain d ON d.id = s.domain
             WHERE {fts}{where_sql}
             ORDER BY f.timestamp DESC LIMIT {SEARCH_RAW_CAP}"
        );
        // Positional `?` inside filters_sql are numbered after the optional MATCH arg.
        let sql = renumber(&sql);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(all_args.iter()), |r| {
            Ok(SearchRow {
                id: r.get(0)?,
                t: r.get(1)?,
                title: r.get(2)?,
                segment: r.get(3)?,
                snippet: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                meta: app_domain_json(r, 5),
                removed: r.get::<_, Option<i64>>(13)? == Some(2),
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Per-day frame counts (`day` = floor((epoch_s + tz) / 86400)).
    fn heatmap(&self, q: &Query) -> Result<Response> {
        let conn = self.conn()?;
        let tz = qi(q, "tz").unwrap_or(0);
        let text = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
        let (where_sql, mut args) = filters_sql(q);
        let mut all_args = Vec::new();
        let (from_sql, fts) = if text.is_empty() {
            ("frame f", "")
        } else {
            all_args.push(Sql::Text(text.clone()));
            (
                "ocr_fts JOIN frame f ON f.id = ocr_fts.rowid",
                "ocr_fts MATCH ?1 AND ",
            )
        };
        all_args.append(&mut args);
        let sql = renumber(&format!(
            "SELECT (f.timestamp / 1000 + {tz}) / 86400 AS day, count(*)
             FROM {from_sql}
             LEFT JOIN segment s ON s.id = f.segment
             LEFT JOIN application a ON a.id = s.application
             LEFT JOIN domain d ON d.id = s.domain
             WHERE {fts}{where_sql} GROUP BY day ORDER BY day"
        ));
        let run = |sql: &str, args: &[Sql]| -> Result<Vec<(i64, i64)>> {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        };
        let days = match run(&sql, &all_args) {
            Ok(d) => d,
            Err(_) if !text.is_empty() => {
                let quoted = text
                    .split_whitespace()
                    .map(|w| format!("\"{}\"", w.replace('"', "")))
                    .collect::<Vec<_>>()
                    .join(" ");
                all_args[0] = Sql::Text(quoted);
                run(&sql, &all_args)?
            }
            Err(e) => return Err(e),
        };
        let mut days: std::collections::BTreeMap<i64, i64> = days.into_iter().collect();
        if !text.is_empty() && list(q, "app").is_empty() && list(q, "domain").is_empty() {
            let range = super::super::timerange::TimeRange::default();
            for h in super::super::query::audio_hits(&conn, &text, range, SEARCH_RAW_CAP as usize)?
            {
                *days.entry((h.start_ms / 1000 + tz) / 86400).or_default() += 1;
            }
        }
        Ok(Response::json(
            json!({"days": days.into_iter().map(|(d, c)| json!([d, c])).collect::<Vec<_>>()}),
        ))
    }

    /// Days with recorded frames in the last 365 days, newest first, for the jump
    /// popover: `{date (local YYYY-MM-DD), first_ms, last_ms, frames, recorded_ms}`.
    /// Frames of remote-only chunks keep their rows, so synced days stay listed.
    /// `recorded_ms` sums the steps between consecutive frames up to [`RUN_GAP_MS`].
    /// Days follow this machine's time zone, DST included (SQLite `localtime`),
    /// which is the window's own time zone.
    fn days(&self, now: i64) -> Result<Response> {
        let Ok(conn) = self.conn() else {
            return Ok(Response::json(json!({"days": []})));
        };
        let mut stmt = conn.prepare(
            "SELECT day, min(t), max(t), count(*), sum(CASE WHEN step <= ?2 THEN step ELSE 0 END)
             FROM (SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS day, timestamp AS t,
                          timestamp - lag(timestamp) OVER (ORDER BY timestamp) AS step
                   FROM frame WHERE timestamp >= ?1)
             GROUP BY day ORDER BY day DESC",
        )?;
        let days: Vec<Value> = stmt
            .query_map(rusqlite::params![now - 365 * 86_400_000, RUN_GAP_MS], |r| {
                Ok(json!({"date": r.get::<_, String>(0)?, "first_ms": r.get::<_, i64>(1)?, "last_ms": r.get::<_, i64>(2)?,
                          "frames": r.get::<_, i64>(3)?, "recorded_ms": r.get::<_, Option<i64>>(4)?.unwrap_or(0)}))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Response::json(json!({ "days": days })))
    }

    fn apps(&self) -> Result<Response> {
        let Ok(conn) = self.conn() else {
            return Ok(Response::json(json!({"apps": []})));
        };
        let mut stmt = conn.prepare(
            "SELECT min(a.id), a.bundle_id, max(a.display_name), max(a.dominant_color), max(a.icon_path IS NOT NULL),
                    (SELECT count(*) FROM segment s JOIN application x ON x.id = s.application WHERE x.bundle_id = a.bundle_id)
             FROM application a GROUP BY a.bundle_id ORDER BY 6 DESC",
        )?;
        let apps: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "bundle": r.get::<_, String>(1)?, "name": r.get::<_, Option<String>>(2)?,
                          "color": r.get::<_, Option<i64>>(3)?, "icon": r.get::<_, i64>(4)? != 0}))
            })?
            .filter_map(Result::ok)
            .collect();
        Ok(Response::json(json!({ "apps": apps })))
    }

    fn domains(&self) -> Result<Response> {
        let Ok(conn) = self.conn() else {
            return Ok(Response::json(json!({"domains": []})));
        };
        let mut stmt = conn.prepare(
            "SELECT d.id, d.normalized_domain, d.dominant_color, d.icon_path IS NOT NULL,
                    (SELECT count(*) FROM segment s WHERE s.domain = d.id)
             FROM domain d ORDER BY 5 DESC",
        )?;
        let domains: Vec<Value> = stmt
            .query_map([], |r| Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<i64>>(2)?, "icon": r.get::<_, i64>(3)? != 0})))?
            .filter_map(Result::ok)
            .collect();
        Ok(Response::json(json!({ "domains": domains })))
    }

    // ---- settings -------------------------------------------------------

    fn settings_get(&self) -> Response {
        let groups: Vec<Value> = exclusion_groups()
            .iter()
            .map(|g| json!({"id": g.id, "name": g.name, "bundle_ids": g.bundle_ids, "domains": g.domains}))
            .collect();
        let settings = Settings::load(&self.paths);
        let presets: Vec<Value> = RESOLUTION_PRESETS
            .iter()
            .map(|(n, w, h)| json!({"name": n, "max_width": w, "max_height": h}))
            .collect();
        Response::json(json!({
            "settings": settings,
            // `custom` when max_width / max_height match no preset.
            "resolution": settings.resolution_name(),
            "resolution_presets": presets,
            "groups": groups,
            "status": cli::status_value(&self.paths),
            "privacy_model": super::super::privacy_model::status(&self.paths),
        }))
    }

    /// Merge the posted object into the current settings (objects merge key by key at
    /// every depth, so `{"sync": {"s3": {"prefix": "x"}}}` keeps the other S3 fields),
    /// validate with [`Settings::validate`] like `kortix-capture settings`, save.
    /// `"resolution": "720p" | "1080p" | "1440p" | "4k"` sets max_width and max_height
    /// first; explicit max_width / max_height in the same patch win. `"custom"` is a no-op.
    fn settings_set(&self, body: &[u8]) -> Result<Response> {
        let patch: Value =
            serde_json::from_slice(body).map_err(|e| anyhow!("invalid JSON: {e}"))?;
        let mut cur = serde_json::to_value(Settings::load(&self.paths))?;
        if let Some(name) = patch
            .get("resolution")
            .and_then(Value::as_str)
            .filter(|n| *n != "custom")
        {
            let (w, h) = resolution_preset(name).ok_or_else(|| {
                anyhow!("unknown resolution {name:?} (use 720p, 1080p, 1440p, 4k)")
            })?;
            cur["max_width"] = json!(w);
            cur["max_height"] = json!(h);
        }
        let mut patch = patch;
        patch
            .as_object_mut()
            .ok_or_else(|| anyhow!("object expected"))?
            .remove("resolution");
        merge(&mut cur, patch);
        let next: Settings = match serde_json::from_value(cur) {
            Ok(s) => s,
            Err(e) => return Ok(Response::error(400, &format!("invalid settings: {e}"))),
        };
        if let Err(e) = next.validate() {
            return Ok(Response::error(400, &format!("{e:#}")));
        }
        next.save(&self.paths)?;
        Ok(Response::json(
            json!({"settings": next, "resolution": next.resolution_name()}),
        ))
    }

    // ---- the app: what the window and the About section use ----

    /// The version, the library and the sign-in in the words the window shows.
    fn app_info(&self) -> Value {
        let (managed, _) = super::super::managed::enrollment_value(&self.paths);
        let k = sync::issuer::status(&self.paths, &Settings::load(&self.paths).sync.kortix.url);
        json!({
            "version": option_env!("KORTIX_RELEASE_TAG")
                .filter(|t| !t.trim().is_empty() && *t != "dev")
                .map(|t| t.trim_start_matches('v'))
                .unwrap_or(env!("CARGO_PKG_VERSION")),
            "platform": std::env::consts::OS,
            "managed": managed,
            "signed_in": k["signed_in"],
            "account_name": k["account_name"],
            "member_email": k["member_email"],
            // A build without a baked-in Kortix address asks for it where the person connects.
            "default_issuer_missing": k["issuer_url"].is_null(),
            // The Kortix API this computer signs in to: the saved address, else the build's.
            "issuer_url": k["issuer_url"],
            "state": cli::recording_state(&self.paths),
            "service": cli::service_status_value(&self.paths),
            // A personal install with nothing connected: the window starts on onboarding.
            "onboarding": super::super::onboarding::needed_now(&self.paths),
        })
    }

    // ---- cloud sync -----------------------------------------------------
    //
    // Thin wrappers over the functions `kortix-capture sync` and `storage forget` call
    // (`cli::sync_*`), so the window and the CLI share one implementation.

    /// Sync status (`sync status --json`, which carries the Kortix sign-in and
    /// the operator's policy), the saved S3 credentials without their secrets,
    /// what records now under the policy, and the long actions.
    fn sync_get(&self) -> Response {
        let s = Settings::load(&self.paths);
        let eff = Settings::effective(&self.paths);
        let creds = sync::load_credentials(&self.paths);
        let mut jobs = self.jobs.lock().map(|j| json!(*j)).unwrap_or(json!({}));
        // The sign-in's own progress file wins: it also covers a sign-in started elsewhere.
        if let Some(c) = cli::read_connect_state(&self.paths) {
            jobs["connect"] = c;
        }
        let now = store::now_ms();
        let layer =
            |on: bool, why: Option<&str>| json!({"on": on && why.is_none(), "blocked_by": why});
        Response::json(json!({
            "status": cli::sync_status_value(&self.paths),
            // The words the window shows: destination, one status line, tone.
            "view": cli::sync_view(&self.paths),
            "switch_rule": sync::view::SWITCH_RULE,
            // Write-only: the secret access key and the session token never leave the library.
            "credentials": {
                "saved": creds.is_some(),
                "source": if std::env::var("KORTIX_CAPTURE_S3_ACCESS_KEY_ID").is_ok() { "environment" } else { "file" },
                "access_key_id": creds.as_ref().map(|c| c.access_key_id.clone()),
                "session_token": creds.as_ref().is_some_and(|c| c.session_token.is_some()),
            },
            "layers": {
                "screen": layer(s.recording_enabled, eff.inactive_reason(now).filter(|r| r.starts_with("policy"))),
                "audio": layer(s.audio.enabled, (s.audio.enabled && !eff.audio.enabled).then_some("policy_off")),
                "actions": {
                    "recording": crate::memory::actions::read_heartbeat(&self.paths).is_some_and(|h| h.recording),
                    "blocked_by": eff.actions_blocked(now),
                },
            },
            "airgap": s.airgap,
            "jobs": jobs,
        }))
    }

    /// `POST /api/sync/<action>` and `/api/kortix/<action>`.
    fn sync_action(&self, action: &str, body: &[u8]) -> Result<Response> {
        let b = json_body(body)?;
        let str_of = |k: &str| b[k].as_str().map(str::trim).filter(|v| !v.is_empty());
        // The window keeps the local copy: the destination is a copy, and "Keep for"
        // decides how long this computer holds recordings.
        let hours = b["keep_local_hours"].as_u64().or(Some(KEEP_LOCAL_HOURS));
        let p = &self.paths;
        if matches!(
            action,
            "sync/setup" | "kortix/connect" | "sync/on" | "sync/off" | "kortix/disconnect"
        ) && super::super::managed::enrollment_value(p).0
        {
            return Ok(Response::error(
                403,
                "Sync is set by policy on this computer.",
            ));
        }
        let v = match action {
            "sync/setup" | "kortix/connect"
                if action == "kortix/connect" || b["provider"] == "kortix" =>
            {
                let (p, issuer, open_browser) = (
                    p.clone(),
                    str_of("issuer").map(str::to_string),
                    self.open_browser,
                );
                return self.start_job("connect", move |set| {
                    let stop = std::sync::atomic::AtomicBool::new(false);
                    let mut show = |a: &sync::issuer::DeviceAuthorization| {
                        set(json!({"user_code": a.user_code, "approve_url": a.verification_uri_complete}));
                        if open_browser {
                            let _ = sync::issuer::open_browser(&a.verification_uri_complete);
                        }
                    };
                    cli::sync_setup_kortix(&p, issuer.as_deref(), hours, &mut show, &stop)
                });
            }
            "sync/setup" => cli::sync_setup_s3(
                p,
                cli::S3Setup {
                    endpoint: str_of("endpoint").unwrap_or_default().into(),
                    bucket: str_of("bucket").unwrap_or_default().into(),
                    region: str_of("region").unwrap_or("us-east-1").into(),
                    prefix: b["prefix"].as_str().unwrap_or("kortix-capture").into(),
                    path_style: b["path_style"] == true,
                    keep_local_hours: hours,
                    creds: self.s3_creds(&b)?,
                    encrypt: b["encrypt"] == true,
                },
            )?,
            // Unsaved form values are probed as typed, like `sync setup` does before it saves.
            "sync/test" if str_of("endpoint").is_some() => {
                let mut s = Settings::load(p);
                s.sync.s3.endpoint = str_of("endpoint").unwrap_or_default().into();
                s.sync.s3.bucket = str_of("bucket").unwrap_or_default().into();
                s.sync.s3.region = str_of("region").unwrap_or("us-east-1").into();
                s.sync.s3.prefix = b["prefix"].as_str().unwrap_or("kortix-capture").into();
                s.sync.s3.path_style = b["path_style"] == true;
                let t = sync::target_for(&s.sync, &self.s3_creds(&b)?)?;
                let ms = sync::UploadTarget::probe(&t, &sync::device_id(p, &s))?.as_millis() as u64;
                json!({"ok": true, "probe_ms": ms})
            }
            "sync/test" => cli::sync_test(p)?,
            "sync/on" => cli::sync_set_enabled(p, true)?,
            "sync/off" => cli::sync_set_enabled(p, false)?,
            "sync/encrypt" => cli::sync_set_encrypt(p, b["on"] == true)?,
            "sync/key/export" => cli::sync_key_export(p)?,
            "sync/key/import" => cli::sync_key_import(p, str_of("key").unwrap_or_default())?,
            "sync/devices" => {
                json!({"devices": cli::sync_devices(p)?, "this_device": sync::device_id(p, &Settings::load(p))})
            }
            "sync/now" => {
                let p = p.clone();
                return self.start_job("now", move |_| {
                    Ok(serde_json::to_value(cli::sync_now(&p)?)?)
                });
            }
            "sync/restore" => {
                let (p, from, device) = (
                    p.clone(),
                    str_of("from").map(str::to_string),
                    str_of("device").map(str::to_string),
                );
                return self.start_job("restore", move |set| {
                    let report = cli::sync_restore(&p, from.as_deref(), device, &mut |r| {
                        set(serde_json::to_value(r).unwrap_or_default())
                    })?;
                    Ok(serde_json::to_value(report)?)
                });
            }
            "kortix/disconnect" => cli::sync_sign_out(p)?,
            _ => return Ok(Response::error(404, "not found")),
        };
        Ok(Response::json(v))
    }

    /// Credentials from the S3 form. A blank secret keeps the saved one when the
    /// access key id is blank or unchanged, so the window never needs the secret back.
    fn s3_creds(&self, b: &Value) -> Result<sync::SyncCredentials> {
        let field = |k: &str| {
            b[k].as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let saved = sync::load_credentials(&self.paths);
        let id = field("access_key_id").or_else(|| saved.as_ref().map(|c| c.access_key_id.clone()));
        let Some(id) = id else {
            return Err(anyhow!("enter the access key ID"));
        };
        let keep = saved.filter(|c| c.access_key_id == id);
        Ok(sync::SyncCredentials {
            secret_access_key: field("secret_access_key")
                .or_else(|| keep.as_ref().map(|c| c.secret_access_key.clone()))
                .ok_or_else(|| anyhow!("enter the secret access key"))?,
            session_token: field("session_token")
                .or_else(|| keep.as_ref().and_then(|c| c.session_token.clone())),
            access_key_id: id,
        })
    }

    /// Run `work` on a thread under `name`; `GET /api/sync` reports it in `jobs`.
    /// `work` gets a setter for its progress. One run per name at a time.
    fn start_job(
        &self,
        name: &str,
        work: impl FnOnce(&dyn Fn(Value)) -> Result<Value> + Send + 'static,
    ) -> Result<Response> {
        {
            let mut jobs = self.jobs.lock().map_err(|_| anyhow!("job lock poisoned"))?;
            if jobs.get(name).is_some_and(|j| j["running"] == true) {
                return Ok(Response::error(409, &format!("{name} is already running")));
            }
            jobs.insert(
                name.into(),
                json!({"running": true, "started_ms": store::now_ms(), "progress": null}),
            );
        }
        let (jobs, key) = (self.jobs.clone(), name.to_string());
        std::thread::spawn(move || {
            let update = |f: &dyn Fn(&mut Value)| {
                if let Some(j) = jobs.lock().ok().as_mut().and_then(|m| m.get_mut(&key)) {
                    f(j);
                }
            };
            let out = work(&|p| update(&|j| j["progress"] = p.clone()));
            update(&|j| {
                j["running"] = json!(false);
                j["finished_ms"] = json!(store::now_ms());
                match &out {
                    Ok(v) => {
                        j["ok"] = json!(true);
                        j["result"] = v.clone();
                    }
                    Err(e) => {
                        j["ok"] = json!(false);
                        tracing::warn!("job {key} failed: {e:#}");
                        j["error"] = json!(sync::view::humanize_text(
                            &format!("{e:#}"),
                            sync::target::classify_known(e).map(|c| c.as_str())
                        ));
                    }
                }
            });
        });
        Ok(Response::json(json!({"job": name, "running": true})))
    }

    // ---- media ----------------------------------------------------------

    fn still(&self, id: i64) -> Result<Response> {
        let conn = self.conn()?;
        Ok(match frames::locate(&conn, &self.paths, id)? {
            FrameImage::Still(p) => serve_file(&p, &mime_of(&p), None).cached(3600),
            _ => Response::error(404, "no still"),
        })
    }

    fn icon(&self, table: &str, id: i64) -> Result<Response> {
        let conn = self.conn()?;
        let stored: Option<String> = conn
            .query_row(
                &format!("SELECT icon_path FROM {table} WHERE id = ?1"),
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        let Some(rel) = stored else {
            return Ok(Response::error(404, "no icon"));
        };
        let file = self.paths.abs(&rel);
        Ok(serve_file(&file, &mime_of(&file), None).cached(3600))
    }

    /// 480 px wide JPEG thumbnail, cached under `<root>/cache/thumbs`.
    fn thumb(&self, id: i64) -> Result<Response> {
        let cache = self.paths.root.join("cache").join("thumbs");
        std::fs::create_dir_all(&cache)?;
        let file = cache.join(format!("{id}.jpg"));
        if file.exists() {
            return Ok(serve_file(&file, "image/jpeg", None).cached(86_400));
        }
        let conn = self.conn()?;
        let source: PathBuf = match frames::locate(&conn, &self.paths, id)? {
            FrameImage::Still(p) => p,
            FrameImage::Video { .. } => {
                let tmp = cache.join(format!("{id}.full.jpg"));
                let mut guard = self
                    .engine
                    .lock()
                    .map_err(|_| anyhow!("engine lock poisoned"))?;
                if guard.is_none() {
                    *guard = Some(Engine::new()?);
                }
                frames::export(
                    &conn,
                    &self.paths,
                    guard.as_mut().expect("engine"),
                    id,
                    &tmp,
                    None,
                )?;
                tmp
            }
            _ => return Ok(Response::error(404, "no image")),
        };
        let img = image::open(&source)?;
        let _ = std::fs::remove_file(cache.join(format!("{id}.full.jpg")));
        let thumb = image::imageops::thumbnail(
            &img.to_rgb8(),
            480,
            (480.0 * img.height() as f64 / img.width().max(1) as f64).max(1.0) as u32,
        );
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 78).encode_image(&thumb)?;
        std::fs::write(&file, &buf)?;
        Ok(Response::new(200, "image/jpeg", buf).cached(86_400))
    }

    /// Export the full frame as PNG (for the clipboard); returns the file.
    pub fn export_png(&self, id: i64) -> Result<PathBuf> {
        let conn = self.conn()?;
        let out = MemoryPaths::export_dir().join(format!("frame-{id}.png"));
        std::fs::create_dir_all(MemoryPaths::export_dir())?;
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| anyhow!("engine lock poisoned"))?;
        if guard.is_none() {
            *guard = Some(Engine::new()?);
        }
        frames::export(
            &conn,
            &self.paths,
            guard.as_mut().expect("engine"),
            id,
            &out,
            None,
        )
    }
}

/// Objects merge key by key at every depth; anything else replaces.
fn merge(dst: &mut Value, src: Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                merge(d.entry(k).or_insert(Value::Null), v);
            }
        }
        (d, s) => *d = s,
    }
}

fn json_body(body: &[u8]) -> Result<Value> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|e| anyhow!("invalid JSON: {e}"))
}

struct SearchRow {
    id: i64,
    t: i64,
    title: Option<String>,
    segment: Option<i64>,
    snippet: String,
    meta: Value,
    removed: bool,
}

/// Columns starting at `i`: app id, name, bundle, color, has_icon, domain id, domain, domain color, domain has_icon.
fn app_domain_json(r: &rusqlite::Row, i: usize) -> Value {
    let app_id: Option<i64> = r.get(i).ok().flatten();
    let dom_id: Option<i64> = r.get(i + 5).ok().flatten();
    json!({
        "app": app_id.map(|id| json!({
            "id": id,
            "name": r.get::<_, Option<String>>(i + 1).ok().flatten(),
            "bundle": r.get::<_, Option<String>>(i + 2).ok().flatten(),
            "color": r.get::<_, Option<i64>>(i + 3).ok().flatten(),
            "icon": r.get::<_, Option<i64>>(i + 4).ok().flatten().unwrap_or(0) != 0,
        })),
        "domain": dom_id.map(|id| json!({
            "id": id,
            "name": r.get::<_, Option<String>>(i + 6).ok().flatten(),
            "color": r.get::<_, Option<i64>>(i + 7).ok().flatten(),
            "icon": r.get::<_, Option<i64>>(i + 8).ok().flatten().unwrap_or(0) != 0,
        })),
    })
}

/// WHERE fragments for app / domain / time filters. Placeholders are `?` and
/// are numbered by [`renumber`]; the MATCH argument (if any) is `?1`.
fn filters_sql(q: &Query) -> (String, Vec<Sql>) {
    let mut sql = String::from("1 = 1");
    let mut args = Vec::new();
    if let Some(from) = qi(q, "from") {
        sql += " AND f.timestamp >= ?";
        args.push(Sql::Integer(from));
    }
    if let Some(to) = qi(q, "to") {
        sql += " AND f.timestamp < ?";
        args.push(Sql::Integer(to));
    }
    for (key, col) in [("app", "a.bundle_id"), ("domain", "d.normalized_domain")] {
        let vals = list(q, key);
        if !vals.is_empty() {
            sql += &format!(" AND {col} IN ({})", vec!["?"; vals.len()].join(","));
            args.extend(vals.into_iter().map(Sql::Text));
        }
    }
    (sql, args)
}

/// Turn bare `?` into `?N` so the MATCH arg (`?1`) and filters can coexist.
fn renumber(sql: &str) -> String {
    let has_match = sql.contains("?1 AND");
    let mut n = if has_match { 1 } else { 0 };
    let mut out = String::with_capacity(sql.len() + 16);
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '?' && !chars.peek().map(|d| d.is_ascii_digit()).unwrap_or(false) {
            n += 1;
            out.push_str(&format!("?{n}"));
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn library() -> (tempfile_dir::Dir, Ctx) {
        let dir = tempfile_dir::Dir::new();
        let paths = MemoryPaths::at(&dir.0);
        let conn = store::open(&paths).unwrap();
        let app = store::upsert_application(&conn, "com.example.editor", "1", "Editor")
            .unwrap()
            .id;
        conn.execute(
            "UPDATE application SET dominant_color = 255, icon_path = 'icons/e.png' WHERE id = ?1",
            [app],
        )
        .unwrap();
        std::fs::write(paths.icons_dir().join("e.png"), b"png").unwrap();
        let dom = store::upsert_domain(&conn, "docs.example.com").unwrap();
        conn.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (1, ?1, ?2, 'https://docs.example.com/a')", params![app, dom]).unwrap();
        // 5 frames, 2 s apart; frame 1 lives in a video chunk, frame 2 is a removed chunk, rest are stills.
        std::fs::write(
            paths.videos_dir().join("chunk.mp4"),
            (0u8..=255).collect::<Vec<_>>(),
        )
        .unwrap();
        conn.execute("INSERT INTO video(height, width, path, num_frames, status) VALUES (10, 10, 'chunk.mp4', 2, 0)", []).unwrap();
        conn.execute("INSERT INTO video(height, width, path, num_frames, status) VALUES (10, 10, 'gone.mp4', 2, 2)", []).unwrap();
        for i in 0..5i64 {
            let (video, idx, still): (Option<i64>, Option<i64>, Option<&str>) = match i {
                0 => (Some(1), Some(0), None),
                1 => (Some(2), Some(0), None),
                _ => (None, None, Some("frames/f.jpg")),
            };
            conn.execute(
                "INSERT INTO frame(timestamp, video, video_index, image_path, width, height, foreground, background, title, segment, ocr_status)
                 VALUES (?1, ?2, ?3, ?4, 200, 100, ?5, 'sidebar', 'Title', 1, 1)",
                params![1_000_000 + i * 2000, video, idx, still, if i == 3 { "webhook signature verified" } else { "hello world" }],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (4, 10, 20, 100, 12, 8, 9)", []).unwrap();
        (dir, Ctx::new(paths))
    }

    mod tempfile_dir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let p =
                    std::env::temp_dir().join(format!("kmem-ui-test-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn get(ctx: &Ctx, uri: &str) -> Value {
        let r = ctx.handle("GET", uri, None, &[]);
        assert_eq!(r.status, 200, "{uri}: {}", String::from_utf8_lossy(&r.body));
        serde_json::from_slice(&r.body).unwrap()
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=0-999", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
    }

    #[test]
    fn video_range_returns_206_with_content_range() {
        let (_d, ctx) = library();
        let r = ctx.handle("GET", "/media/video/chunk.mp4", Some("bytes=10-19"), &[]);
        assert_eq!(r.status, 206);
        assert_eq!(r.body, (10u8..=19).collect::<Vec<_>>());
        assert!(r
            .headers
            .contains(&("Content-Range".into(), "bytes 10-19/256".into())));
        let full = ctx.handle("GET", "/media/video/chunk.mp4", None, &[]);
        assert_eq!((full.status, full.body.len()), (200, 256));
        let bad = ctx.handle("GET", "/media/video/chunk.mp4", Some("bytes=300-"), &[]);
        assert_eq!(bad.status, 416);
        assert_eq!(
            ctx.handle("GET", "/media/video/../memory.db", None, &[])
                .status,
            400
        );
        assert_eq!(
            ctx.handle("GET", "/media/video/%2e%2e/memory.db", None, &[])
                .status,
            400
        );
    }

    #[test]
    fn brand_tokens_are_served() {
        let (_d, ctx) = library();
        let tokens = ctx.handle("GET", "/brand/tokens.css", None, &[]);
        assert_eq!(
            (tokens.status, tokens.content_type.as_str()),
            (200, "text/css; charset=utf-8")
        );
        assert!(String::from_utf8_lossy(&tokens.body).contains("--font-sans-system"));
    }

    #[test]
    fn keep_local_hours_round_trips_through_settings_without_touching_other_sync_fields() {
        let (_d, ctx) = library();
        let before = get(&ctx, "/api/settings")["settings"]["sync"].clone();
        assert_eq!(before["keep_local_hours"], 0, "the default is cloud only");
        let r = ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"sync":{"keep_local_hours":168}}"#,
        );
        assert_eq!(r.status, 200);
        let after = get(&ctx, "/api/settings")["settings"]["sync"].clone();
        assert_eq!(after["keep_local_hours"], 168);
        for k in [
            "enabled",
            "endpoint",
            "region",
            "bucket",
            "prefix",
            "path_style",
            "cache_mb",
        ] {
            assert_eq!(after[k], before[k], "sync.{k} is untouched");
        }
        for h in [0u64, 1, 24, 720, 36] {
            let body = format!(r#"{{"sync":{{"keep_local_hours":{h}}}}}"#);
            assert_eq!(
                ctx.handle("POST", "/api/settings", None, body.as_bytes())
                    .status,
                200
            );
            assert_eq!(
                get(&ctx, "/api/settings")["settings"]["sync"]["keep_local_hours"],
                h
            );
        }
        // A non-number is refused and the stored value stays.
        let bad = ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"sync":{"keep_local_hours":"soon"}}"#,
        );
        assert_ne!(bad.status, 200);
        assert_eq!(
            get(&ctx, "/api/settings")["settings"]["sync"]["keep_local_hours"],
            36
        );
    }

    #[test]
    fn remote_only_video_is_served_from_the_sync_cache() {
        let (_d, ctx) = library();
        let cache = super::super::super::sync::cache_dir(&ctx.paths);
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("remote.mp4"), vec![7u8; 64]).unwrap();
        let r = ctx.handle("GET", "/media/video/remote.mp4", Some("bytes=0-9"), &[]);
        assert_eq!((r.status, r.body.len()), (206, 10));
        assert_eq!(
            ctx.handle("GET", "/media/video/absent.mp4", None, &[])
                .status,
            404
        );
        assert_eq!(
            ctx.handle("GET", "/media/video/../sync-credentials.json", None, &[])
                .status,
            400
        );
    }

    #[test]
    fn frame_detail_has_media_kinds_and_ocr_text() {
        let (_d, ctx) = library();
        let v = get(&ctx, "/api/frame/1");
        assert_eq!(v["media"]["kind"], "video");
        assert_eq!(v["media"]["url"], "/media/video/chunk.mp4");
        assert_eq!(v["app"]["name"], "Editor");
        assert_eq!(v["domain"]["name"], "docs.example.com");
        assert_eq!(v["url"], "https://docs.example.com/a");
        assert_eq!(get(&ctx, "/api/frame/2")["media"]["kind"], "removed");
        assert_eq!(get(&ctx, "/api/frame/3")["media"]["kind"], "missing"); // still file not on disk
        let f = get(&ctx, "/api/frame/4");
        assert_eq!(f["boxes"][0]["text"], "signature");
        assert_eq!(f["boxes"][0]["w"], 100);
    }

    #[test]
    fn nearest_steps_and_segment_runs() {
        let (_d, ctx) = library();
        assert_eq!(get(&ctx, "/api/nearest?t=1003500")["id"], 3);
        assert_eq!(get(&ctx, "/api/nearest?t=1002000&dir=1")["id"], 3);
        assert_eq!(get(&ctx, "/api/nearest?t=1004000&dir=-1&n=2")["id"], 1);
        assert!(get(&ctx, "/api/nearest?t=1008000&dir=1")["id"].is_null());
        let s = get(&ctx, "/api/segments?from=0&to=2000000");
        assert_eq!(s["segments"].as_array().unwrap().len(), 1);
        assert_eq!(s["segments"][0]["s"], 1_000_000);
        assert_eq!(s["segments"][0]["e"], 1_008_000);
        assert_eq!(s["segments"][0]["app"]["bundle"], "com.example.editor");
    }

    #[test]
    fn segments_merge_same_app_and_keep_removed_video_frames() {
        let (_d, ctx) = library();
        {
            let conn = store::open(&ctx.paths).unwrap();
            let app: i64 = conn
                .query_row("SELECT id FROM application LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let other = store::upsert_application(&conn, "com.example.other", "1", "Other")
                .unwrap()
                .id;
            let dom: i64 = conn
                .query_row("SELECT id FROM domain LIMIT 1", [], |r| r.get(0))
                .unwrap();
            let dom2 = store::upsert_domain(&conn, "video.example.com").unwrap();
            conn.execute("UPDATE domain SET dominant_color = 16711680, icon_path = 'icons/v.ico' WHERE id = ?1", [dom2]).unwrap();
            // Segment 2: same app and domain, other page. 3: another app. 4: first run again after a long idle gap.
            // 5: same app, other domain.
            for (a, d) in [
                (app, Some(dom)),
                (other, None),
                (app, Some(dom)),
                (app, Some(dom2)),
            ] {
                conn.execute(
                    "INSERT INTO segment(start_frame_id, application, domain) VALUES (1, ?1, ?2)",
                    params![a, d],
                )
                .unwrap();
            }
            let ins = |t: i64, seg: i64| {
                conn.execute(
                    "INSERT INTO frame(timestamp, image_path, width, height, segment, ocr_status) VALUES (?1, 'frames/f.jpg', 200, 100, ?2, 1)",
                    params![t, seg],
                )
                .unwrap();
            };
            ins(1_010_000, 2); // same app, new segment: merges with 1_000_000..1_008_000
            ins(1_012_000, 3); // other app
            ins(1_014_000, 5); // same app, other domain: a new run, keyed by the domain
            ins(1_500_000, 4); // same app as the first run, 8 min later: stays separate
        }
        let s = get(&ctx, "/api/segments?from=0&to=2000000");
        let runs = s["segments"].as_array().unwrap();
        let span: Vec<(i64, i64)> = runs
            .iter()
            .map(|r| (r["s"].as_i64().unwrap(), r["e"].as_i64().unwrap()))
            .collect();
        // Frames 1 and 2 sit in a removed video (status 2) and still count.
        assert_eq!(
            span,
            vec![
                (1_000_000, 1_010_000),
                (1_012_000, 1_012_000),
                (1_014_000, 1_014_000),
                (1_500_000, 1_500_000)
            ]
        );
        assert_eq!(runs[0]["frame"], 1);
        assert_eq!(runs[1]["app"]["bundle"], "com.example.other");
        assert!(
            runs[1]["app"]["color"].is_null(),
            "an app without a dominant color is still returned"
        );
        assert_eq!(
            runs[2]["k"].as_str().unwrap().chars().next(),
            Some('d'),
            "browser runs are keyed by domain"
        );
        assert_eq!(runs[1]["k"].as_str().unwrap().chars().next(), Some('a'));
        assert_eq!(runs[2]["domain"]["color"], 16711680);
        assert_eq!(runs[2]["domain"]["icon"], true);
        assert_eq!(runs[2]["app"]["bundle"], "com.example.editor");
    }

    #[test]
    fn segments_cover_frames_added_after_an_earlier_read() {
        // The UI re-reads the window as the recorder adds frames; the API holds no cache.
        let (_d, ctx) = library();
        let before = get(&ctx, "/api/segments?from=0&to=2000000");
        assert_eq!(before["segments"][0]["e"], 1_008_000);
        let conn = store::open(&ctx.paths).unwrap();
        conn.execute("INSERT INTO frame(timestamp, image_path, width, height, segment, ocr_status) VALUES (1010000, 'frames/f.jpg', 200, 100, 1, 1)", []).unwrap();
        let after = get(&ctx, "/api/segments?from=0&to=2000000");
        assert_eq!(after["segments"][0]["e"], 1_010_000);
    }

    #[test]
    fn search_filters_snippets_and_heatmap() {
        let (_d, ctx) = library();
        let r = get(&ctx, "/api/search?q=signature");
        assert_eq!(r["results"].as_array().unwrap().len(), 1);
        assert_eq!(r["results"][0]["id"], 4);
        assert!(r["results"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains('\u{1}'));
        // syntax error falls back to quoted terms instead of failing
        assert_eq!(
            get(&ctx, "/api/search?q=%22unterminated")["results"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            get(
                &ctx,
                "/api/search?q=hello&app=com.example.editor&domain=docs.example.com"
            )["total"],
            1
        );
        assert_eq!(get(&ctx, "/api/search?q=hello&app=com.other")["total"], 0);
        assert_eq!(get(&ctx, "/api/search?q=hello&from=2000000")["total"], 0);
        let h = get(&ctx, "/api/heatmap?tz=0&q=signature");
        assert_eq!(h["days"][0][1], 1);
        assert_eq!(h["days"][0][0], 1_000_000 / 1000 / 86400);
        assert_eq!(
            get(&ctx, "/api/apps")["apps"][0]["bundle"],
            "com.example.editor"
        );
        assert_eq!(
            get(&ctx, "/api/domains")["domains"][0]["name"],
            "docs.example.com"
        );
        assert_eq!(
            ctx.handle("GET", "/media/icon/app/1", None, &[]).body,
            b"png"
        );
    }

    #[test]
    fn settings_merge_persists() {
        let (_d, ctx) = library();
        let r = ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"recording_enabled": false, "storage": {"limit_gb": 12.5}}"#,
        );
        assert_eq!(r.status, 200);
        let s = Settings::load(&ctx.paths);
        assert!(!s.recording_enabled);
        assert_eq!(s.storage.limit_gb, 12.5);
        assert_eq!(
            s.storage.cap_action, "delete",
            "untouched nested fields survive"
        );
        assert_eq!(
            ctx.handle("POST", "/api/settings", None, br#"{"interval_ms": "x"}"#)
                .status,
            400
        );
        assert_eq!(
            get(&ctx, "/api/settings")["settings"]["storage"]["limit_gb"],
            12.5
        );
    }

    #[test]
    fn settings_resolution_presets_round_trip() {
        let (_d, ctx) = library();
        let g = get(&ctx, "/api/settings");
        assert_eq!(g["resolution"], "1440p");
        assert_eq!(g["resolution_presets"].as_array().unwrap().len(), 4);
        assert_eq!(
            g["resolution_presets"][1],
            json!({"name": "1080p", "max_width": 1920, "max_height": 1080})
        );
        let r = ctx.handle("POST", "/api/settings", None, br#"{"resolution": "1080p"}"#);
        assert_eq!(r.status, 200);
        let s = Settings::load(&ctx.paths);
        assert_eq!((s.max_width, s.max_height), (1920, 1080));
        assert_eq!(get(&ctx, "/api/settings")["resolution"], "1080p");
        assert!(
            !s.extra.contains_key("resolution"),
            "the preset name is not stored"
        );
        // Custom values keep working, and win over a preset in the same request.
        ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"max_width": 1600, "max_height": 900}"#,
        );
        assert_eq!(get(&ctx, "/api/settings")["resolution"], "custom");
        ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"resolution": "4k", "max_width": 3000}"#,
        );
        let s = Settings::load(&ctx.paths);
        assert_eq!((s.max_width, s.max_height), (3000, 2160));
        assert_eq!(
            ctx.handle("POST", "/api/settings", None, br#"{"resolution": "8k"}"#)
                .status,
            500
        );
        assert_eq!(
            Settings::load(&ctx.paths).max_width,
            3000,
            "a bad name changes nothing"
        );
        // The new storage and capture settings come through the same merge.
        ctx.handle(
            "POST",
            "/api/settings",
            None,
            br#"{"capture_on_change": false, "storage": {"reserve_mb": 0}}"#,
        );
        let s = Settings::load(&ctx.paths);
        assert!(!s.capture_on_change);
        assert_eq!(s.storage.reserve_mb, 0);
    }

    #[test]
    fn privacy_setting_round_trips_through_the_ui_api() {
        let (_d, ctx) = library();
        assert_eq!(
            get(&ctx, "/api/settings")["settings"]["privacy"]["redact_pii"],
            false
        );
        for enabled in [true, false] {
            let body = serde_json::to_vec(&json!({"privacy": {"redact_pii": enabled}})).unwrap();
            assert_eq!(ctx.handle("POST", "/api/settings", None, &body).status, 200);
            assert_eq!(Settings::load(&ctx.paths).privacy.redact_pii, enabled);
            assert_eq!(
                get(&ctx, "/api/settings")["settings"]["privacy"]["redact_pii"],
                enabled
            );
        }
    }
    /// A Ctx on an empty scratch library.
    fn bare() -> (tempfile_dir::Dir, Ctx) {
        std::env::set_var(sync::crypt::KEY_STORE_ENV, "file");
        let dir = tempfile_dir::Dir::new();
        let mut ctx = Ctx::new(MemoryPaths::at(dir.0.join("lib")));
        ctx.paths.ensure().unwrap();
        ctx.open_browser = false;
        (dir, ctx)
    }

    fn post(ctx: &Ctx, uri: &str, body: Value) -> (u16, Value) {
        let r = ctx.handle("POST", uri, None, body.to_string().as_bytes());
        (
            r.status,
            serde_json::from_slice(&r.body).unwrap_or(Value::Null),
        )
    }

    /// One valid, non-default value for every settable key. A key added to
    /// `Settings` without a row here, and without a control in the window, fails.
    const EVERY_SETTING: &[(&str, &str)] = &[
        ("recording_enabled", "false"),
        ("paused_until_ms", "4102444800000"),
        ("interval_ms", "3000"),
        ("capture_on_change", "false"),
        ("max_height", "1080"),
        ("max_width", "1920"),
        ("staging_quality", "0.6"),
        ("video_quality", "0.7"),
        ("chunk_max_frames", "60"),
        ("pause_on_inactivity", "false"),
        ("inactivity_seconds", "30"),
        ("ocr_level", r#""fast""#),
        ("ocr_languages", r#"["en-US", "de-DE"]"#),
        ("ax_enabled", "false"),
        ("privacy.redact_pii", "true"),
        ("privacy.use_local_model", "false"),
        ("audio.enabled", "true"),
        ("audio.microphone", "false"),
        ("audio.system_audio", "false"),
        ("audio.input_device", r#""BuiltInMicrophoneDevice""#),
        ("audio.transcribe", "true"),
        ("excluded_bundle_ids", r#"["com.example.a"]"#),
        ("excluded_domains", r#"["example.com"]"#),
        ("enabled_exclusion_groups", r#"["banking"]"#),
        ("exclude_private_browsing", "false"),
        ("record_only_included", "true"),
        ("included_bundle_ids", r#"["com.tinyspeck.slackmacgap"]"#),
        ("included_domains", r#"["github.com"]"#),
        ("record_unknown_bundle_ids", "true"),
        ("storage.management_mode", r#""retention""#),
        ("storage.limit_gb", "20.5"),
        ("storage.cap_action", r#""downscale""#),
        ("storage.retention_days", "30"),
        ("storage.retention_action", r#""delete""#),
        ("storage.archived_scale", "0.5"),
        ("storage.min_free_gb", "2.0"),
        ("storage.reserve_mb", "250"),
        ("sync.enabled", "true"),
        ("sync.provider", r#""kortix""#),
        ("sync.s3.endpoint", r#""http://127.0.0.1:9000""#),
        ("sync.s3.region", r#""eu-west-1""#),
        ("sync.s3.bucket", r#""b""#),
        ("sync.s3.prefix", r#""p""#),
        ("sync.s3.path_style", "true"),
        ("sync.kortix.url", r#""https://issuer.example.com""#),
        ("sync.keep_local_hours", "24"),
        ("sync.cache_mb", "2048"),
        ("sync.concurrency", "4"),
        ("sync.max_upload_kbps", "500"),
        ("sync.part_mb", "32"),
        ("sync.remote_retention_days", "90"),
        ("sync.encrypt", "true"),
        ("sync.key_id", r#""k1""#),
        ("airgap", "true"),
        ("launch_at_login", "false"),
        ("experimental.privacy_controls", "true"),
        ("shortcuts.open_timeline", r#""CmdOrCtrl+Shift+T""#),
        ("shortcuts.open_search", r#""""#),
        ("agent_routing.agent", r#""codex""#),
        ("agent_routing.terminal", r#""Terminal""#),
    ];

    /// The settings the window has a control for (the six sections of Settings).
    const WINDOW_SETTINGS: &[&str] = &[
        "recording_enabled",
        "paused_until_ms",
        "audio.enabled",
        "enabled_exclusion_groups",
        "exclude_private_browsing",
        "excluded_bundle_ids",
        "excluded_domains",
        "record_only_included",
        "included_bundle_ids",
        "included_domains",
        "storage.management_mode",
        "storage.cap_action",
        "storage.retention_days",
        "storage.retention_action",
        "launch_at_login",
        "experimental.privacy_controls",
        "interval_ms",
        "max_width",
        "max_height",
        "ocr_level",
    ];
    /// Written through a helper under another name (the resolution select, the keep choice).
    const WINDOW_ONLY_VIA_HELPER: &[&str] = &["max_width", "max_height"];

    fn leaves(v: &Value, at: &str, out: &mut Vec<String>) {
        match v.as_object() {
            Some(o) if !o.is_empty() => {
                for (k, x) in o {
                    leaves(
                        x,
                        &if at.is_empty() {
                            k.clone()
                        } else {
                            format!("{at}.{k}")
                        },
                        out,
                    );
                }
            }
            _ => out.push(at.to_string()),
        }
    }

    #[test]
    fn every_setting_round_trips_through_the_window_api_and_has_a_control() {
        let mut keys = Vec::new();
        leaves(
            &serde_json::to_value(Settings::default()).unwrap(),
            "",
            &mut keys,
        );
        for k in &keys {
            assert!(
                EVERY_SETTING.iter().any(|(p, _)| *p == k),
                "{k} has no row in EVERY_SETTING"
            );
        }
        for (path, raw) in EVERY_SETTING {
            let (_d, ctx) = bare();
            let value: Value = serde_json::from_str(raw).unwrap();
            let mut patch = value.clone();
            for part in path.rsplit('.') {
                patch = json!({ part: patch });
            }
            let (status, body) = post(&ctx, "/api/settings", patch);
            assert_eq!(status, 200, "{path}: {body}");
            let mut got = &get(&ctx, "/api/settings")["settings"];
            for part in path.split('.') {
                got = &got[part];
            }
            assert_eq!(got, &value, "{path} reads back");
            // The window shows only what a person needs; every other setting stays
            // in settings.json and the CLI (`kortix-capture settings`).
            let leaf = path.rsplit('.').next().unwrap();
            if WINDOW_SETTINGS.contains(&path) {
                assert!(
                    APP_JS.contains(leaf) || WINDOW_ONLY_VIA_HELPER.contains(&path),
                    "the settings window has no control for {path}"
                );
            }
        }
    }

    #[test]
    fn onboarding_shows_on_a_fresh_personal_install_until_connected_or_skipped() {
        let (_d, ctx) = bare();
        if super::super::super::managed::machine_service_installed() {
            return; // an IT-configured computer has no onboarding
        }
        assert_eq!(get(&ctx, "/api/app")["onboarding"], true);
        let (status, _) = post(&ctx, "/api/app/onboarding", json!({"state": "fresh"}));
        assert_eq!(status, 400, "only done or skipped can be set");
        let (status, _) = post(&ctx, "/api/app/onboarding", json!({"state": "skipped"}));
        assert_eq!(status, 200);
        assert_eq!(get(&ctx, "/api/app")["onboarding"], false, "skip is remembered");
        // Signing out brings it back on the next open.
        cli::sync_sign_out(&ctx.paths).unwrap();
        assert_eq!(get(&ctx, "/api/app")["onboarding"], true);
        // Connected: no onboarding.
        let mut s = Settings::load(&ctx.paths);
        s.sync.enabled = true;
        s.save(&ctx.paths).unwrap();
        assert_eq!(get(&ctx, "/api/app")["onboarding"], false);
    }

    #[test]
    fn a_personal_install_is_not_managed_and_needs_no_account() {
        let (_d, ctx) = bare();
        let app = get(&ctx, "/api/app");
        assert_eq!(app["managed"], false);
        assert_eq!(app["signed_in"], false);
        assert!(app.get("welcome_done").is_none(), "there is no welcome screen");
        // The window has no welcome page and no start-recording action.
        assert!(!APP_JS.contains("welcome"));
        assert_eq!(ctx.handle("POST", "/api/app/start", None, b"{}").status, 404);
    }

    #[test]
    fn sync_is_off_by_default_and_says_what_a_switch_does() {
        let (_d, ctx) = bare();
        let s = get(&ctx, "/api/sync");
        assert_eq!(s["view"]["destination"], "off");
        assert_eq!(s["view"]["line"], "Off. Recordings stay on this computer.");
        assert_eq!(s["view"]["tone"], "off");
        assert_eq!(s["switch_rule"], sync::view::SWITCH_RULE);
    }

    #[test]
    fn window_errors_are_one_plain_sentence() {
        let (_d, ctx) = bare();
        // No endpoint: the probe cannot run. The person reads a sentence, never a flag name or a cause chain.
        let (status, body) = post(
            &ctx,
            "/api/sync/setup",
            json!({"provider": "s3", "endpoint": "nope", "bucket": "b", "access_key_id": "a", "secret_access_key": "b"}),
        );
        assert_eq!(status, 400);
        let msg = body["error"].as_str().unwrap();
        assert_eq!(msg, "The endpoint is not a valid address.", "{msg}");
        // Sync stays off after a failed setup.
        assert_eq!(get(&ctx, "/api/sync")["view"]["destination"], "off");
    }

    #[test]
    fn the_window_reads_the_app_and_its_icon() {
        let (_d, ctx) = bare();
        let app = get(&ctx, "/api/app");
        assert_eq!(app["signed_in"], false);
        assert_eq!(app["managed"], false);
        assert!(app["version"].as_str().is_some_and(|v| !v.is_empty()));
        assert!(app["state"].is_string());
        let icon = ctx.handle("GET", "/brand/app-icon.png", None, &[]);
        assert_eq!(icon.status, 200);
        assert_eq!(icon.content_type, "image/png");
        assert_eq!(&icon.body[1..4], b"PNG");
    }

    #[test]
    fn invalid_settings_are_refused_like_the_cli_and_nothing_changes() {
        let (_d, ctx) = bare();
        for (patch, says) in [
            (json!({"sync": {"concurrency": 9}}), "sync.concurrency"),
            (json!({"sync": {"part_mb": 4}}), "sync.part_mb"),
            (json!({"sync": {"provider": "ftp"}}), "sync.provider"),
            (
                json!({"sync": {"provider": "kortix", "encrypt": true}}),
                "kortix provider",
            ),
            (
                json!({"sync": {"provider": "control-plane"}}),
                "sync.provider",
            ),
            (json!({"ocr_level": "best"}), "ocr_level"),
            (json!({"staging_quality": 0}), "staging_quality"),
            (json!({"video_quality": 1.5}), "video_quality"),
            (json!({"interval_ms": 100}), "interval_ms"),
            (json!({"chunk_max_frames": 0}), "chunk_max_frames"),
            (
                json!({"enabled_exclusion_groups": ["nope"]}),
                "enabled_exclusion_groups",
            ),
            (
                json!({"storage": {"management_mode": "never"}}),
                "storage.management_mode",
            ),
            (
                json!({"storage": {"archived_scale": 0}}),
                "storage.archived_scale",
            ),
            (json!({"storage": {"limit_gb": 0}}), "storage.limit_gb"),
            (
                json!({"sync": {"keep_local_hours": -1}}),
                "invalid settings",
            ),
        ] {
            let (status, body) = post(&ctx, "/api/settings", patch.clone());
            assert_eq!(status, 400, "{patch}");
            assert!(
                body["error"].as_str().unwrap().contains(says),
                "{patch}: {body}"
            );
        }
        assert_eq!(Settings::load(&ctx.paths), Settings::default());
    }

    #[test]
    fn nested_sync_fields_merge_without_dropping_siblings() {
        let (_d, ctx) = bare();
        post(
            &ctx,
            "/api/settings",
            json!({"sync": {"s3": {"endpoint": "http://127.0.0.1:9000", "bucket": "b"}}}),
        );
        let (status, _) = post(
            &ctx,
            "/api/settings",
            json!({"sync": {"s3": {"prefix": "x"}}}),
        );
        assert_eq!(status, 200);
        let s = Settings::load(&ctx.paths);
        assert_eq!(
            (
                s.sync.s3.endpoint.as_str(),
                s.sync.s3.bucket.as_str(),
                s.sync.s3.prefix.as_str()
            ),
            ("http://127.0.0.1:9000", "b", "x")
        );
    }

    #[test]
    fn s3_secrets_are_write_only() {
        let (_d, ctx) = bare();
        sync::save_credentials(
            &ctx.paths,
            &sync::SyncCredentials {
                access_key_id: "AKIDSYNTHETIC".into(),
                secret_access_key: "synthetic-secret-value".into(),
                session_token: Some("synthetic-session-token".into()),
            },
        )
        .unwrap();
        let r = ctx.handle("GET", "/api/sync", None, &[]);
        let text = String::from_utf8_lossy(&r.body).to_string();
        assert_eq!(r.status, 200);
        assert!(
            !text.contains("synthetic-secret-value") && !text.contains("synthetic-session-token"),
            "{text}"
        );
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["credentials"]["saved"], true);
        assert_eq!(v["credentials"]["access_key_id"], "AKIDSYNTHETIC");
        assert_eq!(v["credentials"]["session_token"], true);
        // A blank secret reuses the saved one: the probe reaches the network (port 1 refuses).
        let form = json!({"endpoint": "http://127.0.0.1:1", "bucket": "b", "path_style": true});
        let (status, body) = post(&ctx, "/api/sync/test", form.clone());
        assert_eq!(status, 400);
        let err = body["error"].as_str().unwrap();
        assert!(
            !err.contains("nter the") && !err.contains("synthetic-"),
            "{err}"
        );
        // Another access key id needs its own secret.
        let mut other = form.clone();
        other["access_key_id"] = json!("AKIDOTHER");
        let (status, body) = post(&ctx, "/api/sync/test", other);
        assert_eq!(
            (status, body["error"].as_str().unwrap()),
            (400, "Enter the secret access key.")
        );
        // Setup against an unreachable endpoint fails and saves nothing.
        let (status, _) = post(&ctx, "/api/sync/setup", form);
        assert_eq!(status, 400);
        assert!(!Settings::load(&ctx.paths).sync.enabled);
    }

    #[test]
    fn kortix_sign_in_policy_and_sign_out_show_in_the_window() {
        let (_d, ctx) = bare();
        let v = get(&ctx, "/api/sync");
        assert_eq!(v["status"]["kortix"]["signed_in"], false);
        // A registration as sign-in leaves it (synthetic values), the token in the file store.
        std::fs::write(
            ctx.paths.root.join("sync-issuer.json"),
            json!({"issuer": "https://issuer.example", "prefix": "orgs/o/projects/p", "device_id": "dev_test",
                   "member_email": "person@example.com", "signed_in_at_ms": 1}).to_string(),
        )
        .unwrap();
        std::fs::write(
            ctx.paths.root.join("sync-device-token"),
            "synthetic-device-token",
        )
        .unwrap();
        post(
            &ctx,
            "/api/settings",
            json!({"sync": {"provider": "kortix", "enabled": true}, "audio": {"enabled": true}}),
        );
        // The operator's policy turns audio and actions off and shows a notice.
        std::fs::write(
            crate::memory::policy::path(&ctx.paths),
            json!({"source": "orgs/o/projects/p/policy.json", "fetched_at_ms": 1,
                   "policy": {"layers": {"audio": false, "actions": false}, "notice": "Recorded for support"}}).to_string(),
        )
        .unwrap();
        let r = ctx.handle("GET", "/api/sync", None, &[]);
        assert!(!String::from_utf8_lossy(&r.body).contains("synthetic-device-token"));
        let v = serde_json::from_slice::<Value>(&r.body).unwrap();
        let k = &v["status"]["kortix"];
        assert_eq!(
            (
                k["signed_in"].as_bool(),
                k["member_email"].as_str(),
                k["device_id"].as_str()
            ),
            (Some(true), Some("person@example.com"), Some("dev_test"))
        );
        assert_eq!(v["status"]["device_id"], "dev_test");
        assert_eq!(
            v["status"]["policy"]["policy"]["notice"],
            "Recorded for support"
        );
        assert_eq!(v["layers"]["audio"]["blocked_by"], "policy_off");
        assert_eq!(v["layers"]["actions"]["blocked_by"], "policy_off");
        assert_eq!(v["layers"]["screen"]["on"], true);
        // The person's own setting is untouched; the policy only narrows what runs.
        assert_eq!(
            get(&ctx, "/api/settings")["settings"]["audio"]["enabled"],
            true
        );
        // Encryption is refused for Kortix.
        assert_eq!(post(&ctx, "/api/sync/encrypt", json!({"on": true})).0, 400);
        let (status, v) = post(&ctx, "/api/kortix/disconnect", json!({}));
        assert_eq!((status, v["enabled"].as_bool()), (200, Some(false)));
        assert!(!ctx.paths.root.join("sync-issuer.json").exists());
        assert!(!ctx.paths.root.join("sync-device-token").exists());
        assert_eq!(
            get(&ctx, "/api/sync")["status"]["kortix"]["signed_in"],
            false
        );
    }

    fn wait_job(ctx: &Ctx, name: &str) -> Value {
        for _ in 0..200 {
            let j = get(ctx, "/api/sync")["jobs"][name].clone();
            if j["running"] == false {
                return j;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("{name} did not finish");
    }

    #[test]
    fn long_actions_run_as_jobs_and_report_errors() {
        let (_d, ctx) = bare();
        let (status, v) = post(&ctx, "/api/sync/now", json!({}));
        assert_eq!((status, v["running"].as_bool()), (200, Some(true)));
        let j = wait_job(&ctx, "now");
        assert_eq!(j["ok"], false);
        assert_eq!(j["error"], "Sync is off.");
        // Connect starts the device grant at the given issuer; port 1 refuses it.
        post(
            &ctx,
            "/api/kortix/connect",
            json!({"issuer": "http://127.0.0.1:1"}),
        );
        let j = wait_job(&ctx, "connect");
        assert_eq!(j["error"], "Could not reach Kortix to start sign-in.", "{j}");
        assert!(!ctx.paths.root.join("sync-issuer.json").exists());
    }

    #[test]
    fn encryption_key_turns_on_exports_and_imports() {
        let (_d, ctx) = bare();
        assert_eq!(
            post(&ctx, "/api/sync/key/export", json!({})).1["error"],
            "No encryption key yet."
        );
        let (status, on) = post(&ctx, "/api/sync/encrypt", json!({"on": true}));
        assert_eq!(status, 200, "{on}");
        let id = on["key_id"].as_str().unwrap().to_string();
        let (_, exported) = post(&ctx, "/api/sync/key/export", json!({}));
        assert_eq!(exported["key_id"], id.as_str());
        let (_d2, other) = bare();
        let (status, imported) = post(
            &other,
            "/api/sync/key/import",
            json!({"key": exported["key"]}),
        );
        assert_eq!(
            (status, imported["key_id"].as_str()),
            (200, Some(id.as_str()))
        );
        assert!(Settings::load(&other.paths).sync.encrypt);
        assert_eq!(
            post(&other, "/api/sync/key/import", json!({"key": "not-a-key"})).0,
            400
        );
        let (_, off) = post(&ctx, "/api/sync/encrypt", json!({"on": false}));
        assert_eq!(
            (off["encrypt"].as_bool(), off["key_id"].as_str()),
            (Some(false), Some(id.as_str()))
        );
    }

    #[test]
    fn forget_previews_then_deletes_a_range() {
        let (_d, ctx) = library();
        let tr = |a: i64, b: i64| {
            let f = |ms: i64| {
                chrono::DateTime::from_timestamp_millis(ms)
                    .unwrap()
                    .with_timezone(&chrono::Local)
                    .format("%Y-%m-%dT%H:%M:%S")
                    .to_string()
            };
            format!("{}|{}", f(a), f(b))
        };
        let range = tr(1_003_000, 1_009_000); // the three still frames
        let (status, dry) = post(&ctx, "/api/storage/forget", json!({"tr": range}));
        assert_eq!(
            (status, dry["dry_run"].as_bool()),
            (200, Some(true)),
            "{dry}"
        );
        assert!(dry["frames"].as_u64().unwrap() >= 1);
        assert_eq!(
            get(&ctx, "/api/bounds")["count"],
            5,
            "a dry run deletes nothing"
        );
        let (status, done) = post(
            &ctx,
            "/api/storage/forget",
            json!({"tr": range, "yes": true}),
        );
        assert_eq!((status, done["dry_run"].as_bool()), (200, Some(false)));
        assert!(get(&ctx, "/api/bounds")["count"].as_i64().unwrap() < 5);
        let (status, bad) = post(&ctx, "/api/storage/forget", json!({"tr": "whenever"}));
        assert_eq!(status, 400, "{bad}");
    }

    #[test]
    fn audio_segments_play_with_ranges_and_spoken_words_are_searchable() {
        let (_d, ctx) = library();
        {
            let conn = store::open(&ctx.paths).unwrap();
            std::fs::create_dir_all(ctx.paths.audio_dir()).unwrap();
            std::fs::write(ctx.paths.audio_dir().join("1000000.m4a"), vec![5u8; 300]).unwrap();
            conn.execute("INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources) VALUES (1000000, 1060000, '1000000.m4a', 300, 'microphone,system')", []).unwrap();
            conn.execute("INSERT INTO audio(start_ms, end_ms, path, status) VALUES (2000000, 2060000, 'gone.m4a', 2)", []).unwrap();
            conn.execute("INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (1, 1003000, 1005000, 'the zebrafish quarterly report')", []).unwrap();
        }
        let a = get(&ctx, "/api/audio?from=0&to=3000000");
        assert_eq!(
            a["segments"].as_array().unwrap().len(),
            1,
            "deleted segments are not on the timeline"
        );
        assert_eq!(a["segments"][0]["url"], "/media/audio/1");
        assert_eq!(a["segments"][0]["s"], 1_000_000);
        let r = ctx.handle("GET", "/media/audio/1", Some("bytes=0-99"), &[]);
        assert_eq!(
            (r.status, r.body.len(), r.content_type.as_str()),
            (206, 100, "audio/mp4")
        );
        assert_eq!(ctx.handle("GET", "/media/audio/2", None, &[]).status, 404);
        // Spoken words merge into search by time, marked as audio, linked to the nearest frame.
        let s = get(&ctx, "/api/search?q=zebrafish");
        assert_eq!(s["total"], 1);
        assert_eq!(s["results"][0]["source"], "audio");
        assert_eq!(s["results"][0]["t"], 1_003_000);
        assert_eq!(s["results"][0]["id"], 2, "the frame nearest the words");
        assert!(s["results"][0]["snippet"]
            .as_str()
            .unwrap()
            .contains("\u{1}zebrafish\u{2}"));
        let s = get(&ctx, "/api/search?q=signature");
        assert_eq!(s["results"][0]["source"], "screen");
        // An app filter leaves spoken words out.
        assert_eq!(
            get(&ctx, "/api/search?q=zebrafish&app=com.example.editor")["total"],
            0
        );
        let h = get(&ctx, "/api/heatmap?q=zebrafish");
        assert_eq!(h["days"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_fresh_library_has_audio_off_and_no_audio_files_or_rows() {
        let (_d, ctx) = bare();
        let s = get(&ctx, "/api/settings");
        assert_eq!(s["settings"]["audio"]["enabled"], false);
        assert_eq!(s["settings"]["audio"]["transcribe"], false);
        assert_eq!(
            get(&ctx, "/api/audio?from=0&to=9999999999999")["segments"],
            json!([])
        );
        assert!(
            !ctx.paths.audio_dir().exists(),
            "no audio directory until audio is turned on"
        );
        assert!(!ctx.paths.audio_status().exists());
        // Both sources off while audio is on is refused, like the CLI.
        let (status, body) = post(
            &ctx,
            "/api/settings",
            json!({"audio": {"enabled": true, "microphone": false, "system_audio": false}}),
        );
        assert_eq!(status, 400, "{body}");
    }

    #[test]
    fn days_lists_recorded_local_days_newest_first() {
        use chrono::{Local, TimeZone};
        let (_d, ctx) = bare();
        let conn = store::open(&ctx.paths).unwrap();
        let at = |y, m, d, h, min, sec| {
            Local
                .with_ymd_and_hms(y, m, d, h, min, sec)
                .single()
                .unwrap()
                .timestamp_millis()
        };
        let ins = |t: i64| {
            conn.execute(
                "INSERT INTO frame(timestamp, width, height, ocr_status) VALUES (?1, 10, 10, 1)",
                [t],
            )
            .unwrap();
        };
        // 30 Sep: 23:59:58 and 23:59:59 local belong to that day, 00:00:00 to 1 Oct.
        ins(at(2026, 9, 30, 23, 59, 58));
        ins(at(2026, 9, 30, 23, 59, 59));
        ins(at(2026, 10, 1, 0, 0, 0));
        // 1 Oct: a 10 min idle gap adds nothing; two 2 s steps count.
        ins(at(2026, 10, 1, 9, 0, 0));
        ins(at(2026, 10, 1, 9, 0, 2));
        // 2 Oct has nothing. 3 Oct: one frame.
        ins(at(2026, 10, 3, 8, 30, 0));
        // Older than 365 days: left out.
        ins(at(2025, 9, 1, 12, 0, 0));
        let v = ctx.days(at(2026, 10, 3, 12, 0, 0)).unwrap();
        let v: Value = serde_json::from_slice(&v.body).unwrap();
        let days = v["days"].as_array().unwrap();
        let dates: Vec<&str> = days.iter().map(|d| d["date"].as_str().unwrap()).collect();
        assert_eq!(dates, ["2026-10-03", "2026-10-01", "2026-09-30"]);
        assert_eq!(
            (days[1]["frames"].as_i64(), days[2]["frames"].as_i64()),
            (Some(3), Some(2))
        );
        assert_eq!(days[1]["first_ms"], at(2026, 10, 1, 0, 0, 0));
        assert_eq!(
            days[1]["last_ms"],
            at(2026, 10, 1, 9, 0, 2),
            "the jump target is the day's last frame"
        );
        // 1 s across midnight + 2 s; the 9 h gap is not recorded time.
        assert_eq!(days[1]["recorded_ms"], 3000);
        // The route uses the real clock; the 2025 frame is over a year old by then too.
        assert!(get(&ctx, "/api/days")["days"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["date"] != "2025-09-01"));
    }
}
