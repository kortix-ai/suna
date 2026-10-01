//! Read-side commands: list, usage, query.
//! `now`, `grab-screen`, and `install-skill` live in `agent.rs`.

pub use super::agent::{grab_screen, install_skill, now};
use super::axrender::{self, AxMeta, AxOpts};
use super::cli::{print, Filters, FrameSelector, ListCommand, QueryCommand, TrOnly, UsageCommand};
use super::engine::Engine;
use super::paths::MemoryPaths;
use super::screen;
use super::store;
use super::tfidf;
use super::timerange::{self, TimeRange};
use anyhow::{bail, Context, Result};
use rusqlite::types::Value as Sql;
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// Recording cadence: every frame counts as 2 s of screen time.
const FRAME_SECONDS: i64 = 2;
const FROM_FRAMES: &str = "frame f LEFT JOIN segment s ON s.id = f.segment";
const COVER_MAX_FRAMES: i64 = 20_000;
const FTS_CANDIDATES: i64 = 20_000;
const MAX_FRAME_DISTANCE_MS: i64 = 60_000;
const SEPARATOR: &str = "----------------------------------------";

// ---------------------------------------------------------------- scope

/// Timerange plus resolved app/domain filters (ids into `application` / `domain`).
#[derive(Default)]
pub struct Scope {
    pub range: TimeRange,
    pub(super) apps: Option<Vec<i64>>,
    pub(super) domains: Option<Vec<i64>>,
}

impl Scope {
    pub fn new(conn: &Connection, tr: &Option<String>, apps: &[String], domains: &[String]) -> Result<Self> {
        Ok(Self {
            range: tr.as_deref().map(timerange::parse_range).transpose()?.unwrap_or_default(),
            apps: if apps.is_empty() { None } else { Some(match_apps(conn, apps)?.0) },
            domains: if domains.is_empty() { None } else { Some(match_domains(conn, domains)?.0) },
        })
    }

    fn conds(&self) -> (Vec<String>, Vec<Sql>) {
        let (mut conds, mut args) = (Vec::new(), Vec::new());
        if let Some(t) = self.range.start {
            conds.push("f.timestamp >= ?".to_string());
            args.push(Sql::Integer(t));
        }
        if let Some(t) = self.range.end {
            conds.push("f.timestamp <= ?".to_string());
            args.push(Sql::Integer(t));
        }
        for (col, ids) in [("s.application", &self.apps), ("s.domain", &self.domains)] {
            if let Some(ids) = ids {
                conds.push(format!("{col} IN ({})", vec!["?"; ids.len()].join(",")));
                args.extend(ids.iter().map(|i| Sql::Integer(*i)));
            }
        }
        (conds, args)
    }

    /// ` WHERE …` over the `f`/`s` aliases of `FROM_FRAMES`, with its parameters.
    pub(super) fn where_sql(&self) -> (String, Vec<Sql>) {
        self.where_with("", Vec::new())
    }

    /// Like `where_sql`, plus one extra condition (with its parameters, bound after the scope's).
    pub(super) fn where_with(&self, extra: &str, extra_args: Vec<Sql>) -> (String, Vec<Sql>) {
        let (mut conds, mut args) = self.conds();
        if !extra.is_empty() {
            conds.push(extra.to_string());
            args.extend(extra_args);
        }
        (if conds.is_empty() { String::new() } else { format!(" WHERE {}", conds.join(" AND ")) }, args)
    }
}

