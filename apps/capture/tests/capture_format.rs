//! The Kortix Capture format's contract artifacts: the JSON Schemas in
//! `schemas/` and the synthetic bucket in `fixtures/capture-format-v2/`.
//!
//! - `committed_fixtures_match_the_schemas`: every JSON object, JSONL line and
//!   content address in the fixture bucket validates, and every manifest's
//!   objects exist with the listed size and SHA-256.
//! - `the_engine_writes_what_the_schemas_describe`: a scratch library (two
//!   screen chunks, an audio segment, two action segments that share a
//!   screenshot) goes through the real upload code into a filesystem bucket,
//!   which must validate the same way.
//!
//! Regenerate the fixtures after a format change:
//!
//! ```text
//! KORTIX_CAPTURE_WRITE_FIXTURES=1 cargo test --test capture_format
//! ```

use anyhow::Result;
use base64::Engine as _;
use kortix_backend::memory::{
    actions, cli,
    paths::MemoryPaths,
    settings::Settings,
    store,
    sync::{self, Ctx, ErrorClass, TargetError, UploadTarget},
};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

const PREFIX: &str = "fixture-prefix";
/// A synthetic device id (32 hex characters, like a derived one).
const DEVICE: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
/// 2026-10-01T09:00:00Z
const T0: i64 = 1_790_845_200_000;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures() -> PathBuf {
    root().join("fixtures").join("capture-format-v2")
}

// ---- validation ----

struct Schemas(BTreeMap<String, jsonschema::Validator>);

impl Schemas {
    fn load() -> Self {
        let mut out = BTreeMap::new();
        for e in std::fs::read_dir(root().join("schemas")).unwrap() {
            let path = e.unwrap().path();
            let name = path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .trim_end_matches(".schema.json")
                .to_string();
            let schema: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let v = jsonschema::options()
                .with_draft(jsonschema::Draft::Draft202012)
                .build(&schema)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            out.insert(name, v);
        }
        Self(out)
    }

    fn check(&self, schema: &str, value: &Value, what: &str) {
        let v = self
            .0
            .get(schema)
            .unwrap_or_else(|| panic!("no schema {schema}"));
        let errors: Vec<String> = v
            .iter_errors(value)
            .map(|e| format!("{e} at {}", e.instance_path))
            .collect();
        assert!(errors.is_empty(), "{what} fails {schema}: {errors:#?}");
    }
}

fn jsonl(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect()
}

fn hex(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}

