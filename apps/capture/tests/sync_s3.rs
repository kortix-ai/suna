//! Cloud sync against a real S3 gateway (versitygw, which verifies SigV4 and
//! checksums). Each test starts its own gateway on a free port with its own
//! data directory, so the tests can kill and restart it.
//!
//! Runs when `KORTIX_CAPTURE_TEST_VERSITYGW` points at a versitygw binary;
//! otherwise every test passes without doing anything (and says so):
//!
//! ```text
//! KORTIX_CAPTURE_TEST_VERSITYGW=/path/to/versitygw cargo test --features capture-engine --test sync_s3
//! ```

use base64::Engine as _;
use kortix_backend::memory::{
    actions,
    paths::MemoryPaths,
    policy,
    settings::Settings,
    store,
    sync::{
        self, crypt, restore, s3, target, Ctx, ErrorClass, Runtime, S3Target, SyncCredentials,
        UploadTarget,
    },
    timerange::TimeRange,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

const ACCESS: &str = "synctest";
const SECRET: &str = "synctest-secret-123";
const BUCKET: &str = "capture";
const MIB: usize = 1024 * 1024;

struct Gateway {
    bin: PathBuf,
    dir: PathBuf,
    port: u16,
    child: Option<Child>,
}

impl Gateway {
    /// None (test skipped) without KORTIX_CAPTURE_TEST_VERSITYGW.
    fn start() -> Option<Self> {
        let Ok(bin) = std::env::var("KORTIX_CAPTURE_TEST_VERSITYGW") else {
            eprintln!("skipped: set KORTIX_CAPTURE_TEST_VERSITYGW to a versitygw binary to run the S3 sync tests");
            return None;
        };
        std::env::set_var(crypt::KEY_STORE_ENV, "file");
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let dir = std::env::temp_dir().join(format!("kcap-gw-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut gw = Self {
            bin: bin.into(),
            dir,
            port,
            child: None,
        };
        gw.spawn();
        gw.create_bucket(BUCKET);
        Some(gw)
    }

    fn spawn(&mut self) {
        let log = std::fs::File::create(self.dir.with_extension("log")).unwrap();
        let mut child = Command::new(&self.bin)
            .args([
                "--port",
                &format!("127.0.0.1:{}", self.port),
                "--access",
                ACCESS,
                "--secret",
                SECRET,
                "posix",
            ])
            .arg(&self.dir)
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .stdin(Stdio::null())
            .spawn()
            .expect("start versitygw");
        // Ready = this child answers S3 on the port. Tests start gateways in
        // parallel, so a bare TCP connect can reach a port another process
        // took between choosing it and versitygw binding it.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "versitygw exited (port {} taken?)",
                self.port
            );
            let ready = reqwest::blocking::Client::new()
                .get(self.endpoint())
                .timeout(Duration::from_secs(2))
                .send()
                .is_ok_and(|r| r.headers().get("server").is_some_and(|v| v == "VERSITYGW"));
            if ready {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "versitygw did not answer on {}",
                self.port
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        self.child = Some(child);
    }

    fn kill(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn create_bucket(&self, name: &str) {
        let bucket = rusty_s3::Bucket::new(
            url::Url::parse(&self.endpoint()).unwrap(),
            rusty_s3::UrlStyle::Path,
            name.to_string(),
            "us-east-1".to_string(),
        )
        .unwrap();
        let creds = rusty_s3::Credentials::new(ACCESS, SECRET);
        let url = rusty_s3::S3Action::sign(&bucket.create_bucket(&creds), Duration::from_secs(60));
        let resp = reqwest::blocking::Client::new().put(url).send().unwrap();
        assert!(
            resp.status().is_success(),
            "create bucket: {}",
            resp.status()
        );
    }

    fn target(&self, prefix: &str, access: &str, secret: &str) -> S3Target {
        S3Target::new(
            &self.endpoint(),
            BUCKET,
            "us-east-1",
            prefix,
            true,
            access,
            secret,
            None,
        )
        .unwrap()
    }

    fn keys(&self, prefix: &str) -> Vec<String> {
        let mut k: Vec<String> = self
            .target("", ACCESS, SECRET)
            .list(prefix, None)
            .unwrap()
            .0
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        k.sort();
        k
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = std::fs::remove_file(self.dir.with_extension("log"));
    }
}

struct Lib {
    paths: MemoryPaths,
    conn: Connection,
}

impl Lib {
    fn new(gw: &Gateway, configure: impl FnOnce(&mut Settings)) -> Self {
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kcap-lib-{}", uuid::Uuid::new_v4().simple())),
        );
        let conn = store::open(&paths).unwrap();
        let mut s = Settings::default();
        s.sync.enabled = true;
        s.sync.s3.endpoint = gw.endpoint();
        s.sync.s3.bucket = BUCKET.into();
        s.sync.s3.path_style = true;
        s.sync.s3.prefix = "kc".into();
        s.sync.part_mb = 5;
        configure(&mut s);
        s.save(&paths).unwrap();
        sync::save_credentials(
            &paths,
            &SyncCredentials {
                access_key_id: ACCESS.into(),
                secret_access_key: SECRET.into(),
                session_token: None,
            },
        )
        .unwrap();
        Self { paths, conn }
    }

    fn settings(&self) -> Settings {
        Settings::load(&self.paths)
    }

    fn count(&self, sql: &str) -> i64 {
        self.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// Run sync passes until nothing is pending (or a pass stops with an error).
    fn sync(&self, device: &str) -> anyhow::Result<()> {
        let stop = AtomicBool::new(false);
        let mut rt = Runtime::default();
        for _ in 0..5 {
            self.conn
                .execute("UPDATE video SET next_upload_at = NULL", [])
                .unwrap();
            self.conn
                .execute("UPDATE audio SET next_upload_at = NULL", [])
                .unwrap();
            self.conn
                .execute("UPDATE action_segment SET next_upload_at = NULL", [])
                .unwrap();
            self.conn
                .execute("UPDATE sync_tombstone SET next_at = 0", [])
                .unwrap();
            sync::pass(
                &self.conn,
                &self.paths,
                &self.settings(),
                device,
                &stop,
                &mut rt,
            )?;
            if self.count("SELECT count(*) FROM video WHERE uploaded_at IS NULL AND status < 2")
                == 0
                && self.count("SELECT count(*) FROM audio WHERE uploaded_at IS NULL AND status < 2")
                    == 0
                && self.count(
                    "SELECT count(*) FROM action_segment WHERE uploaded_at IS NULL AND status < 2",
                ) == 0
                && self.count("SELECT count(*) FROM sync_tombstone") == 0
            {
                return Ok(());
            }
        }
        anyhow::bail!(
            "sync did not converge: {:?}",
            self.conn.query_row(
                "SELECT group_concat(upload_error, ' | ') FROM video",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
        )
    }

    /// A chunk of `frames` frames with OCR boxes, windows, AX trees, an app icon and a domain.
    fn chunk(&self, start: i64, frames: i64, words: &str, video_bytes: usize) -> (i64, Vec<u8>) {
        let c = &self.conn;
        let icon = self.paths.icons_dir().join("com.example.editor.png");
        std::fs::write(&icon, b"\x89PNG fake icon").unwrap();
        std::fs::write(
            self.paths.icons_dir().join("domain_docs.example.org.ico"),
            b"ICO fake",
        )
        .unwrap();
        let app = store::upsert_application(c, "com.example.editor", "2.1", "Editor")
            .unwrap()
            .id;
        c.execute("UPDATE application SET icon_path = 'icons/com.example.editor.png', is_user_app = 1 WHERE id = ?1", [app]).unwrap();
        let other = store::upsert_application(c, "com.example.chat", "", "Chat")
            .unwrap()
            .id;
        let dom = store::upsert_domain(c, "docs.example.org").unwrap();
        c.execute(
            "UPDATE domain SET icon_path = 'icons/domain_docs.example.org.ico' WHERE id = ?1",
            [dom],
        )
        .unwrap();
        // Deterministic, incompressible-ish video bytes.
        let mut video = Vec::with_capacity(video_bytes);
        let mut x: u64 = start as u64 ^ 0x9E37_79B9_7F4A_7C15;
        while video.len() < video_bytes {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            video.extend_from_slice(&x.to_le_bytes());
        }
        video.truncate(video_bytes);
        let name = format!("{:x}.mp4", Sha256::digest(start.to_string().as_bytes()));
        std::fs::write(self.paths.videos_dir().join(&name), &video).unwrap();
        c.execute(
            "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (900, 1600, ?1, ?2, ?3, ?4, ?5)",
            params![name, frames, video_bytes as i64, start, start + (frames - 1) * 2000],
        )
        .unwrap();
        let vid = c.last_insert_rowid();
        c.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (0, ?1, ?2, 'https://docs.example.org/guide')", params![app, dom]).unwrap();
        let seg = c.last_insert_rowid();
        for i in 0..frames {
            let fg = format!("{words} frame {i} invoice 4815162342");
            let bg = format!("sidebar {i}");
            c.execute(
                "INSERT INTO frame(timestamp, video, video_index, width, height, title, foreground, background, segment, ocr_status,
                                   capture_display_x, capture_display_y, capture_display_width, capture_display_height, capture_reason, dhash)
                 VALUES (?1, ?2, ?3, 1600, 900, 'Guide — Editor', ?4, ?5, ?6, 1, 0, 0, 1600, 900, 'interval', 'abcd')",
                params![start + i * 2000, vid, i, fg, bg, seg],
            )
            .unwrap();
            let fid = c.last_insert_rowid();
            let fg_len = fg.chars().count() as i64;
            c.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, 10, 20, 300, 18, 0, ?2)", params![fid, fg_len]).unwrap();
            c.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, 0, 0, 80, 18, ?2, 7)", params![fid, fg_len]).unwrap();
            c.execute(
                "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, z_order, is_focussed_window, url) VALUES (?1, ?2, 'Guide', 0, 0, 1200, 900, 0, 1, 'https://docs.example.org/guide')",
                params![fid, app],
            )
            .unwrap();
            c.execute("INSERT INTO window_bound(frame, application, window_title, x, y, width, height, z_order, is_focussed_window) VALUES (?1, ?2, 'Chat', 1200, 0, 400, 900, 1, 0)", params![fid, other]).unwrap();
            // Recorded text keeps NULL and "" apart; restore must too.
            c.execute("INSERT INTO window_bound(frame, application, window_title, x, y, width, height, z_order, is_focussed_window) VALUES (?1, ?2, '', 0, 0, 1, 1, 2, 0)", params![fid, other]).unwrap();
            if i % 2 == 1 {
                c.execute(
                    "UPDATE frame SET background = NULL, title = '' WHERE id = ?1",
                    [fid],
                )
                .unwrap();
            }
            let payload = format!(
                r#"{{"role":"AXWindow","title":"Guide","children":[{{"role":"AXStaticText","value":"{words} {i}"}}]}}"#
            );
            let hash = Sha256::digest(payload.as_bytes()).to_vec();
            c.execute(
                "INSERT OR IGNORE INTO ax_blob(hash, payload) VALUES (?1, ?2)",
                params![hash, zstd::encode_all(payload.as_bytes(), 3).unwrap()],
            )
            .unwrap();
            c.execute(
                "INSERT INTO ax_snapshot(frame_id, hash, timestamp_ms, application_name, bundle_id, process_identifier, node_count) VALUES (?1, ?2, ?3, 'Editor', 'com.example.editor', 77, 2)",
                params![fid, hash, start + i * 2000],
            )
            .unwrap();
        }
        (vid, video)
    }

    /// An encoded audio segment of `bytes` bytes with one transcript line containing `words`.
    fn audio(&self, start: i64, words: &str, bytes: usize) -> (i64, Vec<u8>) {
        std::fs::create_dir_all(self.paths.audio_dir()).unwrap();
        let mut body = Vec::with_capacity(bytes);
        let mut x: u64 = start as u64 ^ 0xA5A5_5A5A_1234_5678;
        while body.len() < bytes {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            body.extend_from_slice(&x.to_le_bytes());
        }
        body.truncate(bytes);
        let name = format!("{start}.m4a");
        std::fs::write(self.paths.audio_dir().join(&name), &body).unwrap();
        self.conn
            .execute(
                "INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources, transcript_status) VALUES (?1, ?2, ?3, ?4, 'microphone,system', 2)",
                params![start, start + 60_000, name, bytes as i64],
            )
            .unwrap();
        let id = self.conn.last_insert_rowid();
        self.conn
            .execute(
                "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (?1, ?2, ?3, ?4)",
                params![id, start + 2_000, start + 5_000, words],
            )
            .unwrap();
        (id, body)
    }

    /// One action segment (a click and a typed word, each with screenshots
    /// `shots`, synthetic JPEG bytes) ingested like the tray does. Returns its id.
    fn actions(&self, start: i64, shots: &[&[u8]]) -> i64 {
        let root = self.paths.root.join("spool");
        let name = format!("seg_{start}");
        let dir = root.join(&name);
        std::fs::create_dir_all(&dir).unwrap();
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let mut lines = Vec::new();
        for (i, shot) in shots.iter().enumerate() {
            let t = 1.0 + i as f64;
            lines.push(serde_json::json!({"type": "click", "timestamp": t, "start_timestamp": t - 0.1,
                "command": "click(x=0.5000, y=0.5000)", "args": {"x": 0.5, "y": 0.5, "button": "left", "clicks": 1}}));
            lines.push(
                serde_json::json!({"type": "screenshot", "timestamp": t + 0.2, "command": "",
                "args": {"image": b64(shot), "width": 8, "height": 8}}),
            );
        }
        lines.push(
            serde_json::json!({"type": "typewrite", "timestamp": 9.0, "start_timestamp": 8.5,
            "command": "typewrite('roadmap')", "args": {"text": "roadmap"}}),
        );
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(dir.join(format!("{name}_preprocessed.jsonl")), text).unwrap();
        let iso = |ms: i64| {
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc3339()
        };
        std::fs::write(
            dir.join(format!("{name}_metadata.json")),
            serde_json::json!({"start_time": iso(start), "end_time": iso(start + 30_000)})
                .to_string(),
        )
        .unwrap();
        actions::ingest(&self.paths, &dir, &name)
            .unwrap()
            .unwrap()
            .id
    }

    /// Action segments as restore must reproduce them: times, counts,
    /// screenshots, the decoded lines, and every screenshot's bytes.
    fn actions_fingerprint(&self) -> Vec<String> {
        let mut st = self
            .conn
            .prepare("SELECT start_ms, end_ms, event_count, screenshots, path, status FROM action_segment ORDER BY start_ms")
            .unwrap();
        let rows: Vec<(i64, i64, i64, String, String, i64)> = st
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let mut out = Vec::new();
        for (start, end, n, shots, path, status) in rows {
            out.push(format!("{start}|{end}|{n}|{shots}"));
            if status != 3 {
                for l in actions::read_lines(&self.paths, &path).unwrap() {
                    out.push(l.to_string());
                }
            }
            for name in actions::screenshots_of(&shots) {
                let f = actions::assets_dir(&self.paths).join(&name);
                if let Ok(b) = std::fs::read(&f) {
                    out.push(format!("{name}={:x}", Sha256::digest(&b)));
                }
            }
        }
        out
    }

    fn heard(&self, q: &str) -> Vec<(i64, String)> {
        let mut st = self
            .conn
            .prepare("SELECT t.start_ms, t.text FROM audio_fts JOIN audio_transcript t ON t.id = audio_fts.rowid WHERE audio_fts MATCH ?1 ORDER BY t.start_ms")
            .unwrap();
        st.query_map([q], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn fts(&self, q: &str) -> Vec<(i64, String)> {
        let mut st = self
            .conn
            .prepare("SELECT f.timestamp, f.foreground FROM ocr_fts JOIN frame f ON f.id = ocr_fts.rowid WHERE ocr_fts MATCH ?1 ORDER BY f.timestamp")
            .unwrap();
        st.query_map([q], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// Everything restore must reproduce, in a comparable form.
    fn fingerprint(&self) -> Vec<String> {
        let q = |sql: &str| -> Vec<String> {
            let mut st = self.conn.prepare(sql).unwrap();
            let n = st.column_count();
            st.query_map([], |r| {
                Ok((0..n)
                    .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
        };
        let mut out = Vec::new();
        out.extend(q("SELECT f.timestamp, f.video_index, f.width, f.height, f.title, f.foreground, f.background, f.capture_reason, f.dhash,
                             a.bundle_id, a.display_name, d.normalized_domain, s.url
                      FROM frame f LEFT JOIN segment s ON s.id = f.segment LEFT JOIN application a ON a.id = s.application
                      LEFT JOIN domain d ON d.id = s.domain ORDER BY f.timestamp"));
        out.extend(q("SELECT f.timestamp, o.x, o.y, o.width, o.height, o.text_offset, o.text_length FROM ocr o JOIN frame f ON f.id = o.frame ORDER BY f.timestamp, o.text_offset"));
        out.extend(q("SELECT f.timestamp, a.bundle_id, w.window_title, w.x, w.y, w.width, w.height, w.z_order, w.is_focussed_window, w.url
                      FROM window_bound w JOIN frame f ON f.id = w.frame JOIN application a ON a.id = w.application ORDER BY f.timestamp, w.z_order"));
        out.extend(q("SELECT f.timestamp, s.node_count, s.bundle_id FROM ax_snapshot s JOIN frame f ON f.id = s.frame_id ORDER BY f.timestamp"));
        out.extend(q("SELECT bundle_id FROM application ORDER BY bundle_id"));
        out.extend(q("SELECT normalized_domain FROM domain ORDER BY 1"));
        out.extend(q("SELECT path, num_frames, width, height, start_timestamp, end_timestamp FROM video ORDER BY start_timestamp"));
        out.extend(self.segments());
        out
    }

    /// Which frames share a segment (search collapses repeats within one).
    fn segments(&self) -> Vec<String> {
        let mut st = self.conn.prepare("SELECT group_concat(timestamp) FROM (SELECT segment, timestamp FROM frame ORDER BY timestamp) GROUP BY segment ORDER BY min(timestamp)").unwrap();
        st.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// The FTS index matches its content and holds exactly one entry per frame.
    fn assert_fts_exact(&self) {
        self.conn
            .execute(
                "INSERT INTO ocr_fts(ocr_fts) VALUES ('integrity-check')",
                [],
            )
            .expect("FTS index matches the frame table");
        let indexed = self.count("SELECT count(*) FROM ocr_fts_docsize");
        let frames = self.count("SELECT count(*) FROM frame");
        assert_eq!(indexed, frames, "one FTS row per frame");
    }

    /// Hits of the real `kortix-capture query fts` (which collapses repeats per segment).
    fn cli_fts(&self, q: &str) -> Vec<serde_json::Value> {
        let out = Command::new(env!("CARGO_BIN_EXE_kortix-capture"))
            .args(["--json", "query", "fts", q, "--limit", "100"])
            .env("KORTIX_CAPTURE_DIR", &self.paths.root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }

    fn ax_texts(&self) -> Vec<String> {
        let mut st = self.conn.prepare("SELECT b.payload FROM ax_snapshot s JOIN ax_blob b ON b.hash = s.hash JOIN frame f ON f.id = s.frame_id ORDER BY f.timestamp").unwrap();
        st.query_map([], |r| r.get::<_, Vec<u8>>(0))
            .unwrap()
            .map(|p| {
                let v: serde_json::Value =
                    serde_json::from_slice(&zstd::decode_all(p.unwrap().as_slice()).unwrap())
                        .unwrap();
                v.to_string()
            })
            .collect()
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.paths.root);
    }
}

fn bytes_of(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

fn now() -> i64 {
    store::now_ms()
}

#[test]
fn checksum_header_is_enforced_by_the_server() {
    let Some(gw) = Gateway::start() else { return };
    let t = gw.target("kc", ACCESS, SECRET);
    let body = b"frame sidecar bytes";
    // The body is "corrupted in transit": its checksum is of other bytes.
    let wrong: [u8; 32] = Sha256::digest(b"something else").into();
    let err = t
        .put_bytes(&t.key("dev/bad"), body, "text/plain", &wrong)
        .unwrap_err();
    assert_eq!(sync::classify(&err), ErrorClass::Integrity, "{err:#}");
    assert!(format!("{err:#}").contains("BadDigest"), "{err:#}");
    assert_eq!(
        t.head(&t.key("dev/bad")).unwrap(),
        None,
        "a corrupt body is never stored"
    );
    t.put_bytes(
        &t.key("dev/good"),
        body,
        "text/plain",
        &Sha256::digest(body).into(),
    )
    .unwrap();
    assert_eq!(t.head(&t.key("dev/good")).unwrap(), Some(body.len() as u64));
}

#[test]
fn round_trip_restores_search_timeline_icons_and_video() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |s| s.sync.keep_local_hours = 0);
    let t0 = now() - 3_600_000;
    let (_, v1) = a.chunk(t0, 5, "quarterly roadmap", 300_000);
    let (_, v2) = a.chunk(t0 + 60_000, 4, "incident review", 12 * MIB + 123); // multipart: 3 parts of 5 MiB
    let (_, v3) = a.chunk(t0 + 120_000, 3, "design critique", 1);
    a.sync("dev-a").unwrap();
    assert_eq!(
        a.count("SELECT count(*) FROM video WHERE status = 3"),
        3,
        "all chunks remote-only after upload"
    );
    assert_eq!(
        std::fs::read_dir(a.paths.videos_dir()).unwrap().count(),
        0,
        "local videos released"
    );
    assert_eq!(
        a.count("SELECT count(*) FROM sync_multipart"),
        0,
        "no multipart upload left open"
    );

    let keys = gw.keys("kc/dev-a/");
    let count = |suffix: &str| keys.iter().filter(|k| k.ends_with(suffix)).count();
    assert_eq!(
        (
            count(".mp4"),
            count(".frames.jsonl.zst"),
            count(".manifest.json")
        ),
        (3, 3, 3),
        "{keys:#?}"
    );
    assert_eq!(
        keys.iter().filter(|k| k.contains("/index/")).count(),
        1,
        "one daily index: {keys:#?}"
    );
    assert_eq!(
        keys.iter().filter(|k| k.contains("/assets/")).count(),
        2,
        "two icons, uploaded once: {keys:#?}"
    );
    assert!(keys.contains(&"kc/dev-a/device.json".to_string()));

    // The manifest names exact sizes and checksums that match the stored objects.
    let t = gw.target("kc", ACCESS, SECRET);
    let mkey = keys
        .iter()
        .find(|k| k.ends_with(".manifest.json") && k.contains(&format!("{}-", t0 + 60_000)))
        .unwrap();
    let m: serde_json::Value =
        serde_json::from_slice(&t.get_bytes(mkey).unwrap().unwrap()).unwrap();
    assert_eq!(
        (
            m["schema"].as_i64(),
            m["frame_count"].as_i64(),
            m["start_ms"].as_i64()
        ),
        (Some(2), Some(4), Some(t0 + 60_000))
    );
    assert_eq!(m["privacy"]["redact_pii"], false);
    assert_eq!(m["kind"], "chunk");
    let vkey = t.key(m["objects"]["video"]["key"].as_str().unwrap());
    let stored = t.get_bytes(&vkey).unwrap().unwrap();
    assert_eq!(stored, v2, "multipart object is byte-identical");
    assert_eq!(
        m["objects"]["video"]["sha256"].as_str().unwrap(),
        s3::hex(&Sha256::digest(&stored))
    );
    assert_eq!(
        m["objects"]["video"]["size"].as_u64(),
        Some(v2.len() as u64)
    );

    // Restore into an empty library B and compare.
    let b = Lib::new(&gw, |_| {});
    let r = restore::restore(&b.paths, &t, "dev-a", None, &mut |_| {}).unwrap();
    assert_eq!(
        (
            r.source.as_str(),
            r.chunks_listed,
            r.chunks_restored,
            r.frames,
            r.icons
        ),
        ("index", 3, 3, 12, 2),
        "{r:?}"
    );
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(
        a.fingerprint(),
        b.fingerprint(),
        "frames, OCR boxes, windows, AX, apps, domains, videos, segments"
    );
    a.assert_fts_exact();
    b.assert_fts_exact();
    assert_eq!(a.ax_texts(), b.ax_texts());
    for q in [
        "roadmap",
        "invoice",
        "4815162342",
        "critique OR review",
        "sidebar",
    ] {
        assert_eq!(a.fts(q), b.fts(q), "search {q}");
    }
    assert_eq!(b.fts("invoice").len(), 12);
    assert_eq!(
        bytes_of(&b.paths.icons_dir().join(format!(
            "sha256-{}.png",
            s3::hex(&Sha256::digest(b"\x89PNG fake icon"))
        ))),
        b"\x89PNG fake icon"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM application WHERE icon_path IS NOT NULL"),
        1
    );
    assert_eq!(
        b.count("SELECT count(*) FROM domain WHERE icon_path IS NOT NULL"),
        1
    );
    // Videos stream on demand, verified against the manifest checksum.
    for (start, want) in [(t0, &v1), (t0 + 60_000, &v2), (t0 + 120_000, &v3)] {
        let id: i64 = b
            .conn
            .query_row(
                "SELECT id FROM video WHERE start_timestamp = ?1",
                [start],
                |r| r.get(0),
            )
            .unwrap();
        let path = sync::fetch_remote(&b.conn, &b.paths, id).unwrap().unwrap();
        assert_eq!(&bytes_of(&path), want);
    }
    // Restore is idempotent; --from skips older chunks.
    let again = restore::restore(&b.paths, &t, "dev-a", None, &mut |_| {}).unwrap();
    assert_eq!(
        (again.chunks_restored, again.chunks_already_present),
        (0, 3)
    );
    let c = Lib::new(&gw, |_| {});
    let partial = restore::restore(&c.paths, &t, "dev-a", Some(t0 + 62_000), &mut |_| {}).unwrap();
    assert_eq!(
        (partial.chunks_listed, partial.frames),
        (2, 7),
        "{partial:?}"
    );
}

#[test]
fn encrypted_bucket_holds_ciphertext_and_restores_with_the_key() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |s| s.sync.encrypt = true);
    let t0 = now() - 600_000;
    let (_, v1) = a.chunk(t0, 3, "confidential merger", 7 * MIB); // multipart, encrypted
    a.sync("dev-enc").unwrap();
    let key_id = a.settings().sync.key_id;
    assert_eq!(key_id.len(), 16);

    let t = gw.target("kc", ACCESS, SECRET);
    for k in gw.keys("kc/dev-enc/") {
        let body = t.get_bytes(&k).unwrap().unwrap();
        if k.ends_with("device.json") {
            let d: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(d["encryption"]["key_id"].as_str(), Some(key_id.as_str()));
            assert!(
                d["hostname"].is_null() && d["computer_name"].is_null(),
                "no host or computer name in an encrypted bucket"
            );
            continue;
        }
        if k.ends_with("status.json") {
            // Plain JSON for every reader, and no recorded content in it.
            let st: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert!(st["reportedAtMs"].is_i64());
            assert!(!String::from_utf8_lossy(&body).contains("merger"));
            continue;
        }
        assert!(crypt::is_encrypted(&body), "{k} is ciphertext");
        assert_eq!(crypt::key_id_of(&body).as_deref(), Some(key_id.as_str()));
        let hay = String::from_utf8_lossy(&body);
        assert!(
            !hay.contains("merger") && !hay.contains("example"),
            "{k} leaks plaintext"
        );
    }

    // Without the key restore fails closed and writes nothing.
    let b = Lib::new(&gw, |_| {});
    let err = restore::restore(&b.paths, &t, "dev-enc", None, &mut |_| {}).unwrap_err();
    assert_eq!(sync::classify(&err), ErrorClass::Config, "{err:#}");
    assert!(format!("{err:#}").contains("sync key import"), "{err:#}");
    assert_eq!(b.count("SELECT count(*) FROM frame"), 0);

    // With the exported key it restores, and playback decrypts.
    let exported = crypt::load(&a.paths, &key_id).unwrap().to_b64();
    crypt::store(&b.paths, &crypt::Key::from_b64(&exported).unwrap()).unwrap();
    let r = restore::restore(&b.paths, &t, "dev-enc", None, &mut |_| {}).unwrap();
    assert_eq!((r.chunks_restored, r.frames), (1, 3), "{r:?}");
    assert_eq!(a.fts("merger"), b.fts("merger"));
    let id: i64 = b
        .conn
        .query_row("SELECT id FROM video", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        bytes_of(&sync::fetch_remote(&b.conn, &b.paths, id).unwrap().unwrap()),
        v1
    );
}

#[test]
fn multipart_upload_resumes_after_the_gateway_dies_mid_upload() {
    let Some(mut gw) = Gateway::start() else {
        return;
    };
    let a = Lib::new(&gw, |_| {});
    let (vid, video) = a.chunk(now() - 600_000, 2, "resume test", 20 * MIB); // 4 parts of 5 MiB
    let file = a.paths.videos_dir().join(
        a.conn
            .query_row::<String, _, _>("SELECT path FROM video WHERE id = ?1", [vid], |r| r.get(0))
            .unwrap(),
    );
    let key = "kc/dev-r/video.mp4";
    let stop = AtomicBool::new(false);

    // Upload at 8 MB/s in a thread; kill the gateway once 2 parts are recorded.
    let paths = a.paths.clone();
    let endpoint = gw.endpoint();
    let (file2, key2) = (file.clone(), key.to_string());
    let worker = std::thread::spawn(move || {
        let conn = store::open(&paths).unwrap();
        let t = S3Target::new(
            &endpoint,
            BUCKET,
            "us-east-1",
            "kc",
            true,
            ACCESS,
            SECRET,
            None,
        )
        .unwrap()
        .with_part_size(5 * MIB as u64)
        .with_bandwidth(8 * MIB as u64);
        let stop = AtomicBool::new(false);
        let settings = Settings::default();
        let ctx = Ctx {
            paths: &paths,
            t: &t,
            device: "dev-r",
            key: None,
            stop: &stop,
            settings: &settings,
        };
        let (size, digest) = target::file_digest(&file2).unwrap();
        sync::put_file_resumable(&conn, &ctx, &key2, &file2, size, &digest, "video/mp4")
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    while a.count("SELECT count(*) FROM sync_part") < 2 {
        assert!(Instant::now() < deadline, "parts never recorded");
        std::thread::sleep(Duration::from_millis(20));
    }
    gw.kill();
    let err = worker.join().unwrap().unwrap_err();
    assert_eq!(
        sync::classify(&err),
        ErrorClass::Transient,
        "a dead gateway is transient: {err:#}"
    );
    let done = a.count("SELECT count(*) FROM sync_part");
    assert!(
        (2..4).contains(&done),
        "{done} parts recorded before the kill"
    );
    assert_eq!(
        a.count("SELECT count(*) FROM sync_multipart"),
        1,
        "the upload id survives for the resume"
    );

    // Restart on the same data dir: the next attempt sends only the missing parts.
    gw.spawn();
    let t = gw
        .target("kc", ACCESS, SECRET)
        .with_part_size(5 * MIB as u64);
    let settings = Settings::default();
    let ctx = Ctx {
        paths: &a.paths,
        t: &t,
        device: "dev-r",
        key: None,
        stop: &stop,
        settings: &settings,
    };
    let (size, digest) = target::file_digest(&file).unwrap();
    sync::put_file_resumable(&a.conn, &ctx, key, &file, size, &digest, "video/mp4").unwrap();
    let resent = t.bytes_sent();
    assert_eq!(
        resent,
        size - done as u64 * 5 * MIB as u64,
        "resumed after part {done}, nothing re-sent"
    );
    assert_eq!(size, video.len() as u64);
    assert_eq!(
        t.get_bytes(key).unwrap().unwrap(),
        video,
        "the object is whole and byte-identical"
    );
    assert_eq!(digest, <[u8; 32]>::from(Sha256::digest(&video)));
    assert_eq!(
        gw.keys("kc/dev-r/"),
        vec![key.to_string()],
        "exactly one object, no duplicates"
    );
    assert_eq!(
        a.count("SELECT count(*) FROM sync_multipart") + a.count("SELECT count(*) FROM sync_part"),
        0
    );
}

#[test]
fn sync_pass_survives_a_gateway_restart_and_converges_without_duplicates() {
    let Some(mut gw) = Gateway::start() else {
        return;
    };
    let a = Lib::new(&gw, |s| {
        s.sync.max_upload_kbps = 6 * 1024;
        s.sync.concurrency = 2;
    });
    let t0 = now() - 900_000;
    let mut videos = Vec::new();
    for i in 0..3 {
        videos.push(
            a.chunk(t0 + i * 60_000, 3, &format!("chunk{i}"), 11 * MIB)
                .1,
        );
    }
    let paths = a.paths.clone();
    let worker = std::thread::spawn(move || {
        let conn = store::open(&paths).unwrap();
        let stop = AtomicBool::new(false);
        let mut rt = Runtime::default();
        sync::pass(
            &conn,
            &paths,
            &Settings::load(&paths),
            "dev-k",
            &stop,
            &mut rt,
        )
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    while a.count("SELECT count(*) FROM sync_part") < 1 {
        assert!(Instant::now() < deadline, "no part recorded");
        std::thread::sleep(Duration::from_millis(20));
    }
    gw.kill();
    let _ = worker.join().unwrap();
    assert!(
        a.count("SELECT count(*) FROM video WHERE upload_error_class = 'transient'") >= 1,
        "chunks back off as transient"
    );
    assert_eq!(
        std::fs::read_dir(a.paths.videos_dir()).unwrap().count(),
        3,
        "nothing deleted locally while uploads fail"
    );
    gw.spawn();
    a.sync("dev-k").unwrap();
    let keys = gw.keys("kc/dev-k/");
    assert_eq!(
        keys.iter().filter(|k| k.ends_with(".mp4")).count(),
        3,
        "{keys:#?}"
    );
    let t = gw.target("kc", ACCESS, SECRET);
    for (i, want) in videos.iter().enumerate() {
        let k = keys
            .iter()
            .find(|k| k.contains(&format!("/{}-", t0 + i as i64 * 60_000)) && k.ends_with(".mp4"))
            .unwrap();
        assert_eq!(&t.get_bytes(k).unwrap().unwrap(), want, "{k} is whole");
    }
    assert_eq!(a.count("SELECT count(*) FROM video WHERE status = 3"), 3);
    assert_eq!(
        a.count("SELECT count(*) FROM sync_multipart"),
        0,
        "every multipart upload completed"
    );
}

#[test]
fn wrong_credentials_fail_closed_and_keep_everything_local() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |_| {});
    a.chunk(now() - 600_000, 2, "secret", 1000);
    sync::save_credentials(
        &a.paths,
        &SyncCredentials {
            access_key_id: ACCESS.into(),
            secret_access_key: "wrong-secret".into(),
            session_token: None,
        },
    )
    .unwrap();
    let stop = AtomicBool::new(false);
    let mut rt = Runtime::default();
    let err = sync::pass(&a.conn, &a.paths, &a.settings(), "dev-w", &stop, &mut rt).unwrap_err();
    assert_eq!(sync::classify(&err), ErrorClass::Auth, "{err:#}");
    assert_eq!(a.count("SELECT count(*) FROM video WHERE status = 0 AND uploaded_at IS NULL AND upload_attempts = 0"), 1, "the chunk is untouched, no attempt burned");
    assert_eq!(
        std::fs::read_dir(a.paths.videos_dir()).unwrap().count(),
        1,
        "the local video stays"
    );
    assert!(gw.keys("kc/").is_empty(), "nothing written to the bucket");
    rt.error = Some((format!("{err:#}"), sync::classify(&err)));
    let st = sync::compute_state(&a.conn, &a.paths, &a.settings(), true, "dev-w", &rt);
    assert_eq!(
        (
            st.state.as_str(),
            st.last_error_class.as_deref(),
            st.pending
        ),
        ("error", Some("auth"), 1)
    );
    // Fixing the credentials resumes.
    sync::save_credentials(
        &a.paths,
        &SyncCredentials {
            access_key_id: ACCESS.into(),
            secret_access_key: SECRET.into(),
            session_token: None,
        },
    )
    .unwrap();
    a.sync("dev-w").unwrap();
    assert_eq!(a.count("SELECT count(*) FROM video WHERE status = 3"), 1);
}

#[test]
fn clock_skew_is_detected_and_corrected() {
    let Some(gw) = Gateway::start() else { return };
    // A clock 3 h behind signs URLs that already expired: the server says 403 and
    // sends its Date; the client adopts the offset and the retry succeeds.
    let t = gw
        .target("kc", ACCESS, SECRET)
        .with_clock_offset(-3 * 3_600_000);
    t.put_bytes(
        &t.key("dev/skew-behind"),
        b"x",
        "text/plain",
        &Sha256::digest(b"x").into(),
    )
    .unwrap();
    assert!(
        t.clock_offset_ms().abs() < 60_000,
        "corrected to {} ms",
        t.clock_offset_ms()
    );
    assert_eq!(t.head(&t.key("dev/skew-behind")).unwrap(), Some(1));
    // A clock 3 h ahead: a presigned URL is valid until it expires, so the server
    // accepts it (or, if it rejects it, the same correction applies).
    let t = gw
        .target("kc", ACCESS, SECRET)
        .with_clock_offset(3 * 3_600_000);
    t.put_bytes(
        &t.key("dev/skew-ahead"),
        b"x",
        "text/plain",
        &Sha256::digest(b"x").into(),
    )
    .unwrap();
    assert_eq!(t.head(&t.key("dev/skew-ahead")).unwrap(), Some(1));
}

#[test]
fn local_deletion_and_remote_retention_delete_bucket_objects() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |_| {});
    let day = 86_400_000;
    let t0 = now() - 3 * day;
    a.chunk(t0, 2, "ancient", 1000);
    a.chunk(now() - 7_200_000, 2, "keep", 1000);
    a.chunk(now() - 3_600_000, 2, "forget", 1000);
    a.sync("dev-d").unwrap();
    assert_eq!(
        gw.keys("kc/dev-d/")
            .iter()
            .filter(|k| k.ends_with(".mp4"))
            .count(),
        3
    );

    // Local forget: the chunk's three objects leave the bucket and the index records it.
    let range = TimeRange {
        start: Some(now() - 3_600_000),
        end: Some(now() - 3_600_000 + 1000),
    };
    let r = sync::forget(&a.conn, &a.paths, &a.settings(), "dev-d", range, false).unwrap();
    assert_eq!((r.chunks, r.frames, r.remote_objects_queued), (1, 2, 3));
    a.sync("dev-d").unwrap();
    let keys = gw.keys("kc/dev-d/");
    assert_eq!(
        keys.iter().filter(|k| k.ends_with(".mp4")).count(),
        2,
        "{keys:#?}"
    );
    assert!(keys
        .iter()
        .all(|k| !k.contains(&format!("/{}-", now() - 3_600_000))));

    // Remote retention of 1 day removes the 3-day-old chunk from the bucket; text stays local.
    let mut s = a.settings();
    s.sync.remote_retention_days = 1;
    s.save(&a.paths).unwrap();
    a.sync("dev-d").unwrap();
    let keys = gw.keys("kc/dev-d/");
    assert_eq!(
        keys.iter().filter(|k| k.ends_with(".mp4")).count(),
        1,
        "{keys:#?}"
    );
    assert_eq!(
        a.fts("ancient").len(),
        2,
        "text of a purged chunk stays searchable locally"
    );
    assert_eq!(
        a.count("SELECT count(*) FROM video WHERE remote_key IS NULL AND status = 2"),
        1
    );

    // A fresh restore sees only what is left.
    let b = Lib::new(&gw, |_| {});
    let t = gw.target("kc", ACCESS, SECRET);
    let rep = restore::restore(&b.paths, &t, "dev-d", None, &mut |_| {}).unwrap();
    assert_eq!(
        (rep.chunks_listed, rep.chunks_restored, rep.frames),
        (1, 1, 2),
        "{rep:?}"
    );
    assert_eq!(b.fts("keep").len(), 2);
    assert!(b.fts("forget").is_empty() && b.fts("ancient").is_empty());
}

#[test]
fn devices_are_listed_and_restore_targets_one() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |_| {});
    a.chunk(now() - 600_000, 2, "laptop words", 1000);
    a.sync("laptop-1").unwrap();
    let d = Lib::new(&gw, |_| {});
    d.chunk(now() - 500_000, 3, "desktop words", 1000);
    d.sync("desktop-2").unwrap();
    let t = gw.target("kc", ACCESS, SECRET);
    let list = restore::devices(&t).unwrap();
    let ids: Vec<&str> = list.iter().map(|d| d.device_id.as_str()).collect();
    assert_eq!(ids, ["desktop-2", "laptop-1"]);
    assert!(
        list.iter()
            .all(|d| d.os.is_some() && d.first_chunk_ms.is_some()),
        "{list:?}"
    );
    let b = Lib::new(&gw, |_| {});
    let r = restore::restore(&b.paths, &t, "desktop-2", None, &mut |_| {}).unwrap();
    assert_eq!(r.frames, 3);
    assert_eq!(b.fts("desktop").len(), 3);
    assert!(b.fts("laptop").is_empty());
}

#[test]
fn chunks_uploaded_before_the_index_restore_from_a_listing() {
    let Some(gw) = Gateway::start() else { return };
    // The previous engine's layout: sidecar + mp4, no manifest, no index, no OCR offsets.
    let t = gw.target("kc", ACCESS, SECRET);
    let frame = serde_json::json!({"frame_index": 0, "ts_ms": 1_790_000_000_000i64, "width": 100, "height": 50, "title": "Old",
        "url": null, "domain": null, "app": {"bundle_id": "com.old.app", "name": "Old App"}, "display": {},
        "capture_reason": "interval", "dhash": null, "inactive": false,
        "ocr": {"foreground": "legacy words here", "background": "", "lines": [{"text": "words", "x": 1, "y": 2, "w": 3, "h": 4}]},
        "windows": []});
    let sidecar = zstd::encode_all(format!("{frame}\n").as_bytes(), 3).unwrap();
    t.put_bytes(
        &t.key("old-dev/2026/09/21/1790000000000-7.frames.jsonl.zst"),
        &sidecar,
        "application/x-ndjson",
        &Sha256::digest(&sidecar).into(),
    )
    .unwrap();
    t.put_bytes(
        &t.key("old-dev/2026/09/21/1790000000000-7.mp4"),
        b"mp4",
        "video/mp4",
        &Sha256::digest(b"mp4").into(),
    )
    .unwrap();
    let b = Lib::new(&gw, |_| {});
    let r = restore::restore(&b.paths, &t, "old-dev", None, &mut |_| {}).unwrap();
    assert_eq!(
        (r.source.as_str(), r.chunks_restored, r.frames),
        ("listing", 1, 1),
        "{r:?}"
    );
    assert_eq!(b.fts("legacy").len(), 1);
    let (off, len): (i64, i64) = b
        .conn
        .query_row("SELECT text_offset, text_length FROM ocr", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((off, len), (7, 5), "box offsets recovered from the text");
}

/// S3 behind a path (Supabase Storage serves it at `/storage/v1/s3`): every
/// request must arrive under the prefix. versitygw cannot serve under a path,
/// so a local server records the request lines and answers 200. Runs always.
#[test]
fn endpoint_path_prefix_reaches_the_server() {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut r = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if r.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                r.read_exact(&mut body).unwrap();
                log.lock().unwrap().push(line.trim().to_string());
                let xml = if line.starts_with("GET") {
                    "<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>"
                } else {
                    ""
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"etag-1\"\r\n\r\n{xml}",
                    xml.len()
                );
                if stream.write_all(resp.as_bytes()).is_err() {
                    break;
                }
            }
        }
    });
    let t = S3Target::new(
        &format!("http://127.0.0.1:{port}/storage/v1/s3"),
        "capture",
        "us-east-1",
        "kc",
        true,
        "k",
        "s",
        None,
    )
    .unwrap();
    t.put_bytes(
        &t.key("dev/a"),
        b"x",
        "text/plain",
        &Sha256::digest(b"x").into(),
    )
    .unwrap();
    t.head(&t.key("dev/a")).unwrap();
    let file = std::env::temp_dir().join(format!("kcap-prefix-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, b"part").unwrap();
    t.upload_part(
        &t.key("dev/v.mp4"),
        "up1",
        1,
        &file,
        0,
        4,
        &Sha256::digest(b"part").into(),
    )
    .unwrap();
    let _ = std::fs::remove_file(&file);
    t.list(&t.key("dev/"), None).unwrap();
    let lines = seen.lock().unwrap().clone();
    assert_eq!(lines.len(), 4, "{lines:#?}");
    for l in &lines {
        let path = l.split(' ').nth(1).unwrap();
        assert!(
            path.starts_with("/storage/v1/s3/capture"),
            "request outside the prefix: {l}"
        );
    }
    assert!(
        lines[0].starts_with("PUT /storage/v1/s3/capture/kc/dev/a?"),
        "{}",
        lines[0]
    );
    assert!(
        lines[1].starts_with("HEAD /storage/v1/s3/capture/kc/dev/a?"),
        "{}",
        lines[1]
    );
}

/// One segment that spans two chunks (the recorder keeps a segment while the
/// app, domain and URL stay the same) must stay one segment after restore,
/// or search returns a repeat per chunk. Covers text written in the INSERT and
/// text added by a later UPDATE (the recorder's OCR order).
#[test]
fn restore_keeps_segments_across_chunks_and_indexes_each_frame_once() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |_| {});
    let c = &a.conn;
    let app = store::upsert_application(c, "xterm", "", "xterm")
        .unwrap()
        .id;
    c.execute(
        "INSERT INTO segment(start_frame_id, application) VALUES (0, ?1)",
        [app],
    )
    .unwrap();
    let shared = c.last_insert_rowid();
    c.execute(
        "INSERT INTO segment(start_frame_id, application) VALUES (0, ?1)",
        [app],
    )
    .unwrap();
    let other = c.last_insert_rowid();
    let t0 = now() - 900_000;
    let mut ts = t0;
    // Chunks 1 and 2 share a segment; chunk 3 starts a new one with the same text.
    for (chunk, (seg, update_later)) in [(shared, true), (shared, false), (other, false)]
        .into_iter()
        .enumerate()
    {
        let name = format!("c{chunk}.mp4");
        std::fs::write(a.paths.videos_dir().join(&name), vec![chunk as u8; 2000]).unwrap();
        c.execute(
            "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (10, 10, ?1, 3, 2000, ?2, ?3)",
            params![name, ts, ts + 4000],
        )
        .unwrap();
        let vid = c.last_insert_rowid();
        for i in 0..3 {
            let text = "KORTIX CAPTURE LINUX VERIFY invoice 4815162342";
            if update_later {
                c.execute("INSERT INTO frame(timestamp, video, video_index, segment, ocr_status) VALUES (?1, ?2, ?3, ?4, 0)", params![ts, vid, i, seg]).unwrap();
                c.execute("UPDATE frame SET foreground = ?1, title = 'xterm', ocr_status = 1 WHERE id = ?2", params![text, c.last_insert_rowid()]).unwrap();
            } else {
                c.execute(
                    "INSERT INTO frame(timestamp, video, video_index, segment, foreground, title, ocr_status) VALUES (?1, ?2, ?3, ?4, ?5, 'xterm', 1)",
                    params![ts, vid, i, seg, text],
                )
                .unwrap();
            }
            ts += 2000;
        }
        ts += 10_000;
    }
    a.assert_fts_exact();
    a.sync("dev-s").unwrap();

    let b = Lib::new(&gw, |_| {});
    let t = gw.target("kc", ACCESS, SECRET);
    // Two restore runs: the segment of chunks 1-2 must survive a restore split at the chunk boundary.
    let r1 = restore::restore(&b.paths, &t, "dev-s", None, &mut |_| {}).unwrap();
    assert_eq!((r1.chunks_restored, r1.frames), (3, 9), "{r1:?}");
    b.assert_fts_exact();
    assert_eq!(
        a.segments(),
        b.segments(),
        "chunks 1 and 2 stay one segment"
    );
    assert_eq!(b.segments().len(), 2);
    for q in ["VERIFY OR 4815162342", "invoice", "xterm"] {
        let (ha, hb) = (a.cli_fts(q), b.cli_fts(q));
        assert_eq!(ha.len(), 2, "{q}: one hit per segment in A");
        assert_eq!(hb.len(), ha.len(), "{q}: same hit count after restore");
        let ts =
            |h: &[serde_json::Value]| h.iter().map(|x| x["timestamp"].clone()).collect::<Vec<_>>();
        assert_eq!(ts(&ha), ts(&hb), "{q}: same frames");
    }
    let c2 = Lib::new(&gw, |_| {});
    restore::restore(&c2.paths, &t, "dev-s", None, &mut |_| {}).unwrap();
    // Restore in two runs (first the last chunk, then the rest) gives the same segments.
    let d = Lib::new(&gw, |_| {});
    restore::restore(&d.paths, &t, "dev-s", Some(ts - 15_000), &mut |_| {}).unwrap();
    assert_eq!(d.count("SELECT count(*) FROM frame"), 3);
    restore::restore(&d.paths, &t, "dev-s", None, &mut |_| {}).unwrap();
    d.assert_fts_exact();
    assert_eq!(d.count("SELECT count(*) FROM frame"), 9);
    assert_eq!(c2.segments(), a.segments());
    assert_eq!(d.cli_fts("invoice").len(), 2);
}

// ---- the settings window (`ui::api::Ctx`) against the gateway ----

/// A settings window on `paths` that never opens a browser.
fn ui_on(paths: &MemoryPaths) -> kortix_backend::memory::ui::api::Ctx {
    let mut ui = kortix_backend::memory::ui::api::Ctx::new(paths.clone());
    ui.open_browser = false;
    ui
}

fn ui_post(
    ui: &kortix_backend::memory::ui::api::Ctx,
    uri: &str,
    body: serde_json::Value,
) -> (u16, serde_json::Value) {
    let r = ui.handle("POST", uri, None, body.to_string().as_bytes());
    (
        r.status,
        serde_json::from_slice(&r.body).unwrap_or_default(),
    )
}

fn ui_get(ui: &kortix_backend::memory::ui::api::Ctx, uri: &str) -> serde_json::Value {
    let r = ui.handle("GET", uri, None, &[]);
    assert_eq!(r.status, 200, "{uri}");
    serde_json::from_slice(&r.body).unwrap()
}

fn ui_job(ui: &kortix_backend::memory::ui::api::Ctx, name: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let j = ui_get(ui, "/api/sync")["jobs"][name].clone();
        if j["running"] == false {
            return j;
        }
        assert!(Instant::now() < deadline, "{name} did not finish");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn local(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

#[test]
fn settings_window_sets_up_syncs_restores_and_forgets_like_the_cli() {
    use serde_json::json;
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |s| *s = Settings::default());
    std::fs::remove_file(sync::credentials_path(&a.paths)).unwrap();
    let start = now() - 600_000;
    let ui = ui_on(&a.paths);
    let prefix = format!("ui-{}", uuid::Uuid::new_v4().simple());
    let form = |secret: &str| {
        json!({"provider": "s3", "endpoint": gw.endpoint(), "bucket": BUCKET, "prefix": prefix,
        "path_style": true, "access_key_id": ACCESS, "secret_access_key": secret})
    };

    // A wrong secret: the probe fails, nothing is saved, sync stays off.
    let (status, v) = ui_post(&ui, "/api/sync/setup", form("wrong-secret"));
    assert_eq!(status, 400);
    assert_eq!(
        v["error"].as_str().unwrap(),
        "The bucket refused these keys.",
        "one plain sentence, never the S3 body"
    );
    assert!(!a.settings().sync.enabled && sync::load_credentials(&a.paths).is_none());

    // The form probes before it is saved; then setup saves and turns sync on.
    let (status, v) = ui_post(&ui, "/api/sync/test", form(SECRET));
    assert!(status == 200 && v["probe_ms"].is_u64(), "{v}");
    let (status, v) = ui_post(&ui, "/api/sync/setup", form(SECRET));
    assert_eq!((status, v["enabled"].as_bool()), (200, Some(true)), "{v}");
    assert_eq!(a.settings().sync.s3.prefix, prefix);
    // Recordings made after the setup go to the bucket (earlier ones stay on this computer).
    a.chunk(start, 3, "window words", 1000);
    a.chunk(start + 60_000, 2, "second chunk", 1000);
    let raw = ui.handle("GET", "/api/sync", None, &[]);
    assert!(
        !String::from_utf8_lossy(&raw.body).contains(SECRET),
        "the secret never comes back"
    );
    // `sync test` on the saved target, with a blank secret in the form reusing the saved one.
    assert_eq!(ui_post(&ui, "/api/sync/test", json!({})).0, 200);
    let mut blank = form("");
    blank["secret_access_key"] = json!("");
    assert_eq!(ui_post(&ui, "/api/sync/test", blank).0, 200);

    // Sync now uploads both chunks; the status shows them.
    assert_eq!(ui_post(&ui, "/api/sync/now", json!({})).0, 200);
    let j = ui_job(&ui, "now");
    assert_eq!(
        (j["ok"].as_bool(), j["result"]["uploaded"].as_i64()),
        (Some(true), Some(2)),
        "{j}"
    );
    let st = ui_get(&ui, "/api/sync")["status"].clone();
    assert_eq!(
        (
            st["state"]["uploaded"].as_i64(),
            st["state"]["pending"].as_i64()
        ),
        (Some(2), Some(0)),
        "{st}"
    );

    // Pause and resume (resume probes first).
    assert_eq!(ui_post(&ui, "/api/sync/off", json!({})).1["enabled"], false);
    assert_eq!(ui_post(&ui, "/api/sync/on", json!({})).1["enabled"], true);

    // Devices: this machine, under the new prefix.
    let (_, d) = ui_post(&ui, "/api/sync/devices", json!({}));
    let ids: Vec<&str> = d["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["device_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [d["this_device"].as_str().unwrap()]);

    // Restore into an empty library through its own settings window.
    let b = Lib::new(&gw, |s| *s = Settings::default());
    std::fs::remove_file(sync::credentials_path(&b.paths)).unwrap();
    let ui_b = ui_on(&b.paths);
    assert_eq!(ui_post(&ui_b, "/api/sync/setup", form(SECRET)).0, 200);
    assert_eq!(
        ui_post(&ui_b, "/api/sync/restore", json!({"device": ids[0]})).0,
        200
    );
    let j = ui_job(&ui_b, "restore");
    assert_eq!(
        (j["ok"].as_bool(), j["result"]["frames"].as_i64()),
        (Some(true), Some(5)),
        "{j}"
    );
    assert_eq!(b.fts("window").len(), 3);

    // Forget the first chunk: a dry run first, then for real; sync now deletes it from the bucket.
    let tr = format!("{}|{}", local(start - 1000), local(start + 10_000));
    let (_, dry) = ui_post(&ui, "/api/storage/forget", json!({"tr": tr}));
    assert_eq!(
        (
            dry["dry_run"].as_bool(),
            dry["chunks"].as_u64(),
            dry["frames"].as_u64()
        ),
        (Some(true), Some(1), Some(3)),
        "{dry}"
    );
    assert_eq!(a.fts("window").len(), 3, "a dry run deletes nothing");
    let (_, done) = ui_post(&ui, "/api/storage/forget", json!({"tr": tr, "yes": true}));
    assert_eq!(
        (
            done["chunks"].as_u64(),
            done["remote_objects_queued"].as_u64()
        ),
        (Some(1), Some(3)),
        "{done}"
    );
    ui_post(&ui, "/api/sync/now", json!({}));
    assert_eq!(ui_job(&ui, "now")["result"]["tombstones"], 0);
    let c = Lib::new(&gw, |s| *s = Settings::default());
    std::fs::remove_file(sync::credentials_path(&c.paths)).unwrap();
    let ui_c = ui_on(&c.paths);
    ui_post(&ui_c, "/api/sync/setup", form(SECRET));
    ui_post(&ui_c, "/api/sync/restore", json!({}));
    assert_eq!(
        ui_job(&ui_c, "restore")["result"]["frames"],
        2,
        "the forgotten chunk is gone from the bucket"
    );

    // Encryption from the window: on, export, and the next upload is ciphertext.
    let (_, on) = ui_post(&ui, "/api/sync/encrypt", json!({"on": true}));
    let (_, key) = ui_post(&ui, "/api/sync/key/export", json!({}));
    assert_eq!(key["key_id"], on["key_id"]);
    assert!(crypt::Key::from_b64(key["key"].as_str().unwrap()).is_ok());
}

/// Audio memory: segments upload with a manifest (plain and encrypted, small and
/// multipart), the index lists them, restore brings back the row and the
/// transcript, playback downloads the same bytes (SHA-256 checked), and forget
/// removes the objects from the bucket.
#[test]
fn audio_segments_upload_restore_play_back_and_forget() {
    let Some(gw) = Gateway::start() else { return };
    for encrypt in [false, true] {
        let dev = if encrypt {
            "dev-audio-enc"
        } else {
            "dev-audio"
        };
        let a = Lib::new(&gw, |s| s.sync.encrypt = encrypt);
        let t0 = now() - 900_000;
        let (id1, small) = a.audio(t0, "quarterly zebrafish budget", 240_000);
        let (id2, big) = a.audio(t0 + 60_000, "second minute of the call", 6 * MIB); // multipart
        a.sync(dev).unwrap();
        let keys = gw.keys(&format!("kc/{dev}/"));
        let m4a: Vec<&String> = keys.iter().filter(|k| k.ends_with(".m4a")).collect();
        assert_eq!(m4a.len(), 2, "{keys:#?}");
        assert!(m4a[0].ends_with(&format!("{t0}-a{id1}.m4a")), "{m4a:?}");
        assert!(keys
            .iter()
            .any(|k| k.ends_with(&format!("{t0}-a{id1}.manifest.json"))));
        let t = gw.target("kc", ACCESS, SECRET);
        let manifest_key = keys
            .iter()
            .find(|k| k.ends_with(&format!("-a{id1}.manifest.json")))
            .unwrap();
        let raw = t.get_bytes(manifest_key).unwrap().unwrap();
        assert_eq!(crypt::is_encrypted(&raw), encrypt, "manifest encryption");
        if encrypt {
            assert!(
                !String::from_utf8_lossy(&raw).contains("zebrafish"),
                "the transcript is ciphertext"
            );
            let body = t.get_bytes(m4a[0]).unwrap().unwrap();
            assert!(crypt::is_encrypted(&body), "the audio is ciphertext");
        } else {
            let m: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            assert_eq!(m["kind"], "audio");
            assert_eq!(
                m["objects"]["audio"]["sha256"].as_str().unwrap(),
                format!("{:x}", Sha256::digest(&small))
            );
            assert_eq!(m["transcript"][0]["text"], "quarterly zebrafish budget");
            assert_eq!(m["sources"], serde_json::json!(["microphone", "system"]));
        }
        assert_eq!(
            a.count("SELECT count(*) FROM audio WHERE uploaded_at IS NOT NULL"),
            2
        );

        // Restore on a fresh machine: rows remote-only, transcripts searchable, bytes identical.
        let b = Lib::new(&gw, |_| {});
        if encrypt {
            let key_id = a.settings().sync.key_id;
            let exported = crypt::load(&a.paths, &key_id).unwrap().to_b64();
            crypt::store(&b.paths, &crypt::Key::from_b64(&exported).unwrap()).unwrap();
        }
        let r = restore::restore(&b.paths, &t, dev, None, &mut |_| {}).unwrap();
        assert_eq!((r.audio_restored, r.errors.len()), (2, 0), "{r:?}");
        assert_eq!(b.heard("zebrafish"), a.heard("zebrafish"));
        assert_eq!(b.count("SELECT count(*) FROM audio WHERE status = 3"), 2);
        let ids: Vec<i64> = b
            .conn
            .prepare("SELECT id FROM audio ORDER BY start_ms")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let mut s = b.settings();
        s.sync.encrypt = encrypt;
        s.sync.key_id = a.settings().sync.key_id;
        s.save(&b.paths).unwrap();
        for (id, want) in [(ids[0], &small), (ids[1], &big)] {
            let f = sync::fetch_remote_audio(&b.conn, &b.paths, id)
                .unwrap()
                .unwrap();
            assert_eq!(
                Sha256::digest(bytes_of(&f)),
                Sha256::digest(want),
                "playback bytes equal"
            );
        }
        // A second restore finds everything present.
        let r = restore::restore(&b.paths, &t, dev, None, &mut |_| {}).unwrap();
        assert_eq!((r.audio_restored, r.audio_already_present), (0, 2));

        // Forget the first minute: its objects leave the bucket, the index records it.
        let range = TimeRange {
            start: Some(t0 + 1_000),
            end: Some(t0 + 2_000),
        };
        let f = sync::forget(&a.conn, &a.paths, &a.settings(), dev, range, false).unwrap();
        assert_eq!((f.audio, f.remote_objects_queued), (1, 2));
        a.sync(dev).unwrap();
        let keys = gw.keys(&format!("kc/{dev}/"));
        assert!(
            keys.iter().all(|k| !k.contains(&format!("-a{id1}."))),
            "{keys:#?}"
        );
        assert!(keys.iter().any(|k| k.ends_with(&format!("-a{id2}.m4a"))));
        let c = Lib::new(&gw, |_| {});
        if encrypt {
            let key_id = a.settings().sync.key_id;
            crypt::store(&c.paths, &crypt::load(&a.paths, &key_id).unwrap()).unwrap();
        }
        let r = restore::restore(&c.paths, &t, dev, None, &mut |_| {}).unwrap();
        assert_eq!(
            r.audio_restored, 1,
            "the forgotten segment is not restored: {r:?}"
        );
        assert!(c.heard("zebrafish").is_empty());
    }
}

/// Action segments are format items: screenshots go to `assets/` once (shared
/// across segments), the actions object and the manifest after them; offload
/// removes the local copies; restore brings segments and screenshots back
/// equal (with screen chunks and audio); forget removes a segment and the
/// screenshots only it showed.
#[test]
fn actions_upload_offload_restore_equal_and_forget_with_shared_screenshots() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |s| s.sync.keep_local_hours = 0);
    let t0 = now() - 3_600_000;
    a.chunk(t0, 3, "quarterly roadmap", 4_000);
    a.audio(t0 + 5_000, "we ship on friday", 9_000);
    let (s1, s2, s3): (&[u8], &[u8], &[u8]) = (b"\xff\xd8one", b"\xff\xd8two", b"\xff\xd8three");
    a.actions(t0 + 10_000, &[s1, s2]);
    a.actions(t0 + 70_000, &[s2, s3]);
    let before = a.actions_fingerprint();
    assert!(
        before.iter().any(|l| l.contains("\"kind\":\"typewrite\"")),
        "{before:#?}"
    );
    a.sync("dev-a").unwrap();

    let keys = gw.keys("kc/dev-a/");
    let count = |suffix: &str| keys.iter().filter(|k| k.ends_with(suffix)).count();
    assert_eq!(count(".actions.jsonl.zst"), 2, "{keys:#?}");
    assert_eq!(
        count(".manifest.json"),
        4,
        "a chunk, an audio segment, two action segments"
    );
    let shots: Vec<&String> = keys
        .iter()
        .filter(|k| k.contains("/assets/sha256-") && k.ends_with(".jpg"))
        .collect();
    assert_eq!(
        shots.len(),
        3,
        "three screenshots, the shared one stored once: {keys:#?}"
    );
    let t = gw.target("kc", ACCESS, SECRET);
    let mkey = keys
        .iter()
        .find(|k| k.contains(&format!("/{}-x", t0 + 10_000)) && k.ends_with(".manifest.json"))
        .unwrap();
    let m: serde_json::Value =
        serde_json::from_slice(&t.get_bytes(mkey).unwrap().unwrap()).unwrap();
    assert_eq!(
        (m["schema"].as_i64(), m["kind"].as_str()),
        (Some(2), Some("actions"))
    );
    assert_eq!(m["event_count"].as_i64(), Some(5));
    assert_eq!(m["screenshots"].as_array().unwrap().len(), 2);
    let obj = &m["objects"]["actions"];
    let body = t
        .get_bytes(&t.key(obj["key"].as_str().unwrap()))
        .unwrap()
        .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&body)),
        obj["sha256"].as_str().unwrap()
    );
    let index = keys.iter().find(|k| k.contains("/index/")).unwrap();
    let index = String::from_utf8(t.get_bytes(index).unwrap().unwrap()).unwrap();
    assert_eq!(index.matches("\"kind\":\"actions\"").count(), 2, "{index}");
    // Offloaded: rows stay (remote only), files and screenshots leave this computer.
    assert_eq!(
        a.count("SELECT count(*) FROM action_segment WHERE status = 3"),
        2
    );
    assert_eq!(
        std::fs::read_dir(actions::assets_dir(&a.paths))
            .unwrap()
            .count(),
        0
    );

    // Restore into an empty library: equal screen, audio and actions.
    let b = Lib::new(&gw, |_| {});
    let report = restore::restore(&b.paths, &t, "dev-a", None, &mut |_| {}).unwrap();
    assert_eq!(
        (
            report.chunks_restored,
            report.audio_restored,
            report.actions_restored,
            report.screenshots
        ),
        (1, 1, 2, 3),
        "{report:?}"
    );
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(b.fingerprint(), a.fingerprint());
    assert_eq!(b.heard("friday"), a.heard("friday"));
    assert_eq!(
        b.actions_fingerprint(),
        before,
        "restored action segments equal the originals"
    );
    // Restore is idempotent.
    let again = restore::restore(&b.paths, &t, "dev-a", None, &mut |_| {}).unwrap();
    assert_eq!(
        (again.actions_restored, again.actions_already_present),
        (0, 2)
    );

    // Forget the first segment: its objects and the screenshot only it showed go.
    let conn = &a.conn;
    let r = sync::forget(
        conn,
        &a.paths,
        &a.settings(),
        "dev-a",
        kortix_backend::memory::timerange::TimeRange {
            start: Some(t0 + 10_000),
            end: Some(t0 + 20_000),
        },
        false,
    )
    .unwrap();
    assert_eq!(r.actions, 1);
    a.sync("dev-a").unwrap();
    let keys = gw.keys("kc/dev-a/");
    assert_eq!(
        keys.iter()
            .filter(|k| k.ends_with(".actions.jsonl.zst"))
            .count(),
        1
    );
    let name = |b: &[u8]| actions::asset_name(b, "jpg");
    assert!(
        !keys.iter().any(|k| k.ends_with(&name(s1))),
        "the forgotten screenshot is gone"
    );
    assert!(
        keys.iter().any(|k| k.ends_with(&name(s2))),
        "the shared screenshot stays"
    );
    assert!(keys.iter().any(|k| k.ends_with(&name(s3))));
}

/// device.json (schema 2), status.json every pass interval, and the
/// operator's policy: the device file wins over the prefix file, the policy
/// narrows the effective settings within one pass, and its removal lifts it.
#[test]
fn device_status_and_policy_files() {
    let Some(gw) = Gateway::start() else { return };
    let a = Lib::new(&gw, |s| s.audio.enabled = true);
    let device = sync::device_id(&a.paths, &a.settings());
    assert_eq!(device.len(), 32);
    assert_eq!(
        device,
        sync::device_id_for(&a.paths, "kc"),
        "derived from the machine key and the prefix"
    );
    assert_ne!(device, sync::device_id_for(&a.paths, "other-prefix"));
    let t = gw.target("kc", ACCESS, SECRET);
    let pass = |rt: &mut Runtime| {
        let stop = AtomicBool::new(false);
        sync::pass(
            &a.conn,
            &a.paths,
            &Settings::effective(&a.paths),
            &device,
            &stop,
            rt,
        )
        .unwrap();
    };
    let mut rt = Runtime::default();
    pass(&mut rt);
    let dj: serde_json::Value = serde_json::from_slice(
        &t.get_bytes(&t.key(&format!("{device}/device.json")))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (dj["schema"].as_i64(), dj["device_id"].as_str()),
        (Some(2), Some(device.as_str()))
    );
    let mk = dj["machine_key_sha256"].as_str().unwrap();
    assert!(mk.len() == 64 && mk.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(dj["os"].is_string() && dj["app_version"].is_string() && dj["member"].is_null());
    assert!(dj["updated_at_ms"].is_i64());
    let st: serde_json::Value = serde_json::from_slice(
        &t.get_bytes(&t.key(&format!("{device}/status.json")))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(st["reportedAtMs"].is_i64() && st["recording"].is_string() && st["sync"].is_object());
    assert!(st["policy"].is_null());
    assert!(policy::read(&a.paths).is_none());

    // The operator writes a prefix policy: it lands within one pass.
    let put = |rel: &str, body: serde_json::Value| {
        let b = serde_json::to_vec(&body).unwrap();
        t.put_bytes(
            &t.key(rel),
            &b,
            "application/json",
            &Sha256::digest(&b).into(),
        )
        .unwrap();
    };
    put(
        "policy.json",
        serde_json::json!({"schema": 2, "layers": {"audio": false, "actions": false},
        "privacy": {"redact_pii": true}, "notice": "Recorded for support", "updated_at_ms": 7}),
    );
    rt.policy_at = 0;
    rt.status_at = 0;
    pass(&mut rt);
    let cached = policy::read(&a.paths).unwrap();
    assert_eq!(cached.source, "kc/policy.json");
    let eff = Settings::effective(&a.paths);
    assert!(!eff.audio.enabled && eff.privacy.redact_pii);
    assert_eq!(eff.actions_blocked(now()), Some("policy_off"));
    assert!(
        Settings::load(&a.paths).audio.enabled,
        "the person's own setting is kept"
    );
    let st: serde_json::Value = serde_json::from_slice(
        &t.get_bytes(&t.key(&format!("{device}/status.json")))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        st["policy"]["source"], "kc/policy.json",
        "status.json shows the policy in force"
    );
    assert_eq!(st["audio"]["enabled"], false);

    // A new account policy replaces the old one; pausing stops the screen layer.
    put(
        "policy.json",
        serde_json::json!({"schema": 2, "recording": {"paused": true}}),
    );
    rt.policy_at = 0;
    let reported = rt.status_at;
    pass(&mut rt);
    assert_eq!(policy::read(&a.paths).unwrap().source, "kc/policy.json");
    // The change is reported with the next status (every 15 s: STATUS_EVERY_MS), never held back
    // to a later minute. (The old 60 s status period made this "5 to 15 s"; the period is 15 s now.)
    let due = rt.status_at + 15_000 - now();
    assert!(
        rt.status_at <= reported && (0..=15_000).contains(&due),
        "status.json due in {due} ms after a policy change"
    );
    // An unchanged policy does not move the status report.
    let reported = rt.status_at;
    rt.policy_at = 0;
    pass(&mut rt);
    assert_eq!(rt.status_at, reported);
    let eff = Settings::effective(&a.paths);
    assert_eq!(eff.inactive_reason(now()), Some("policy_paused"));
    assert!(eff.audio.enabled, "the new policy no longer turns audio off");

    // A policy in the device's own folder is ignored: the device can write there.
    put(
        &format!("{device}/policy.json"),
        serde_json::json!({"schema": 2, "recording": {"paused": false}}),
    );
    rt.policy_at = 0;
    pass(&mut rt);
    assert_eq!(policy::read(&a.paths).unwrap().source, "kc/policy.json");
    assert!(
        policy::read(&a.paths).unwrap().policy.recording.paused,
        "the account policy stays in force; the device-folder one (paused: true) changed nothing new"
    );


    // A policy from a newer app is refused; the one in force stays.
    put("policy.json", serde_json::json!({"schema": 3}));
    rt.policy_at = 0;
    pass(&mut rt);
    assert_eq!(
        policy::read(&a.paths).unwrap().policy.recording.paused,
        true
    );

    // No policy objects: no policy.
    t.delete(&t.key(&format!("{device}/policy.json"))).unwrap();
    t.delete(&t.key("policy.json")).unwrap();
    rt.policy_at = 0;
    pass(&mut rt);
    assert!(policy::read(&a.paths).is_none());
    assert_eq!(Settings::effective(&a.paths).inactive_reason(now()), None);
}

// ---- a credential issuer (test-only mock of the protocol in docs/capture-format.md) ----

#[derive(Default)]
struct IssuerState {
    endpoint: String,
    approved: bool,
    denied: bool,
    polls: usize,
    token: Option<String>,
    revoked: bool,
    credential_calls: usize,
    /// Credentials expire this long after they are issued.
    ttl_ms: i64,
    device_info: Option<serde_json::Value>,
}

type Shared = std::sync::Arc<std::sync::Mutex<IssuerState>>;

/// Serves the device grant and the credential endpoint on a free port; the
/// "browser" approves at `/approve`. Returns the base URL.
fn start_issuer(state: Shared) -> String {
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;
    async fn authorize(
        State(s): State<Shared>,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        s.lock().unwrap().device_info = Some(body["device"].clone());
        Json(
            json!({"device_code": "dc-1", "user_code": "WDJB-MJHT", "verification_uri": "/approve",
                    "verification_uri_complete": "/approve?user_code=WDJB-MJHT", "interval": 1, "expires_in": 60}),
        )
    }
    async fn approve(State(s): State<Shared>) -> &'static str {
        s.lock().unwrap().approved = true;
        "approved"
    }
    async fn token(
        State(s): State<Shared>,
        Json(body): Json<serde_json::Value>,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let mut st = s.lock().unwrap();
        st.polls += 1;
        assert_eq!(
            body["grant_type"],
            "urn:ietf:params:oauth:grant-type:device_code"
        );
        assert_eq!(body["device_code"], "dc-1");
        if st.denied {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "access_denied"})),
            );
        }
        if !st.approved {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "authorization_pending"})),
            );
        }
        let t = format!("synthetic-device-token-{}", st.polls);
        st.token = Some(t.clone());
        st.revoked = false;
        let device_id = st.device_info.as_ref().unwrap()["device_id"]
            .as_str()
            .unwrap()
            .to_string();
        (
            StatusCode::OK,
            Json(
                json!({"device_token": t, "prefix": "orgs/o1/projects/p1", "device_id": device_id,
                                     "member": {"email": "person@example.com"}}),
            ),
        )
    }
    async fn credentials(
        State(s): State<Shared>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<serde_json::Value>) {
        let mut st = s.lock().unwrap();
        st.credential_calls += 1;
        let bearer = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if st.revoked
            || st.token.as_deref().map(|t| format!("Bearer {t}")) != Some(bearer.to_string())
        {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "Invalid or revoked device token; sign in again", "code": "capture_device_unauthorized"})),
            );
        }
        let device_id = st.device_info.as_ref().unwrap()["device_id"]
            .as_str()
            .unwrap()
            .to_string();
        (
            StatusCode::OK,
            Json(
                json!({"endpoint": st.endpoint, "bucket": BUCKET, "region": "us-east-1",
            "prefix": "orgs/o1/projects/p1", "device_id": device_id, "access_key_id": ACCESS,
            "secret_access_key": SECRET, "session_token": null, "path_style": true,
            "expires_at_ms": store::now_ms() + st.ttl_ms}),
            ),
        )
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let app = Router::new()
                    .route("/v1/capture/device/authorize", post(authorize))
                    .route("/v1/capture/device/token", post(token))
                    .route("/v1/capture/credentials", post(credentials))
                    .route("/approve", get(approve))
                    .with_state(state);
                axum::serve(tokio::net::TcpListener::from_std(listener).unwrap(), app)
                    .await
                    .unwrap();
            });
    });
    url
}