/// Bundle ids matching `value`: exact (case-insensitive), else substring of the bundle id or display name.
fn match_apps(conn: &Connection, values: &[String]) -> Result<(Vec<i64>, Vec<String>)> {
    let mut stmt = conn.prepare("SELECT id, bundle_id, COALESCE(display_name, '') FROM application")?;
    let rows: Vec<(i64, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    let (mut ids, mut bundles) = (Vec::new(), Vec::new());
    for v in values {
        let low = v.to_lowercase();
        let exact: Vec<_> = rows.iter().filter(|r| r.1.to_lowercase() == low).collect();
        let hits = if exact.is_empty() {
            rows.iter().filter(|r| r.1.to_lowercase().contains(&low) || r.2.to_lowercase().contains(&low)).collect()
        } else {
            exact
        };
        if hits.is_empty() {
            bail!("no matching applications for '{v}'. Run 'kortix-capture list applications' to see available bundle IDs.");
        }
        // Apps without a bundle id are labelled by display name.
        let mut found: Vec<String> = hits.iter().map(|r| if r.1.is_empty() { r.2.clone() } else { r.1.clone() }).collect();
        found.sort();
        found.dedup();
        if found != [v.clone()] {
            eprintln!("Auto-matched '{v}' → {}", found.join(", "));
        }
        ids.extend(hits.iter().map(|r| r.0));
        bundles.extend(found);
    }
    Ok((ids, bundles))
}

fn match_domains(conn: &Connection, values: &[String]) -> Result<(Vec<i64>, Vec<String>)> {
    let mut stmt = conn.prepare("SELECT id, normalized_domain FROM domain")?;
    let rows: Vec<(i64, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let (mut ids, mut names) = (Vec::new(), Vec::new());
    for v in values {
        let low = v.to_lowercase();
        let exact: Vec<_> = rows.iter().filter(|r| r.1 == low).collect();
        let hits = if exact.is_empty() { rows.iter().filter(|r| r.1.contains(&low)).collect() } else { exact };
        if hits.is_empty() {
            bail!("no matching domains for '{v}'. Run 'kortix-capture list domains' to see recorded domains.");
        }
        let found: Vec<String> = hits.iter().map(|r| r.1.clone()).collect();
        if found != [v.clone()] {
            eprintln!("Auto-matched '{v}' → {}", found.join(", "));
        }
        ids.extend(hits.iter().map(|r| r.0));
        names.extend(found);
    }
    Ok((ids, names))
}

fn single(what: &str, value: &str, mut names: Vec<String>) -> Result<String> {
    names.sort();
    names.dedup();
    if names.len() > 1 {
        let shown: Vec<_> = names.iter().take(5).cloned().collect();
        bail!("'{value}' matches multiple {what}: {}", shown.join(", "));
    }
    Ok(names.remove(0))
}

// ---------------------------------------------------------------- list

pub fn list(paths: &MemoryPaths, c: ListCommand, json_out: bool) -> Result<()> {
    let conn = store::open_readonly(paths)?;
    match c {
        ListCommand::Applications => {
            let mut stmt = conn.prepare(
                "SELECT bundle_id, MAX(COALESCE(display_name, bundle_id)) AS name FROM application GROUP BY bundle_id ORDER BY name, bundle_id",
            )?;
            let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            let v = Value::Array(rows.iter().map(|(b, n)| json!({"bundle_id": b, "display_name": n})).collect());
            print(&v, json_out, |_| {
                let mut lines = vec!["bundle_id\tname".to_string()];
                lines.extend(rows.iter().map(|(b, n)| format!("{b}\t{}", one_line(n))));
                lines.join("\n")
            });
        }
        ListCommand::Domains => {
            let mut stmt = conn.prepare("SELECT normalized_domain FROM domain ORDER BY normalized_domain")?;
            let rows: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
            print(&json!(rows), json_out, |_| rows.join("\n"));
        }
    }
    Ok(())
}

fn one_line(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

// ---------------------------------------------------------------- usage

fn time_json(conn: &Connection, scope: &Scope) -> Result<Value> {
    let (w, args) = scope.where_sql();
    let frames: i64 = conn.query_row(&format!("SELECT count(*) FROM {FROM_FRAMES}{w}"), params_from_iter(args), |r| r.get(0))?;
    let secs = frames * FRAME_SECONDS;
    let mut v = json!({"frame_count": frames, "recorded_seconds": secs, "recorded_seconds_human": timerange::human(secs)});
    if let Some(t) = scope.range.start {
        v["start_ms"] = json!(t);
    }
    if let Some(t) = scope.range.end {
        v["end_ms"] = json!(t);
    }
    Ok(v)
}

fn ranking(conn: &Connection, scope: &Scope, limit: usize, domains: bool) -> Result<Value> {
    let (w, args) = scope.where_sql();
    let (join, key, name) = if domains {
        ("JOIN domain d ON d.id = s.domain", "d.normalized_domain", "d.normalized_domain")
    } else {
        ("JOIN application a ON a.id = s.application", "a.bundle_id", "MAX(COALESCE(a.display_name, a.bundle_id))")
    };
    let sql = format!(
        "SELECT {key}, {name}, count(*) AS n FROM {FROM_FRAMES} {join}{w} GROUP BY {key} ORDER BY n DESC, {key} LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?
        .map(|row| {
            let (id, name, n) = row?;
            let mut v = json!({"identifier": id, "frame_count": n, "recorded_seconds": n * FRAME_SECONDS, "recorded_seconds_human": timerange::human(n * FRAME_SECONDS)});
            if !domains {
                v["display_name"] = json!(name);
            }
            Ok::<_, rusqlite::Error>(v)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"items": items}))
}

fn range_of(tr: &TrOnly) -> Result<TimeRange> {
    tr.tr.as_deref().map(timerange::parse_range).transpose().map(Option::unwrap_or_default)
}

fn merge(into: &mut Value, from: Value) {
    if let (Some(a), Value::Object(b)) = (into.as_object_mut(), from) {
        a.extend(b);
    }
}

fn top(conn: &Connection, tr: &TrOnly, limit: usize, domains: bool, json_out: bool) -> Result<()> {
    let scope = Scope { range: range_of(tr)?, apps: None, domains: None };
    let v = ranking(conn, &scope, limit, domains)?;
    print(&v, json_out, |v| {
        let items = v["items"].as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return "No items found.".into();
        }
        let mut lines = vec!["name\ttime".to_string()];
        lines.extend(items.iter().map(|i| {
            let name = i.get("display_name").or_else(|| i.get("identifier")).and_then(Value::as_str).unwrap_or("");
            format!("{}\t{}", one_line(name), i["recorded_seconds_human"].as_str().unwrap_or(""))
        }));
        lines.join("\n")
    });
    Ok(())
}

struct Session {
    start: i64,
    end: i64,
    frames: i64,
}

/// Split ascending timestamps into sessions wherever the gap reaches `gap_ms`.
fn split_sessions(timestamps: impl Iterator<Item = i64>, gap_ms: i64) -> Vec<Session> {
    let mut out: Vec<Session> = Vec::new();
    for t in timestamps {
        match out.last_mut() {
            Some(s) if t - s.end < gap_ms => {
                s.end = t;
                s.frames += 1;
            }
            _ => out.push(Session { start: t, end: t, frames: 1 }),
        }
    }
    out
}

pub fn usage(paths: &MemoryPaths, c: UsageCommand, json_out: bool) -> Result<()> {
    let conn = store::open_readonly(paths)?;
    match c {
        UsageCommand::Time(f) => {
            let v = time_json(&conn, &Scope::new(&conn, &f.tr, &f.app_filter, &f.domain_filter)?)?;
            print(&v, json_out, |v| format!("total: {}", v["recorded_seconds_human"].as_str().unwrap_or("0s")));
        }
        UsageCommand::TopApplications { tr, limit } => top(&conn, &tr, limit, false, json_out)?,
        UsageCommand::TopDomains { tr, limit } => top(&conn, &tr, limit, true, json_out)?,
        UsageCommand::Application { bundle_id, tr } => {
            let (ids, bundles) = match_apps(&conn, std::slice::from_ref(&bundle_id))?;
            single("applications", &bundle_id, bundles)?;
            let name: String = conn.query_row(
                &format!("SELECT COALESCE(MAX(display_name), MAX(bundle_id)) FROM application WHERE id IN ({})", vec!["?"; ids.len()].join(",")),
                params_from_iter(ids.iter()),
                |r| r.get(0),
            )?;
            let scope = Scope { range: range_of(&tr)?, apps: Some(ids), domains: None };
            let mut v = json!({"application": name});
            merge(&mut v, time_json(&conn, &scope)?);
            print(&v, json_out, |v| format!("{name}: {}", v["recorded_seconds_human"].as_str().unwrap_or("0s")));
        }
        UsageCommand::Domain { domain, tr } => {
            let (ids, names) = match_domains(&conn, std::slice::from_ref(&domain))?;
            let name = single("domains", &domain, names)?;
            let scope = Scope { range: range_of(&tr)?, apps: None, domains: Some(ids) };
            let mut v = json!({"domain": name});
            merge(&mut v, time_json(&conn, &scope)?);
            print(&v, json_out, |v| format!("{name}: {}", v["recorded_seconds_human"].as_str().unwrap_or("0s")));
        }
        UsageCommand::Sessions { filters, gap } => {
            let scope = Scope::new(&conn, &filters.tr, &filters.app_filter, &filters.domain_filter)?;
            let (w, args) = scope.where_sql();
            let mut stmt = conn.prepare(&format!("SELECT f.timestamp FROM {FROM_FRAMES}{w} ORDER BY f.timestamp"))?;
            let stamps = stmt.query_map(params_from_iter(args), |r| r.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
            let mut sessions = split_sessions(stamps.into_iter(), gap.max(1) as i64 * 60_000);
            sessions.reverse();
            let secs = |s: &Session| (s.end - s.start) / 1000;
            let total: i64 = sessions.iter().map(secs).sum();
            let v = json!({
                "session_count": sessions.len(),
                "total_duration_seconds": total,
                "total_duration_seconds_human": timerange::human(total),
                "sessions": sessions.iter().map(|s| json!({
                    "start_ms": s.start, "end_ms": s.end, "start": timerange::iso(s.start), "end": timerange::iso(s.end),
                    "frame_count": s.frames, "duration_seconds": secs(s), "duration_human": timerange::human(secs(s)),
                })).collect::<Vec<_>>(),
            });
            print(&v, json_out, |_| {
                if sessions.is_empty() {
                    return "No sessions found.".into();
                }
                let mut lines = vec![format!("{} sessions | total: {}", sessions.len(), timerange::human(total)), "time\tduration".into()];
                lines.extend(sessions.iter().map(|s| {
                    format!("{}-{}\t{}", timerange::mmddhhmm(s.start), timerange::hhmm(s.end), timerange::human(secs(s)))
                }));
                lines.join("\n")
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- frames

#[derive(Debug)]
pub struct FrameInfo {
    pub id: i64,
    pub ts: i64,
    pub app: Option<String>,
    pub domain: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    /// OCR boxes joined with spaces.
    pub text: String,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|x| !x.is_empty())
}

pub(super) fn frame_info(conn: &Connection, id: i64) -> Result<Option<FrameInfo>> {
    Ok(conn
        .query_row(
            "SELECT f.id, f.timestamp, COALESCE(a.display_name, a.bundle_id), d.normalized_domain,
                    COALESCE((SELECT w.url FROM window_bound w WHERE w.frame = f.id AND w.is_focussed_window = 1 AND w.url IS NOT NULL LIMIT 1), s.url),
                    f.title, COALESCE(f.foreground, ''), COALESCE(f.background, '')
             FROM frame f LEFT JOIN segment s ON s.id = f.segment
                  LEFT JOIN application a ON a.id = s.application LEFT JOIN domain d ON d.id = s.domain
             WHERE f.id = ?1",
            [id],
            |r| {
                let (fg, bg): (String, String) = (r.get(6)?, r.get(7)?);
                Ok(FrameInfo {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    app: non_empty(r.get(2)?),
                    domain: non_empty(r.get(3)?),
                    url: non_empty(r.get(4)?),
                    title: non_empty(r.get(5)?),
                    text: [fg, bg].iter().filter(|t| !t.is_empty()).map(|t| t.replace('\n', " ")).collect::<Vec<_>>().join(" "),
                })
            },
        )
        .optional()?)
}

impl FrameInfo {
    fn json(&self, ocr: bool) -> Value {
        let mut v = json!({
            "frame_id": self.id, "timestamp": timerange::iso(self.ts), "application": self.app,
            "domain": self.domain, "url": self.url, "title": self.title,
        });
        if ocr {
            v["ocr_text"] = json!(self.text);
        }
        v
    }

    /// Tab row: `id  time  [dur]  app  domain  url  title`, `-` for unknown.
    pub(super) fn row(&self, time: String, dur: Option<&str>) -> String {
        let f = |o: &Option<String>| o.as_deref().map(one_line).unwrap_or_else(|| "-".into());
        let mut cells = vec![self.id.to_string(), time];
        cells.extend(dur.map(str::to_string));
        cells.extend([f(&self.app), f(&self.domain), f(&self.url), f(&self.title)]);
        cells.join("\t")
    }

    /// `k: v` fields for the single-frame compact forms; unknown fields are left out.
    fn fields(&self, sep: &str) -> String {
        let mut parts = vec![format!("id: {}", self.id), format!("time: {}", timerange::iso(self.ts))];
        for (k, v) in [("app", &self.app), ("domain", &self.domain), ("url", &self.url)] {
            if let Some(v) = v {
                parts.push(format!("{k}: {}", one_line(v)));
            }
        }
        if sep == "\t" {
            parts.push(format!("title: {}", one_line(self.title.as_deref().unwrap_or(""))));
        }
        parts.join(sep)
    }

    fn header(&self) -> String {
        let mut parts = vec![format!("Frame {}", self.id), timerange::iso(self.ts)];
        parts.extend([&self.app, &self.domain, &self.url, &self.title].into_iter().flatten().map(|s| one_line(s)));
        parts.join(" | ")
    }
}

pub(super) fn need(conn: &Connection, id: i64) -> Result<FrameInfo> {
    frame_info(conn, id)?.context("invalid parameters: Frame not found")
}

/// Frame ids for `--id` (comma list) or `--ts` (nearest frame within 60 s); the requested ms for `--ts`.
fn resolve_frames(conn: &Connection, sel: &FrameSelector) -> Result<Vec<(i64, Option<i64>)>> {
    if let Some(ids) = &sel.id {
        return ids
            .split(',')
            .map(|p| p.trim().parse::<i64>().map(|i| (i, None)).map_err(|_| anyhow::anyhow!("invalid frame id '{}'", p.trim())))
            .collect();
    }
    let Some(list) = &sel.ts else { bail!("specify --ts or --id") };
    list.split(',')
        .map(|p| {
            let ts = timerange::parse_ts(p.trim())?;
            Ok((nearest_frame(conn, ts)?, Some(ts)))
        })
        .collect()
}

/// `(id, distance in ms)` of the frame closest to `ts`.
pub fn closest_frame(conn: &Connection, ts: i64) -> Result<Option<(i64, i64)>> {
    let one = |sql: &str| -> Result<Option<(i64, i64)>> {
        Ok(conn.query_row(sql, [ts], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))).optional()?)
    };
    let before = one("SELECT id, timestamp FROM frame WHERE timestamp <= ?1 ORDER BY timestamp DESC, id DESC LIMIT 1")?;
    let after = one("SELECT id, timestamp FROM frame WHERE timestamp >= ?1 ORDER BY timestamp, id LIMIT 1")?;
    Ok([before, after].into_iter().flatten().map(|(id, t)| (id, (t - ts).abs())).min_by_key(|(_, d)| *d))
}

/// Id of the frame closest to `ts`, if it is within 60 s.
pub fn nearest_frame(conn: &Connection, ts: i64) -> Result<i64> {
    match closest_frame(conn, ts)? {
        Some((id, d)) if d <= MAX_FRAME_DISTANCE_MS => Ok(id),
        Some((_, d)) => bail!(
            "invalid parameters: No frame found within 60 seconds of the requested timestamp (closest is {}s away).",
            d / 1000
        ),
        None => bail!("invalid parameters: No frames are recorded yet."),
    }
}

fn emit(items: Vec<Value>, compact: Vec<String>, joiner: &str, json_out: bool) {
    let v = if items.len() == 1 { items.into_iter().next().unwrap_or_default() } else { Value::Array(items) };
    print(&v, json_out, |_| compact.join(joiner));
}

fn frame_cmd(conn: &Connection, sel: &FrameSelector, show_ocr: bool, json_out: bool) -> Result<()> {
    let (mut items, mut compact) = (Vec::new(), Vec::new());
    for (id, _) in resolve_frames(conn, sel)? {
        let fi = need(conn, id)?;
        if show_ocr {
            let screen = screen::load(conn, id)?;
            let mut v = fi.json(false);
            let (overlays, main) = screen::to_json(&screen);
            v["overlays"] = json!(overlays);
            v["main_windows"] = json!(main);
            v["warnings"] = if screen.warnings.is_empty() { Value::Null } else { json!(screen.warnings) };
            let mut text = fi.header();
            for w in &screen.warnings {
                text.push_str(&format!("\nWarning: {w}"));
            }
            text.push('\n');
            text.push_str(&screen::to_compact(&screen));
            items.push(v);
            compact.push(text.trim_end().to_string());
        } else {
            let mut v = fi.json(false);
            v["ocr_text"] = Value::Null;
            items.push(v);
            compact.push(fi.fields("\t"));
        }
    }
    let joiner = if show_ocr { "\n\n".to_string() } else { format!("\n{SEPARATOR}\n") };
    emit(items, compact, &joiner, json_out);
    Ok(())
}

fn ocrboxes_cmd(conn: &Connection, sel: &FrameSelector, json_out: bool) -> Result<()> {
    let (mut items, mut compact) = (Vec::new(), Vec::new());
    for (id, _) in resolve_frames(conn, sel)? {
        let fi = need(conn, id)?;
        let chars: Vec<char> = conn
            .query_row("SELECT COALESCE(foreground, '') || COALESCE(background, '') FROM frame WHERE id = ?1", [id], |r| r.get::<_, String>(0))?
            .chars()
            .collect();
        let mut stmt = conn.prepare("SELECT x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?1 ORDER BY id")?;
        let boxes: Vec<(i64, i64, i64, i64, String)> = stmt
            .query_map([id], |r| {
                let (off, len): (i64, i64) = (r.get(4)?, r.get(5)?);
                let text: String = chars.iter().skip(off.max(0) as usize).take(len.max(0) as usize).collect();
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, text))
            })?
            .collect::<Result<_, _>>()?;
        let mut v = fi.json(false);
        v.as_object_mut().map(|o| o.remove("ocr_text"));
        v["boxes"] = json!(boxes.iter().map(|(x, y, w, h, t)| json!({"x": x, "y": y, "width": w, "height": h, "text": t})).collect::<Vec<_>>());
        let mut lines = vec![fi.fields("  "), format!("title: {}", one_line(fi.title.as_deref().unwrap_or(""))), "x\ty\tw\th\ttext".to_string()];
        lines.extend(boxes.iter().map(|(x, y, w, h, t)| format!("{x}\t{y}\t{w}\t{h}\t{}", one_line(t))));
        items.push(v);
        compact.push(lines.join("\n"));
    }
    emit(items, compact, "\n\n", json_out);
    Ok(())
}

fn image_cmd(paths: &MemoryPaths, conn: &Connection, sel: &FrameSelector, crop: bool) -> Result<()> {
    let frames = resolve_frames(conn, sel)?;
    let dir = MemoryPaths::export_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let mut engine = Engine::new()?;
    for (id, requested) in frames {
        need(conn, id)?;
        let stem = requested.map(|t| format!("image_ts{t}")).unwrap_or_else(|| format!("image_id{id}"));
        let rect = if crop {
            let r = super::frames::focused_crop(conn, id)?;
            if r.is_none() {
                eprintln!("frame {id}: no focused window recorded; exporting the full screenshot");
            }
            r
        } else {
            None
        };
        let out = dir.join(format!("{stem}{}.png", if rect.is_some() { "_crop" } else { "" }));
        println!("{}", super::frames::export(conn, paths, &mut engine, id, &out, rect)?.display());
    }
    Ok(())
}

fn axtree_cmd(conn: &Connection, sel: &FrameSelector, opts: &AxOpts, json_out: bool) -> Result<()> {
    let (mut items, mut compact) = (Vec::new(), Vec::new());
    for (id, _) in resolve_frames(conn, sel)? {
        let fi = need(conn, id)?;
        let snap: Option<(String, String, i64, i64, i64, bool, Vec<u8>)> = conn
            .query_row(
                "SELECT s.application_name, s.bundle_id, s.process_identifier, s.timestamp_ms, s.node_count, s.is_partial_tree, b.payload
                 FROM ax_snapshot s JOIN ax_blob b ON b.hash = s.hash WHERE s.frame_id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? != 0, r.get(6)?)),
            )
            .optional()?;
        let mut v = fi.json(false);
        v.as_object_mut().map(|o| o.remove("ocr_text"));
        let Some((app, bundle, pid, captured, nodes, partial, payload)) = snap else {
            v["has_tree"] = json!(false);
            compact.push(format!("{}\n(no accessibility tree captured for this frame)", fi.header()));
            items.push(v);
            continue;
        };
        let tree: Value = serde_json::from_slice(&zstd::decode_all(payload.as_slice())?).context("decode accessibility tree")?;
        let meta = AxMeta {
            frame_id: id,
            timestamp: timerange::iso(fi.ts),
            application: app,
            title: fi.title.clone().unwrap_or_default(),
            bundle,
            pid,
            captured_utc: chrono::DateTime::from_timestamp_millis(captured).unwrap_or_default().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            node_count: nodes,
            stored_bytes: payload.len(),
            partial,
        };
        let text = axrender::render(&tree, &meta, opts);
        v["has_tree"] = json!(true);
        v["tree_text"] = json!(text);
        v["total_node_count"] = json!(nodes);
        v["is_partial_tree"] = json!(partial);
        v["stored_bytes"] = json!(payload.len());
        items.push(v);
        compact.push(text);
    }
    emit(items, compact, "\n\n", json_out);
    Ok(())
}

// ---------------------------------------------------------------- fts

fn word_set(text: &str) -> HashSet<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).map(str::to_lowercase).collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    let union = a.union(b).count();
    if union == 0 { 1.0 } else { a.intersection(b).count() as f64 / union as f64 }
}