/// Validate a bucket written under `<dir>/bucket/`, plus `<dir>/issuer/`.
/// Returns how many objects of each kind it checked.
fn validate(dir: &Path) -> BTreeMap<&'static str, usize> {
    let schemas = Schemas::load();
    let bucket = dir.join("bucket");
    let mut files = Vec::new();
    let mut stack = vec![bucket.clone()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files.sort();
    let key_of = |p: &Path| {
        p.strip_prefix(&bucket)
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/")
    };
    let read = |key: &str| std::fs::read(bucket.join(key)).ok();
    let mut seen: BTreeMap<&'static str, usize> = BTreeMap::new();
    for f in &files {
        let key = key_of(f);
        let bytes = std::fs::read(f).unwrap();
        let name = key.rsplit('/').next().unwrap().to_string();
        let kind = if name == "policy.json" {
            schemas.check("policy", &serde_json::from_slice(&bytes).unwrap(), &key);
            "policy"
        } else if name == "device.json" {
            let v: Value = serde_json::from_slice(&bytes).unwrap();
            schemas.check("device", &v, &key);
            assert!(key.ends_with(&format!("{}/device.json", v["device_id"].as_str().unwrap())));
            "device"
        } else if name == "status.json" {
            schemas.check("status", &serde_json::from_slice(&bytes).unwrap(), &key);
            "status"
        } else if key.contains("/index/") {
            for line in jsonl(&bytes) {
                schemas.check("index-line", &line, &key);
                if line["op"] == "put" && line["manifest"] == true {
                    let m = format!("{PREFIX}/{}.manifest.json", line["base"].as_str().unwrap());
                    assert!(read(&m).is_some(), "{key} names {m}, which is missing");
                }
            }
            "index"
        } else if key.contains("/assets/") {
            let digest = actions::asset_digest(&name)
                .unwrap_or_else(|| panic!("{key} is not content-addressed"));
            assert!(name.starts_with("sha256-"), "schema 2 asset names: {key}");
            assert_eq!(hex(&bytes), digest, "{key} content matches its name");
            "asset"
        } else if name.ends_with(".manifest.json") {
            let m: Value = serde_json::from_slice(&bytes).unwrap();
            let kind = m["kind"].as_str().unwrap().to_string();
            schemas.check(&format!("manifest-{kind}"), &m, &key);
            // Day folder = UTC day of the start; id marker per kind.
            let start = m["start_ms"].as_i64().unwrap();
            let day = chrono::DateTime::from_timestamp_millis(start)
                .unwrap()
                .format("%Y/%m/%d")
                .to_string();
            let marker = match kind.as_str() {
                "audio" => "-a",
                "actions" => "-x",
                _ => "-",
            };
            assert!(
                key.contains(&format!("/{day}/{start}{marker}")),
                "{key} is not under its UTC day"
            );
            for (role, o) in m["objects"].as_object().unwrap() {
                let body = read(
                    o["key"]
                        .as_str()
                        .map(|k| format!("{PREFIX}/{k}"))
                        .unwrap()
                        .as_str(),
                )
                .unwrap_or_else(|| panic!("{key}: object {role} is missing"));
                assert_eq!(
                    body.len() as u64,
                    o["size"].as_u64().unwrap(),
                    "{key} {role} size"
                );
                assert_eq!(
                    hex(&body),
                    o["sha256"].as_str().unwrap(),
                    "{key} {role} sha256"
                );
            }
            if kind == "actions" {
                for s in m["screenshots"].as_array().unwrap() {
                    let a = format!(
                        "{PREFIX}/{}/assets/{}",
                        m["device_id"].as_str().unwrap(),
                        s.as_str().unwrap()
                    );
                    assert!(read(&a).is_some(), "{key}: screenshot {a} is missing");
                }
            }
            match kind.as_str() {
                "chunk" => "manifest-chunk",
                "audio" => "manifest-audio",
                _ => "manifest-actions",
            }
        } else if name.ends_with(".frames.jsonl.zst") {
            for line in jsonl(&zstd::decode_all(bytes.as_slice()).unwrap()) {
                schemas.check("frames-line", &line, &key);
            }
            "frames"
        } else if name.ends_with(".actions.jsonl.zst") {
            let lines = jsonl(&zstd::decode_all(bytes.as_slice()).unwrap());
            assert!(!lines.is_empty());
            for line in lines {
                schemas.check("actions-line", &line, &key);
                let device = key
                    .trim_start_matches(&format!("{PREFIX}/"))
                    .split('/')
                    .next()
                    .unwrap();
                for shot in std::iter::once(&line["screenshot"])
                    .chain(
                        line["displays"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|d| &d["screenshot"]),
                    )
                    .filter_map(Value::as_str)
                {
                    assert!(
                        read(&format!("{PREFIX}/{device}/assets/{shot}")).is_some(),
                        "{key}: {shot} is missing"
                    );
                }
            }
            "actions"
        } else if name.ends_with(".mp4") || name.ends_with(".m4a") {
            "media"
        } else {
            panic!("unexpected object {key}");
        };
        *seen.entry(kind).or_default() += 1;
    }
    for (file, schema) in [
        ("device-authorization.json", "issuer-device-authorization"),
        ("device-token.json", "issuer-device-token"),
        ("device-token-pending.json", "issuer-device-token"),
        ("credentials.json", "issuer-credentials"),
    ] {
        let v: Value =
            serde_json::from_slice(&std::fs::read(dir.join("issuer").join(file)).unwrap()).unwrap();
        schemas.check(schema, &v, file);
        *seen.entry("issuer").or_default() += 1;
    }
    seen
}

fn assert_complete(seen: &BTreeMap<&'static str, usize>) {
    for (kind, at_least) in [
        ("policy", 1),
        ("device", 1),
        ("status", 1),
        ("index", 1),
        ("asset", 4),
        ("manifest-chunk", 2),
        ("manifest-audio", 1),
        ("manifest-actions", 2),
        ("frames", 2),
        ("actions", 2),
        ("media", 3),
        ("issuer", 4),
    ] {
        assert!(
            seen.get(kind).copied().unwrap_or(0) >= at_least,
            "{kind}: {seen:?}"
        );
    }
}

#[test]
fn committed_fixtures_match_the_schemas() {
    assert_complete(&validate(&fixtures()));
}