/// Sign in with the device grant against a mock issuer, sync over plain S3
/// with the issued credentials, refresh them 5 minutes before they expire,
/// and stop on a 401 until the person signs in again.
#[test]
fn issuer_device_grant_credentials_refresh_and_revocation() {
    use kortix_backend::memory::{cli, sync::issuer};
    let Some(gw) = Gateway::start() else { return };
    let state: Shared = Default::default();
    {
        let mut st = state.lock().unwrap();
        st.endpoint = gw.endpoint();
        // Due for refresh 2 s after issue (refresh starts 5 min before expiry).
        st.ttl_ms = issuer::REFRESH_BEFORE_MS + 2_000;
    }
    let url = start_issuer(state.clone());
    let a = Lib::new(&gw, |s| {
        s.sync.enabled = false;
        s.sync.provider = "kortix".into();
        s.sync.kortix.url = url.clone();
    });
    let stop = AtomicBool::new(false);

    // A denied sign-in leaves nothing behind.
    state.lock().unwrap().denied = true;
    let err = cli::sync_setup_kortix(&a.paths, None, None, &mut |_| {}, &stop).unwrap_err();
    assert!(format!("{err:#}").contains("denied"), "{err:#}");
    assert!(issuer::registration(&a.paths).is_none());
    state.lock().unwrap().denied = false;

    // The person approves in the browser while the app polls.
    let approve_base = url.clone();
    let mut shown = None;
    let v = cli::sync_setup_kortix(
        &a.paths,
        None,
        None,
        &mut |auth| {
            shown = Some(auth.user_code.clone());
            assert!(auth.verification_uri_complete.starts_with(&approve_base), "{}", auth.verification_uri_complete);
            reqwest::blocking::get(&auth.verification_uri_complete).unwrap();
        },
        &stop,
    )
    .unwrap();
    assert_eq!(shown.as_deref(), Some("WDJB-MJHT"));
    assert!(state.lock().unwrap().polls >= 1);
    let info = state.lock().unwrap().device_info.clone().unwrap();
    assert_eq!(info["machine_key_sha256"].as_str().unwrap().len(), 64);
    let reg = issuer::registration(&a.paths).unwrap();
    assert_eq!(
        (reg.prefix.as_str(), reg.member_email.as_deref()),
        ("orgs/o1/projects/p1", Some("person@example.com"))
    );
    assert_eq!(v["device_id"], reg.device_id);
    assert!(a.settings().sync.enabled && a.settings().sync.provider == "kortix");
    // The token lives in the secret store (file store in tests), never in settings or the registration.
    let token_file = a.paths.root.join("sync-device-token");
    assert!(std::fs::read_to_string(&token_file)
        .unwrap()
        .starts_with("synthetic-device-token"));
    assert!(
        !std::fs::read_to_string(a.paths.root.join("sync-issuer.json"))
            .unwrap()
            .contains("synthetic")
    );
    assert!(!std::fs::read_to_string(a.paths.settings())
        .unwrap()
        .contains("synthetic"));

    // Items sync over plain S3 under the issued prefix.
    let device = sync::device_id(&a.paths, &a.settings());
    assert_eq!(device, reg.device_id);
    let t0 = now() - 600_000;
    a.chunk(t0, 2, "issued credentials", 2_000);
    a.actions(t0 + 5_000, &[b"\xff\xd8issued"]);
    a.sync(&device).unwrap();
    let keys = gw.keys(&format!("orgs/o1/projects/p1/{device}/"));
    assert!(keys.iter().any(|k| k.ends_with(".mp4")), "{keys:#?}");
    assert!(
        keys.iter().any(|k| k.ends_with(".actions.jsonl.zst")),
        "{keys:#?}"
    );
    let t = gw.target("orgs/o1/projects/p1", ACCESS, SECRET);
    let dj: serde_json::Value = serde_json::from_slice(
        &t.get_bytes(&t.key(&format!("{device}/device.json")))
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(dj["member"]["email"], "person@example.com");
    let calls = state.lock().unwrap().credential_calls;
    assert!(calls >= 1);

    // Within the window the cached credentials serve; 5 minutes before expiry they refresh.
    let mut rt = Runtime::default();
    let s = Settings::effective(&a.paths);
    sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).unwrap();
    assert_eq!(
        state.lock().unwrap().credential_calls,
        calls,
        "cached credentials reused"
    );
    std::thread::sleep(Duration::from_millis(2_300));
    sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).unwrap();
    assert_eq!(
        state.lock().unwrap().credential_calls,
        calls + 1,
        "refreshed before expiry"
    );

    // The issuer revokes the device: the next refresh gets 401, sync stops and asks to sign in.
    state.lock().unwrap().revoked = true;
    std::thread::sleep(Duration::from_millis(2_300));
    let err = sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).unwrap_err();
    assert_eq!(sync::classify(&err), ErrorClass::Auth, "{err:#}");
    assert!(issuer::registration(&a.paths)
        .unwrap()
        .rejected_at_ms
        .is_some());
    let st = sync::compute_state(&a.conn, &a.paths, &s, true, &device, &rt);
    assert!(st.sign_in_required);
    let after = state.lock().unwrap().credential_calls;
    assert!(sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).is_err());
    assert_eq!(
        state.lock().unwrap().credential_calls,
        after,
        "no request after a refusal"
    );

    // The admin restores the device: the next recheck (every 15 min) reconnects it with the
    // token it still holds, no new sign-in.
    state.lock().unwrap().revoked = false;
    issuer::recheck_refused_now();
    a.chunk(t0 + 50_000, 1, "after restore", 1_000);
    sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).unwrap();
    assert!(issuer::registration(&a.paths).unwrap().rejected_at_ms.is_none(), "restored without a sign-in");
    assert!(!sync::compute_state(&a.conn, &a.paths, &s, true, &device, &rt).sign_in_required);

    // A refusal again; signing in again also resumes sync.
    state.lock().unwrap().revoked = true;
    issuer::forget_credentials();
    assert_eq!(sync::classify(&sync::pass(&a.conn, &a.paths, &s, &device, &stop, &mut rt).unwrap_err()), ErrorClass::Auth);
    state.lock().unwrap().revoked = false;
    state.lock().unwrap().approved = true;
    cli::sync_setup_kortix(&a.paths, None, None, &mut |_| {}, &stop).unwrap();
    assert!(issuer::registration(&a.paths)
        .unwrap()
        .rejected_at_ms
        .is_none());
    a.chunk(t0 + 60_000, 1, "after sign in", 1_000);
    a.sync(&device).unwrap();
    assert!(
        !sync::compute_state(
            &a.conn,
            &a.paths,
            &Settings::effective(&a.paths),
            true,
            &device,
            &Runtime::default()
        )
        .sign_in_required
    );

    // Sign-out forgets the token and turns Kortix sync off.
    cli::sync_sign_out(&a.paths).unwrap();
    assert!(issuer::registration(&a.paths).is_none() && !token_file.exists());
    assert!(!a.settings().sync.enabled);
}