/// Newest-first candidates `(id, segment, text)` -> ids that add something new: a frame is
/// dropped when the previous kept frame of its segment has near-identical text.
fn dedupe(cands: Vec<(i64, Option<i64>, String)>, limit: usize) -> Vec<i64> {
    let mut last: HashMap<Option<i64>, HashSet<String>> = HashMap::new();
    let mut out = Vec::new();
    for (id, segment, text) in cands {
        let words = word_set(&text);
        if last.get(&segment).is_some_and(|prev| jaccard(prev, &words) >= 0.8) {
            continue;
        }
        last.insert(segment, words);
        out.push(id);
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Quote every term so a malformed FTS5 expression still searches for its words.
fn literal_query(q: &str) -> String {
    q.split_whitespace().map(|t| format!("\"{}\"", t.replace('"', ""))).filter(|t| t != "\"\"").collect::<Vec<_>>().join(" ")
}

fn fts_ids(conn: &Connection, scope: &Scope, query: &str, limit: usize) -> Result<Vec<i64>> {
    let (w, mut args) = scope.where_with("ocr_fts MATCH ?", vec![Sql::Null]);
    let sql = format!(
        "SELECT f.id, f.segment, COALESCE(f.title, '') || ' ' || COALESCE(f.foreground, '') || ' ' || COALESCE(f.background, '')
         FROM ocr_fts JOIN frame f ON f.id = ocr_fts.rowid LEFT JOIN segment s ON s.id = f.segment{w}
         ORDER BY f.timestamp DESC, f.id DESC LIMIT {FTS_CANDIDATES}"
    );
    let slot = args.len() - 1;
    let mut run = |q: &str| -> rusqlite::Result<Vec<(i64, Option<i64>, String)>> {
        args[slot] = Sql::Text(q.to_string());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    };
    let rows = match run(query) {
        Ok(rows) => rows,
        Err(_) => run(&literal_query(query)).context("invalid FTS5 query")?,
    };
    Ok(dedupe(rows, limit))
}

// ---------------------------------------------------------------- sample, cover

/// Indices of frames to keep: chronological, each at least `min_secs` after the last kept frame
/// and at least `min_text` TF-IDF cosine distance from each of the last 5 kept frames.
fn cover_select(frames: &[(i64, &str)], min_text: f64, min_secs: f64) -> Vec<usize> {
    let vecs = tfidf::embed(&frames.iter().map(|f| f.1).collect::<Vec<_>>());
    let mut kept: Vec<usize> = Vec::new();
    for i in 0..frames.len() {
        let ok = kept.last().is_none_or(|&l| {
            (frames[i].0 - frames[l].0) as f64 >= min_secs * 1000.0
                && kept.iter().rev().take(5).all(|&k| tfidf::distance(&vecs[i], &vecs[k]) as f64 >= min_text)
        });
        if ok {
            kept.push(i);
        }
    }
    kept
}

fn require_tr(f: &Filters) -> Result<()> {
    if f.tr.is_none() {
        bail!("Missing expected argument '--tr <tr>'");
    }
    Ok(())
}

/// Representative frame of a segment inside `scope`: OCR finished first, then nearest the midpoint.
pub(super) fn segment_rep(conn: &Connection, scope: &Scope, segment: Option<i64>, first: i64, last: i64) -> Result<i64> {
    let (w, mut args) = scope.where_with("f.segment IS ?", vec![segment.map_or(Sql::Null, Sql::Integer)]);
    args.push(Sql::Integer((first + last) / 2));
    Ok(conn.query_row(
        &format!("SELECT f.id FROM {FROM_FRAMES}{w} ORDER BY (f.ocr_status IN (1, 2)) DESC, abs(f.timestamp - ?{}) LIMIT 1", args.len()),
        params_from_iter(args),
        |r| r.get(0),
    )?)
}

fn sample_cmd(conn: &Connection, f: &Filters, min_seg_len: i64, json_out: bool) -> Result<()> {
    require_tr(f)?;
    let scope = Scope::new(conn, &f.tr, &f.app_filter, &f.domain_filter)?;
    let (w, args) = scope.where_sql();
    let mut stmt = conn.prepare(&format!(
        "SELECT f.segment, count(*), min(f.timestamp), max(f.timestamp) FROM {FROM_FRAMES}{w}
         GROUP BY f.segment HAVING count(*) >= ?{} ORDER BY min(f.timestamp)",
        args.len() + 1
    ))?;
    let mut args = args;
    args.push(Sql::Integer(min_seg_len));
    let segs: Vec<(Option<i64>, i64, i64, i64)> = stmt
        .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    let (mut items, mut frames) = (Vec::new(), Vec::new());
    for (segment, n, first, last) in segs {
        let id = segment_rep(conn, &scope, segment, first, last)?;
        let fi = need(conn, id)?;
        let dur = timerange::human(n * FRAME_SECONDS);
        items.push(json!({"frame_count": n, "duration": dur, "selected_frame": fi.json(true)}));
        frames.push((fi, dur));
    }
    let v = json!({"segment_count": items.len(), "segments": items});
    print(&v, json_out, |_| {
        if frames.is_empty() {
            return "No segments found.".into();
        }
        let one_day = frames.iter().all(|(f, _)| timerange::day_of(f.ts) == timerange::day_of(frames[0].0.ts));
        let mut lines = vec![format!("{} segments with representative frames", frames.len()), "id\ttime\tdur\tapp\tdomain\turl\ttitle".into()];
        lines.extend(frames.iter().map(|(f, dur)| {
            f.row(if one_day { timerange::hhmm(f.ts) } else { timerange::mmddhhmm(f.ts) }, Some(dur))
        }));
        lines.join("\n")
    });
    Ok(())
}

fn cover_cmd(conn: &Connection, f: &Filters, min_text: f64, min_secs: f64, json_out: bool) -> Result<()> {
    require_tr(f)?;
    if !(0.0..=1.0).contains(&min_text) || min_secs < 0.0 {
        bail!("--min-difference-text must be within [0, 1] and --min-difference-seconds must be >= 0");
    }
    let scope = Scope::new(conn, &f.tr, &f.app_filter, &f.domain_filter)?;
    let (w, args) = scope.where_sql();
    let mut stmt = conn.prepare(&format!(
        "SELECT f.id, f.timestamp, COALESCE(f.foreground, '') || ' ' || COALESCE(f.background, '') FROM {FROM_FRAMES}{w} ORDER BY f.timestamp, f.id LIMIT {}",
        COVER_MAX_FRAMES + 1
    ))?;
    let rows: Vec<(i64, i64, String)> = stmt.query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    if rows.len() as i64 > COVER_MAX_FRAMES {
        bail!("timerange holds more than {COVER_MAX_FRAMES} frames; cover embeds every frame, so narrow --tr (about 30 minutes works well)");
    }
    let picked = cover_select(&rows.iter().map(|r| (r.1, r.2.as_str())).collect::<Vec<_>>(), min_text, min_secs);
    let infos = picked.iter().map(|&i| need(conn, rows[i].0)).collect::<Result<Vec<_>>>()?;
    let v = json!({"total_count": rows.len(), "selected_count": infos.len(), "frames": infos.iter().map(|f| f.json(true)).collect::<Vec<_>>()});
    print(&v, json_out, |_| {
        if infos.is_empty() {
            return "No frames found.".into();
        }
        let mut lines = vec![format!("{} frames selected (of {} total)", infos.len(), rows.len()), "id\ttime\tapp\tdomain\turl\ttitle".into()];
        lines.extend(infos.iter().map(|f| f.row(timerange::iso(f.ts), None)));
        lines.join("\n")
    });
    Ok(())
}

// ---------------------------------------------------------------- dispatch

pub fn query(paths: &MemoryPaths, c: QueryCommand, json_out: bool) -> Result<()> {
    let conn = store::open_readonly(paths)?;
    match c {
        QueryCommand::Fts { query, filters, limit } => {
            let scope = Scope::new(&conn, &filters.tr, &filters.app_filter, &filters.domain_filter)?;
            let infos = fts_ids(&conn, &scope, &query, limit)?.into_iter().map(|id| need(&conn, id)).collect::<Result<Vec<_>>>()?;
            let v = Value::Array(infos.iter().map(|f| f.json(true)).collect());
            print(&v, json_out, |_| {
                if infos.is_empty() {
                    return "No results found.".into();
                }
                let mut lines = vec!["id\ttime\tapp\tdomain\turl\ttitle".to_string()];
                lines.extend(infos.iter().map(|f| f.row(timerange::iso(f.ts), None)));
                lines.join("\n")
            });
        }
        QueryCommand::Sample { filters, min_seg_len } => sample_cmd(&conn, &filters, min_seg_len, json_out)?,
        QueryCommand::Cover { filters, min_difference_text, min_difference_seconds } => {
            cover_cmd(&conn, &filters, min_difference_text, min_difference_seconds, json_out)?
        }
        QueryCommand::Frame { sel, show_ocr } => frame_cmd(&conn, &sel, show_ocr, json_out)?,
        QueryCommand::Ocrboxes { sel } => ocrboxes_cmd(&conn, &sel, json_out)?,
        QueryCommand::Image { sel, crop } => image_cmd(paths, &conn, &sel, crop)?,
        QueryCommand::Axtree { sel, raw, human, include_hidden, coords, no_collapse, text_only, max_depth, role } => {
            let opts = AxOpts { raw, human, include_hidden, coords, no_collapse, text_only, max_depth, roles: role };
            axtree_cmd(&conn, &sel, &opts, json_out)?
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const T0: i64 = 1_800_000_000_000;

    /// Synthetic library: 3 segments of 12 / 12 / 3 frames, 2 s apart, with a 20 min gap before the last.
    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        let editor = store::upsert_application(&conn, "com.example.editor", "1", "Editor").unwrap().id;
        let browser = store::upsert_application(&conn, "com.example.browser", "1", "Browser").unwrap().id;
        let docs = store::upsert_domain(&conn, "docs.example.com").unwrap();
        let mut next = 1;
        for (app, domain, count, start, text) in [
            (editor, None, 12, T0, "compiling parser module borrow checker"),
            (browser, Some(docs), 12, T0 + 24_000, "webhook signature verification guide"),
            (browser, Some(docs), 3, T0 + 20 * 60_000, "webhook signature verification guide"),
        ] {
            conn.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (?1, ?2, ?3, 'https://docs.example.com/a?token=x')", params![next, app, domain]).unwrap();
            let seg = conn.last_insert_rowid();
            for i in 0..count {
                conn.execute(
                    "INSERT INTO frame(id, timestamp, segment, title, foreground, ocr_status) VALUES (?1, ?2, ?3, 'Window', ?4, 1)",
                    params![next, start + i * 2000, seg, format!("{text} {}", if i % 6 == 5 { "extra unique words appear" } else { "" })],
                )
                .unwrap();
                next += 1;
            }
        }
        conn
    }

    fn scope(conn: &Connection, tr: Option<&str>, apps: &[&str]) -> Scope {
        Scope::new(conn, &tr.map(str::to_string), &apps.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &[]).unwrap()
    }

    #[test]
    fn usage_counts_two_seconds_per_frame() {
        let conn = library();
        let all = time_json(&conn, &scope(&conn, None, &[])).unwrap();
        assert_eq!((all["frame_count"].as_i64(), all["recorded_seconds"].as_i64()), (Some(27), Some(54)));
        assert_eq!(all["recorded_seconds_human"], "54s");
        let browser = time_json(&conn, &scope(&conn, None, &["browser"])).unwrap();
        assert_eq!(browser["frame_count"], 15, "filter automatches the bundle id substring");
        let ranked = ranking(&conn, &scope(&conn, None, &[]), 10, false).unwrap();
        assert_eq!(ranked["items"][0]["identifier"], "com.example.browser");
        assert_eq!(ranked["items"][0]["display_name"], "Browser");
        assert_eq!(ranking(&conn, &scope(&conn, None, &[]), 10, true).unwrap()["items"][0]["identifier"], "docs.example.com");
    }

    #[test]
    fn filters_report_unknown_and_ambiguous_names() {
        let conn = library();
        assert!(match_apps(&conn, &["nope".to_string()]).unwrap_err().to_string().contains("no matching applications"));
        assert!(match_domains(&conn, &["example".to_string()]).is_ok());
        let (_, bundles) = match_apps(&conn, &["com.example".to_string()]).unwrap();
        assert!(single("applications", "com.example", bundles).unwrap_err().to_string().contains("matches multiple applications"));
        assert_eq!(match_apps(&conn, &["EDITOR".to_string()]).unwrap().1, vec!["com.example.editor"]);
    }

    #[test]
    fn sessions_split_at_gaps() {
        let s = split_sessions([T0, T0 + 2000, T0 + 4000, T0 + 4000 + 10 * 60_000, T0 + 4000 + 10 * 60_000 + 2000].into_iter(), 5 * 60_000);
        assert_eq!(s.iter().map(|s| (s.frames, s.end - s.start)).collect::<Vec<_>>(), vec![(3, 4000), (2, 2000)]);
        assert_eq!(split_sessions([T0, T0 + 10 * 60_000].into_iter(), 15 * 60_000).len(), 1);
        assert!(split_sessions(std::iter::empty(), 60_000).is_empty());
    }

    #[test]
    fn timerange_scopes_frames() {
        let conn = library();
        let day = timerange::iso(T0)[..10].to_string();
        let one = time_json(&conn, &scope(&conn, Some(&format!("{day}T00:00|{day}T23:59")), &[])).unwrap();
        assert!(one["frame_count"].as_i64().unwrap() > 0 && one["start_ms"].is_i64() && one["end_ms"].is_i64());
        assert_eq!(time_json(&conn, &scope(&conn, Some("before:1990-01-01"), &[])).unwrap()["frame_count"], 0);
    }

    #[test]
    fn fts_matches_stems_and_dedupes_repeats() {
        let conn = library();
        let ids = fts_ids(&conn, &scope(&conn, None, &[]), "signatures", 50).unwrap();
        // 15 matching frames collapse to the distinct states of each segment, newest first.
        assert!(!ids.is_empty() && ids.len() < 15, "{ids:?}");
        assert!(ids.windows(2).all(|w| w[0] > w[1]), "most recent first: {ids:?}");
        assert!(fts_ids(&conn, &scope(&conn, None, &[]), "webhook NOT signature", 50).unwrap().is_empty());
        assert_eq!(fts_ids(&conn, &scope(&conn, None, &[]), "parser", 1).unwrap().len(), 1);
        assert!(!fts_ids(&conn, &scope(&conn, None, &["editor"]), "\"borrow checker", 50).unwrap().is_empty(), "malformed quote falls back to literal terms");
    }

    #[test]
    fn dedupe_keeps_distinct_text_per_segment() {
        let c = vec![(5, Some(1), "same words here".into()), (4, Some(1), "same words here".into()), (3, Some(2), "same words here".into()), (2, Some(1), "totally different content now".into())];
        assert_eq!(dedupe(c, 10), vec![5, 3, 2]);
    }

    #[test]
    fn sample_picks_one_frame_per_long_segment() {
        let conn = library();
        let f = Filters { tr: Some(timerange::iso(T0)[..10].to_string()), ..Default::default() };
        let scope = Scope::new(&conn, &f.tr, &[], &[]).unwrap();
        let (w, args) = scope.where_sql();
        let n: i64 = conn
            .query_row(&format!("SELECT count(*) FROM (SELECT 1 FROM {FROM_FRAMES}{w} GROUP BY f.segment HAVING count(*) >= 10)"), params_from_iter(args), |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "the 3-frame segment is below min-seg-len");
        let id = segment_rep(&conn, &scope, Some(1), T0, T0 + 22_000).unwrap();
        assert!((5..=8).contains(&id), "nearest the midpoint: {id}");
        assert!(sample_cmd(&conn, &Filters::default(), 10, true).is_err(), "--tr is required");
    }

    #[test]
    fn cover_spaces_frames_in_time_and_text() {
        let frames: Vec<(i64, &str)> = vec![
            (0, "alpha beta gamma delta"), (2_000, "alpha beta gamma delta"), (12_000, "alpha beta gamma delta"),
            (14_000, "epsilon zeta eta theta"), (30_000, "epsilon zeta eta theta"),
        ];
        assert_eq!(cover_select(&frames, 0.2, 10.0), vec![0, 3], "text must differ and 10 s must pass");
        assert_eq!(cover_select(&frames, 0.0, 10.0), vec![0, 2, 4], "text threshold 0 samples purely by time");
        assert_eq!(cover_select(&frames, 0.0, 0.0), vec![0, 1, 2, 3, 4]);
        assert!(cover_select(&[], 0.2, 10.0).is_empty());
    }

    #[test]
    fn frame_selection_by_id_and_nearest_timestamp() {
        let conn = library();
        let sel = |ts: Option<&str>, id: Option<&str>| FrameSelector { ts: ts.map(str::to_string), id: id.map(str::to_string) };
        assert_eq!(resolve_frames(&conn, &sel(None, Some("1, 3"))).unwrap(), vec![(1, None), (3, None)]);
        let near = timerange::iso(T0 + 4_900);
        let r = resolve_frames(&conn, &sel(Some(&near), None)).unwrap();
        assert_eq!(r[0].0, 3, "nearest frame");
        let far = timerange::iso(T0 - 3_600_000);
        assert!(resolve_frames(&conn, &sel(Some(&far), None)).unwrap_err().to_string().contains("within 60 seconds"));
        assert!(resolve_frames(&conn, &sel(None, None)).is_err());
        assert!(need(&conn, 999).unwrap_err().to_string().contains("Frame not found"));
    }

    #[test]
    fn frame_info_shapes() {
        let conn = library();
        let f = frame_info(&conn, 13).unwrap().unwrap();
        assert_eq!((f.app.as_deref(), f.domain.as_deref()), (Some("Browser"), Some("docs.example.com")));
        let v = f.json(true);
        assert_eq!(v["frame_id"], 13);
        assert!(v["ocr_text"].as_str().unwrap().contains("webhook"));
        assert!(f.json(false).get("ocr_text").is_none());
        assert_eq!(f.row("12:00".into(), Some("4s")).split('\t').count(), 7);
        let editor = frame_info(&conn, 1).unwrap().unwrap();
        assert!(editor.row("t".into(), None).contains("\t-\t"), "no domain -> dash");
    }
}