#[test]
fn the_engine_writes_what_the_schemas_describe() {
    let out = std::env::temp_dir().join(format!("kcap-format-{}", uuid::Uuid::new_v4().simple()));
    generate(&out).unwrap();
    assert_complete(&validate(&out));
    if std::env::var("KORTIX_CAPTURE_WRITE_FIXTURES").as_deref() == Ok("1") {
        let _ = std::fs::remove_dir_all(fixtures());
        std::fs::create_dir_all(fixtures()).unwrap();
        for d in ["bucket", "issuer"] {
            copy_dir(&out.join(d), &fixtures().join(d));
        }
    }
    let _ = std::fs::remove_dir_all(&out);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let p = e.unwrap().path();
        let dest = to.join(p.file_name().unwrap());
        if p.is_dir() {
            copy_dir(&p, &dest);
        } else {
            std::fs::copy(&p, &dest).unwrap();
        }
    }
}

// ---- generation ----

/// A bucket in a directory: what the engine's S3 target does, on disk.
struct DirTarget {
    root: PathBuf,
    sent: AtomicU64,
}

impl DirTarget {
    fn path(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }
}

impl UploadTarget for DirTarget {
    fn provider(&self) -> &'static str {
        "dir"
    }
    fn key(&self, rel: &str) -> String {
        format!("{PREFIX}/{rel}")
    }
    fn rel<'k>(&self, key: &'k str) -> &'k str {
        key.strip_prefix(&format!("{PREFIX}/")).unwrap_or(key)
    }
    fn bytes_sent(&self) -> u64 {
        self.sent.load(Ordering::SeqCst)
    }
    fn put_bytes(&self, key: &str, body: &[u8], _: &str, sha256: &[u8; 32]) -> Result<()> {
        if <[u8; 32]>::from(Sha256::digest(body)) != *sha256 {
            return Err(TargetError::new(
                ErrorClass::Integrity,
                400,
                "BadDigest",
                "",
                key,
            ));
        }
        // Atomic like an S3 PUT: concurrent uploads of one asset never expose a partial file.
        let p = self.path(key);
        std::fs::create_dir_all(p.parent().unwrap())?;
        let tmp = p.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&tmp, body)?;
        std::fs::rename(tmp, p)?;
        self.sent.fetch_add(body.len() as u64, Ordering::SeqCst);
        Ok(())
    }
    fn put_file(&self, key: &str, file: &Path, _: u64, sha256: &[u8; 32], ct: &str) -> Result<()> {
        self.put_bytes(key, &std::fs::read(file)?, ct, sha256)
    }
    fn head(&self, key: &str) -> Result<Option<u64>> {
        Ok(std::fs::metadata(self.path(key)).ok().map(|m| m.len()))
    }
    fn delete(&self, key: &str) -> Result<()> {
        let _ = std::fs::remove_file(self.path(key));
        Ok(())
    }
    fn get_bytes(&self, key: &str) -> Result<Option<Vec<u8>>> {
        Ok(std::fs::read(self.path(key)).ok())
    }
    fn get_to_file(&self, key: &str, out: &Path) -> Result<(u64, [u8; 32])> {
        let b = std::fs::read(self.path(key))?;
        std::fs::write(out, &b)?;
        Ok((b.len() as u64, Sha256::digest(&b).into()))
    }
    fn list(&self, _: &str, _: Option<&str>) -> Result<(Vec<(String, u64)>, Vec<String>)> {
        Ok((Vec::new(), Vec::new()))
    }
}

/// Deterministic, synthetic bytes.
fn noise(seed: u64, n: usize) -> Vec<u8> {
    let mut x = seed ^ 0x9E37_79B9_7F4A_7C15;
    let mut v = Vec::with_capacity(n + 8);
    while v.len() < n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        v.extend_from_slice(&x.to_le_bytes());
    }
    v.truncate(n);
    v
}

fn chunk(c: &rusqlite::Connection, paths: &MemoryPaths, start: i64, frames: i64, words: &str) {
    std::fs::write(
        paths.icons_dir().join("com.example.editor.png"),
        b"\x89PNG synthetic icon",
    )
    .unwrap();
    let app = store::upsert_application(c, "com.example.editor", "2.1", "Editor")
        .unwrap()
        .id;
    c.execute("UPDATE application SET icon_path = 'icons/com.example.editor.png', is_user_app = 1 WHERE id = ?1", [app]).unwrap();
    let dom = store::upsert_domain(c, "docs.example.org").unwrap();
    let name = format!("{start}.mp4");
    std::fs::write(paths.videos_dir().join(&name), noise(start as u64, 2048)).unwrap();
    c.execute(
        "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (720, 1280, ?1, ?2, 2048, ?3, ?4)",
        params![name, frames, start, start + (frames - 1) * 2000],
    )
    .unwrap();
    let vid = c.last_insert_rowid();
    c.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (0, ?1, ?2, 'https://docs.example.org/guide')", params![app, dom]).unwrap();
    let seg = c.last_insert_rowid();
    for i in 0..frames {
        let fg = format!("{words} frame {i}");
        c.execute(
            "INSERT INTO frame(timestamp, video, video_index, width, height, title, foreground, background, segment, ocr_status,
                               capture_display_x, capture_display_y, capture_display_width, capture_display_height, capture_reason, dhash)
             VALUES (?1, ?2, ?3, 1280, 720, 'Guide — Editor', ?4, 'sidebar', ?5, 1, 0, 0, 1280, 720, 'interval', 'abcd')",
            params![start + i * 2000, vid, i, fg, seg],
        )
        .unwrap();
        let fid = c.last_insert_rowid();
        c.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, 10, 20, 300, 18, 0, ?2)", params![fid, fg.chars().count() as i64]).unwrap();
        c.execute(
            "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, z_order, is_focussed_window, url) VALUES (?1, ?2, 'Guide', 0, 0, 1280, 720, 0, 1, 'https://docs.example.org/guide')",
            params![fid, app],
        )
        .unwrap();
    }
}

fn action_segment(paths: &MemoryPaths, start: i64, shots: &[&[u8]]) {
    let name = format!("tray_chunk_{start}");
    let dir = paths.root.join("spool").join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let mut lines = Vec::new();
    for (i, shot) in shots.iter().enumerate() {
        let t = 1.0 + 2.0 * i as f64;
        lines.push(
            json!({"type": "click", "timestamp": t, "start_timestamp": t - 0.1,
            "command": "click(x=0.5000, y=0.5000, clicks=1, button='left')",
            "args": {"x": 0.5, "y": 0.5, "button": "left", "clicks": 1, "modifiers": []}}),
        );
        lines.push(json!({"type": "screenshot", "timestamp": t + 0.3, "command": "",
            "args": {"image": b64(shot), "width": 8, "height": 8,
                     "displays": [{"display_id": 1, "x": 0, "y": 0, "width": 8, "height": 8, "image": b64(shot)}]}}));
    }
    lines.push(
        json!({"type": "typewrite", "timestamp": 9.0, "start_timestamp": 8.0,
        "command": "typewrite('quarterly plan')", "args": {"text": "quarterly plan"}}),
    );
    lines.push(
        json!({"type": "hotkey", "timestamp": 10.0, "start_timestamp": 10.0,
        "command": "hotkey('command', 's')", "args": {"keys": ["command", "s"]}}),
    );
    std::fs::write(
        dir.join(format!("{name}_preprocessed.jsonl")),
        lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
    )
    .unwrap();
    let iso = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339()
    };
    std::fs::write(
        dir.join(format!("{name}_metadata.json")),
        json!({"start_time": iso(start), "end_time": iso(start + 12_000)}).to_string(),
    )
    .unwrap();
    actions::ingest(paths, &dir, &name).unwrap().unwrap();
}

fn put_json(t: &DirTarget, rel: &str, v: &Value) {
    let b = serde_json::to_vec_pretty(v).unwrap();
    t.put_bytes(
        &t.key(rel),
        &b,
        "application/json",
        &Sha256::digest(&b).into(),
    )
    .unwrap();
}

/// A scratch library through the real upload code into `<out>/bucket/`, plus
/// the operator's policy files and example issuer responses in `<out>/issuer/`.
fn generate(out: &Path) -> Result<()> {
    std::env::set_var(sync::crypt::KEY_STORE_ENV, "file");
    let paths = MemoryPaths::at(out.join("library"));
    let conn = store::open(&paths)?;
    chunk(&conn, &paths, T0, 3, "quarterly roadmap");
    chunk(&conn, &paths, T0 + 60_000, 2, "incident review");
    std::fs::create_dir_all(paths.audio_dir())?;
    std::fs::write(
        paths.audio_dir().join(format!("{}.m4a", T0 + 5_000)),
        noise(7, 1024),
    )?;
    conn.execute(
        "INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources, transcript_status) VALUES (?1, ?2, ?3, 1024, 'microphone,system', 2)",
        params![T0 + 5_000, T0 + 65_000, format!("{}.m4a", T0 + 5_000)],
    )?;
    let aid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (?1, ?2, ?3, 'we ship the roadmap on friday')",
        params![aid, T0 + 7_000, T0 + 10_000],
    )?;
    let (a, b, c): (&[u8], &[u8], &[u8]) = (
        b"\xff\xd8synthetic screen one",
        b"\xff\xd8synthetic screen two",
        b"\xff\xd8synthetic screen three",
    );
    action_segment(&paths, T0 + 1_000, &[a, b, a]);
    action_segment(&paths, T0 + 60_500, &[b, c]);

    let t = DirTarget {
        root: out.join("bucket"),
        sent: AtomicU64::new(0),
    };
    let s = Settings::default();
    let stop = AtomicBool::new(false);
    let ctx = Ctx {
        paths: &paths,
        t: &t,
        device: DEVICE,
        key: None,
        stop: &stop,
        settings: &s,
    };
    for st in [
        sync::upload_pending(&conn, &ctx, &s.sync)?,
        sync::upload_pending_audio(&conn, &ctx, &s.sync)?,
        sync::upload_pending_actions(&conn, &ctx, &s.sync)?,
    ] {
        let errors: Option<String> = conn.query_row(
            "SELECT group_concat(upload_error, ' | ') FROM (SELECT upload_error FROM video UNION ALL SELECT upload_error FROM audio UNION ALL SELECT upload_error FROM action_segment)",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(st.failed, 0, "{errors:?}");
    }
    sync::flush_index(&conn, &ctx)?;

    // device.json from the engine, with this machine's identity replaced by synthetic values.
    let mut device = sync::device_json(&ctx, &conn);
    device["machine_key_sha256"] = json!(hex(b"synthetic machine key"));
    device["hostname"] = json!("fixture-host.local");
    device["computer_name"] = json!("Fixture Computer");
    device["os"] = json!("macos");
    device["os_version"] = json!("26.0");
    device["arch"] = json!("aarch64");
    device["member"] = json!({"email": "person@example.com"});
    device["updated_at_ms"] = json!(T0 + 120_000);
    put_json(&t, &format!("{DEVICE}/device.json"), &device);

    let mut status = cli::device_status(&paths, sync::app_version());
    status["reportedAtMs"] = json!(T0 + 120_000);
    status["recording"] = json!("recording");
    status["reason"] = Value::Null;
    status["lastFrameMs"] = json!(T0 + 62_000);
    status["actionsRecording"] = json!(true);
    status["policy"] = json!({"source": format!("{PREFIX}/policy.json"), "updatedAtMs": T0, "fetchedAtMs": T0 + 60_000});
    put_json(&t, &format!("{DEVICE}/status.json"), &status);

    put_json(
        &t,
        "policy.json",
        &json!({"schema": 2, "layers": {"screen": true, "actions": true, "audio": false},
        "privacy": {"redact_pii": false, "excluded_bundle_ids": ["com.example.vault"], "excluded_domains": ["bank.example"],
            "exclusion_groups": ["password_managers"], "exclude_private_browsing": true}, "retention": {"local_hours": 24, "remote_days": 90},
        "recording": {"paused": false, "paused_until_ms": null},
        "notice": "Your organization records this computer's screen and actions for support.", "updated_at_ms": T0}),
    );

    let issuer = out.join("issuer");
    std::fs::create_dir_all(&issuer)?;
    for (file, v) in [
        (
            "device-authorization.json",
            json!({"device_code": "synthetic-device-code", "user_code": "WDJB-MJHT",
            "verification_uri": "https://issuer.example/device", "verification_uri_complete": "https://issuer.example/device?user_code=WDJB-MJHT",
            "interval": 5, "expires_in": 900}),
        ),
        (
            "device-token.json",
            json!({"device_token": "synthetic-device-token", "prefix": PREFIX, "device_id": DEVICE,
            "member": {"email": "person@example.com"}}),
        ),
        (
            "device-token-pending.json",
            json!({"error": "authorization_pending"}),
        ),
        (
            "credentials.json",
            json!({"endpoint": "https://s3.us-east-1.amazonaws.com", "bucket": "example-capture-bucket",
            "region": "us-east-1", "prefix": PREFIX, "device_id": DEVICE, "access_key_id": "ASIASYNTHETICEXAMPLE",
            "secret_access_key": "synthetic/secret/access/key", "session_token": "synthetic-session-token",
            "expires_at_ms": T0 + 3_600_000, "path_style": false}),
        ),
    ] {
        let mut body = serde_json::to_vec_pretty(&v)?;
        body.push(b'\n');
        std::fs::write(issuer.join(file), body)?;
    }
    drop(conn);
    std::fs::remove_dir_all(&paths.root)?;
    Ok(())
}
