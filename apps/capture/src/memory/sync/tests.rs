use super::*;
use crate::memory::{settings, timerange::TimeRange};

struct Lib(MemoryPaths);

impl Lib {
    fn new() -> (Self, Connection) {
        std::env::set_var(crypt::KEY_STORE_ENV, "file");
        let paths = MemoryPaths::at(
            std::env::temp_dir().join(format!("kcap-sync-{}", uuid::Uuid::new_v4().simple())),
        );
        let conn = store::open(&paths).unwrap();
        (Self(paths), conn)
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0.root);
    }
}

/// A chunk with two frames, OCR, a window, an AX tree, an app icon and a domain.
fn seed_chunk(conn: &Connection, paths: &MemoryPaths, start: i64, text: &str) -> i64 {
    std::fs::write(paths.icons_dir().join("com.x.png"), b"icon-bytes").unwrap();
    let app = store::upsert_application(conn, "com.x", "1.0", "X App")
        .unwrap()
        .id;
    conn.execute(
        "UPDATE application SET icon_path = 'icons/com.x.png' WHERE id = ?1",
        [app],
    )
    .unwrap();
    let dom = store::upsert_domain(conn, "example.com").unwrap();
    let name = format!("v{start}.mp4");
    std::fs::write(paths.videos_dir().join(&name), vec![1u8; 1000]).unwrap();
    conn.execute(
        "INSERT INTO video(height, width, path, num_frames, size_bytes, start_timestamp, end_timestamp) VALUES (10, 20, ?1, 2, 1000, ?2, ?3)",
        params![name, start, start + 2000],
    )
    .unwrap();
    let vid = conn.last_insert_rowid();
    conn.execute("INSERT INTO segment(start_frame_id, application, domain, url) VALUES (0, ?1, ?2, 'https://example.com/a')", params![app, dom]).unwrap();
    let seg = conn.last_insert_rowid();
    for i in 0..2 {
        let fg = format!("{text} line {i}");
        conn.execute(
            "INSERT INTO frame(timestamp, video, video_index, width, height, title, foreground, background, segment, ocr_status)
             VALUES (?1, ?2, ?3, 20, 10, 'Title', ?4, 'bg', ?5, 1)",
            params![start + i * 2000, vid, i, fg, seg],
        )
        .unwrap();
        let fid = conn.last_insert_rowid();
        conn.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (?1, 1, 2, 3, 4, 0, 4)", [fid]).unwrap();
        conn.execute(
            "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, z_order, is_focussed_window) VALUES (?1, ?2, 'W', 0, 0, 20, 10, 0, 1)",
            params![fid, app],
        )
        .unwrap();
        let payload = br#"{"role":"AXWindow"}"#;
        let hash = Sha256::digest(payload).to_vec();
        conn.execute(
            "INSERT OR IGNORE INTO ax_blob(hash, payload) VALUES (?1, ?2)",
            params![hash, zstd::encode_all(&payload[..], 3).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ax_snapshot(frame_id, hash, timestamp_ms, application_name, bundle_id, process_identifier, node_count) VALUES (?1, ?2, 0, 'X App', 'com.x', 1, 1)",
            params![fid, hash],
        )
        .unwrap();
    }
    vid
}

#[test]
fn backoff_is_jittered_within_half_to_full_step_and_caps() {
    for (attempts, step) in [(0, 5_000), (1, 10_000), (7, 600_000), (60, 600_000)] {
        for _ in 0..50 {
            let b = backoff_ms(attempts);
            assert!(b >= step / 2 && b <= step, "attempts {attempts}: {b}");
        }
    }
    let spread: HashSet<i64> = (0..20).map(|_| backoff_ms(3)).collect();
    assert!(spread.len() > 1, "jitter varies");
}

#[test]
fn chunk_keys_are_dated_by_utc_start() {
    // 2026-10-02T23:59:59Z
    assert_eq!(
        chunk_rel("dev-1", 1_790_985_599_000, 42),
        "dev-1/2026/10/02/1790985599000-42"
    );
    assert_eq!(
        index_rel("dev-1", "2026-10-02"),
        "dev-1/index/2026-10-02.jsonl"
    );
    assert_eq!(device_rel("dev", "kc/dev/x"), Some("dev/x"));
    assert_eq!(device_rel("dev", "dev/x"), Some("dev/x"));
    assert_eq!(device_rel("dev", "kc/other/x"), None);
    assert_eq!(device_rel("dev", "kc/xdev/x"), None);
    assert_eq!(
        actions_rel("dev-1", 1_790_985_599_000, 7),
        "dev-1/2026/10/02/1790985599000-x7"
    );
}

#[test]
fn settings_build_a_target_with_caps() {
    let creds = SyncCredentials {
        access_key_id: "k".into(),
        secret_access_key: "s".into(),
        session_token: None,
    };
    let mut s = SyncSettings::default();
    s.s3 = settings::S3SyncSettings {
        endpoint: "http://127.0.0.1:9000".into(),
        bucket: "b".into(),
        path_style: true,
        ..Default::default()
    };
    let t = target_for(&s, &creds).unwrap();
    assert_eq!(t.key("d/x"), "kortix-capture/d/x");
    assert_eq!(t.part_size(), 16 * 1024 * 1024);
    s.part_mb = 1;
    assert_eq!(
        target_for(&s, &creds).unwrap().part_size(),
        s3::MIN_PART,
        "parts never go below 5 MiB"
    );
    s.s3.bucket = String::new();
    let err = target_for(&s, &creds).err().unwrap();
    assert_eq!(
        classify(&err),
        ErrorClass::Config,
        "a missing bucket stops the pass"
    );
}

#[test]
fn missing_credentials_and_missing_key_are_config_errors() {
    let (lib, _conn) = Lib::new();
    let mut s = Settings::default();
    s.sync.s3.endpoint = "http://127.0.0.1:9".into();
    s.sync.s3.bucket = "b".into();
    std::env::remove_var(ENV_KEY);
    assert_eq!(
        classify(&target(&lib.0, &s).err().unwrap()),
        ErrorClass::Config
    );
    s.sync.encrypt = true;
    s.sync.key_id = "0123456789abcdef".into();
    assert_eq!(
        classify(&ensure_key(&lib.0, &s).unwrap_err()),
        ErrorClass::Config
    );
}

#[test]
fn encryption_key_is_generated_once_and_recorded_in_settings() {
    let (lib, _conn) = Lib::new();
    let mut s = Settings::default();
    assert!(ensure_key(&lib.0, &s).unwrap().is_none(), "off by default");
    s.sync.encrypt = true;
    s.save(&lib.0).unwrap();
    let k = ensure_key(&lib.0, &s).unwrap().unwrap();
    let saved = Settings::load(&lib.0);
    assert_eq!(saved.sync.key_id, k.id());
    assert_eq!(
        ensure_key(&lib.0, &saved).unwrap().unwrap().id(),
        k.id(),
        "the same key loads again"
    );
    let sealed = crypt::encrypt_bytes(&k, b"secret").unwrap();
    assert_eq!(open_blob(&lib.0, sealed).unwrap(), b"secret");
    assert_eq!(open_blob(&lib.0, b"plain".to_vec()).unwrap(), b"plain");
}

#[test]
fn sidecar_carries_text_offsets_windows_ax_and_icon_assets() {
    let (lib, conn) = Lib::new();
    let vid = seed_chunk(&conn, &lib.0, 1_000, "alpha");
    conn.execute(
        "UPDATE frame SET pii_redacted = 1 WHERE video = ?1 AND video_index = 0",
        [vid],
    )
    .unwrap();
    let (jsonl, assets) = frames_jsonl(&conn, &lib.0, vid).unwrap();
    let lines: Vec<Value> = jsonl
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    let f = &lines[0];
    assert_eq!(f["pii_redacted"], true);
    assert_eq!(lines[1]["pii_redacted"], false);
    assert_eq!(f["ocr"]["foreground"], "alpha line 0");
    assert_eq!(f["ocr"]["lines"][0]["text"], "alph");
    assert_eq!(f["ocr"]["lines"][0]["off"], 0);
    assert_eq!(f["windows"][0]["focused"], true);
    assert_eq!(f["ax_tree"]["role"], "AXWindow");
    assert_eq!(f["domain"], "example.com");
    let icon = f["app"]["icon"].as_str().unwrap();
    assert_eq!(icon, format!("sha256-{}.png", sha256_hex(b"icon-bytes")));
    assert_eq!(assets.len(), 1, "an icon shared by frames is listed once");
}

#[test]
fn private_sidecar_never_reuses_unfiltered_application_names_from_older_frames() {
    let (lib, conn) = Lib::new();
    let vid = seed_chunk(&conn, &lib.0, 1_000, "[email]");
    conn.execute(
        "UPDATE application SET display_name = 'alice@example.com'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE frame SET pii_redacted = 1 WHERE video = ?1 AND video_index = 0",
        [vid],
    )
    .unwrap();
    let (jsonl, _) = frames_jsonl(&conn, &lib.0, vid).unwrap();
    let lines: Vec<Value> = jsonl
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect();
    assert_eq!(lines[0]["app"]["name"], "[redacted]");
    assert_eq!(lines[0]["windows"][0]["app_name"], "[redacted]");
    assert!(!lines[0].to_string().contains("alice@example.com"));
    assert_eq!(
        lines[1]["app"]["name"], "alice@example.com",
        "flag-off metadata is unchanged"
    );
    assert_eq!(lines[1]["windows"][0]["app_name"], "alice@example.com");
}

#[test]
fn tombstones_cover_all_objects_and_open_multipart_uploads() {
    let (_lib, conn) = Lib::new();
    conn.execute("INSERT INTO sync_multipart(key, upload_id, sha256, size, part_size, created_at) VALUES ('kc/dev/2026/10/02/5-1.mp4', 'up-1', 'x', 1, 1, 0)", []).unwrap();
    conn.execute("INSERT INTO sync_part(key, part_number, etag, sha256) VALUES ('kc/dev/2026/10/02/5-1.mp4', 1, 'e', 's')", []).unwrap();
    let n = tombstone_chunk(&conn, "dev", "kc/dev/2026/10/02/5-1", 5, "forget").unwrap();
    assert_eq!(n, 4, "mp4, sidecar, manifest, and the multipart abort");
    let aborts: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_tombstone WHERE upload_id = 'up-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(aborts, 1);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sync_part", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let line: String = conn
        .query_row("SELECT line FROM sync_journal", [], |r| r.get(0))
        .unwrap();
    assert!(
        line.contains(r#""op":"delete""#) && line.contains("dev/2026/10/02/5-1"),
        "{line}"
    );
    // Another device's chunk: objects go, but this device's index is not touched.
    tombstone_chunk(&conn, "dev", "kc/other/2026/10/02/6-2", 6, "forget").unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sync_journal", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn forget_removes_whole_chunks_locally_and_queues_remote_deletes() {
    let (lib, conn) = Lib::new();
    let a = seed_chunk(&conn, &lib.0, 10_000, "keepme");
    let b = seed_chunk(&conn, &lib.0, 20_000, "forgetme");
    conn.execute("UPDATE video SET uploaded_at = 1, remote_key = 'kortix-capture/dev/x/20000-' || id WHERE id = ?1", [b]).unwrap();
    // A staged still inside the range.
    let still = lib.0.frames_dir().join("s.jpg");
    std::fs::write(&still, b"jpg").unwrap();
    conn.execute("INSERT INTO frame(timestamp, image_path, foreground, ocr_status) VALUES (23000, 'frames/s.jpg', 'staged forgetme', 1)", []).unwrap();
    let mut s = Settings::default();
    s.sync.s3.endpoint = "http://127.0.0.1:9".into();
    // The range touches only the second frame of chunk b: the whole chunk goes.
    let range = TimeRange {
        start: Some(21_500),
        end: Some(23_500),
    };
    let dry = forget(&conn, &lib.0, &s, "dev", range, true).unwrap();
    assert_eq!((dry.chunks, dry.frames, dry.dry_run), (1, 3, true));
    assert_eq!(
        conn.query_row("SELECT count(*) FROM frame", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        5,
        "dry run changes nothing"
    );
    let r = forget(&conn, &lib.0, &s, "dev", range, false).unwrap();
    assert_eq!((r.chunks, r.frames), (1, 3));
    assert_eq!(
        (r.start_ms, r.end_ms),
        (Some(20_000), Some(22_000)),
        "the removed range is the whole chunk"
    );
    assert_eq!(r.remote_objects_queued, 3);
    let hits = |q: &str| {
        conn.query_row(
            "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH ?1",
            [q],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    };
    assert_eq!(hits("forgetme"), 0, "text is gone from search");
    assert_eq!(hits("keepme"), 2, "other chunks stay");
    assert!(!lib.0.videos_dir().join("v20000.mp4").exists() && !still.exists());
    assert!(lib.0.videos_dir().join("v10000.mp4").exists());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM video", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ocr", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ax_snapshot", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM ax_blob", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1,
        "a shared AX blob still in use stays"
    );
    let keys: Vec<String> = conn
        .prepare("SELECT key FROM sync_tombstone ORDER BY key")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|k| k.unwrap())
        .collect();
    assert_eq!(keys.len(), 3);
    assert!(
        keys.iter()
            .all(|k| k.starts_with(&format!("kortix-capture/dev/x/20000-{b}"))),
        "{keys:?}"
    );
    let _ = a;
}

#[test]
fn forget_of_a_never_uploaded_chunk_still_deletes_a_partial_upload() {
    let (lib, conn) = Lib::new();
    let v = seed_chunk(&conn, &lib.0, 50_000, "partial");
    let mut s = Settings::default();
    s.sync.s3.endpoint = "http://127.0.0.1:9".into();
    let r = forget(
        &conn,
        &lib.0,
        &s,
        "dev",
        TimeRange {
            start: Some(50_000),
            end: Some(50_000),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        r.remote_objects_queued, 3,
        "predictable keys of a sidecar that may already be up"
    );
    let key: String = conn
        .query_row(
            "SELECT key FROM sync_tombstone ORDER BY key LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        key,
        format!("kortix-capture/dev/1970/01/01/50000-{v}.frames.jsonl.zst"),
        "the first of the chunk's keys"
    );
    // Without a sync target configured there is nothing to delete remotely.
    let (lib2, conn2) = Lib::new();
    seed_chunk(&conn2, &lib2.0, 50_000, "partial");
    let r = forget(
        &conn2,
        &lib2.0,
        &Settings::default(),
        "dev",
        TimeRange {
            start: Some(50_000),
            end: Some(50_000),
        },
        false,
    )
    .unwrap();
    assert_eq!(r.remote_objects_queued, 0);
}

#[test]
fn remote_retention_purges_old_chunks_and_never_frees_their_local_copy() {
    let (lib, conn) = Lib::new();
    let day = MS_PER_DAY;
    let now = 100 * day;
    let old_remote = seed_chunk(&conn, &lib.0, now - 40 * day, "old remote");
    let old_local = seed_chunk(&conn, &lib.0, now - 40 * day + 10_000, "old local");
    let fresh = seed_chunk(&conn, &lib.0, now - day, "fresh");
    for (id, status) in [(old_remote, STATUS_REMOTE), (old_local, 0), (fresh, 0)] {
        conn.execute("UPDATE video SET uploaded_at = ?1, remote_key = 'kc/' || id, status = ?2 WHERE id = ?3", params![now - 2 * day, status, id]).unwrap();
    }
    let mut s = SyncSettings {
        remote_retention_days: 30,
        ..Default::default()
    };
    s.s3.prefix = "kc".into();
    assert_eq!(remote_retention(&conn, &s, "dev", now).unwrap(), 2);
    let row = |id: i64| {
        conn.query_row(
            "SELECT status, remote_key FROM video WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .unwrap()
    };
    assert_eq!(
        row(old_remote),
        (STATUS_DELETED, None),
        "remote-only and purged: screenshot gone, text stays"
    );
    assert_eq!(row(old_local), (0, None), "local copy is kept");
    assert_eq!(
        row(fresh).1.as_deref(),
        Some(format!("kc/{fresh}").as_str())
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sync_tombstone", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        6
    );
    // release_local must not delete a local video whose cloud copy is gone.
    let off = SyncSettings::default();
    assert_eq!(
        release_local(&conn, &lib.0, &off, now).unwrap(),
        1,
        "only the fresh uploaded chunk is released"
    );
    assert!(lib
        .0
        .videos_dir()
        .join(format!("v{}.mp4", now - 40 * day + 10_000))
        .exists());
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hits, 4, "text of purged chunks stays searchable");
}

#[test]
fn state_reports_queue_depth_bytes_age_and_error_class() {
    let (lib, conn) = Lib::new();
    let start = now_ms() - 120_000;
    let a = seed_chunk(&conn, &lib.0, start, "a");
    seed_chunk(&conn, &lib.0, start + 60_000, "b");
    conn.execute("UPDATE video SET upload_attempts = 2, upload_error = 'GET x: HTTP 503', upload_error_class = 'transient' WHERE id = ?1", [a]).unwrap();
    conn.execute(
        "INSERT INTO sync_tombstone(key, reason, created_at) VALUES ('k', 'forget', 0)",
        [],
    )
    .unwrap();
    let mut s = Settings::default();
    s.sync.enabled = true;
    let st = compute_state(&conn, &lib.0, &s, true, "dev", &Runtime::default());
    assert_eq!(
        (
            st.state.as_str(),
            st.pending,
            st.bytes_pending,
            st.retrying,
            st.tombstones
        ),
        ("ok", 2, 2000, 1, 1)
    );
    assert!(st.oldest_unsent_ms.unwrap() >= 118_000);
    assert_eq!(st.last_error_class.as_deref(), Some("transient"));
    let rt = Runtime {
        error: Some(("PUT k: HTTP 403 AccessDenied".into(), ErrorClass::Auth)),
        retry_at: 42,
        ..Default::default()
    };
    let st = compute_state(&conn, &lib.0, &s, true, "dev", &rt);
    assert_eq!(
        (
            st.state.as_str(),
            st.last_error_class.as_deref(),
            st.next_retry_ms
        ),
        ("error", Some("auth"), Some(42))
    );
    let off = compute_state(&conn, &lib.0, &s, false, "dev", &Runtime::default());
    assert_eq!(off.state, "off");
}

#[test]
fn a_destination_switch_keeps_earlier_recordings_local() {
    let (lib, conn) = Lib::new();
    let start = now_ms() - 600_000;
    let sent = seed_chunk(&conn, &lib.0, start, "sent");
    seed_chunk(&conn, &lib.0, start + 60_000, "before the switch");
    conn.execute("UPDATE video SET uploaded_at = 1, remote_key = 'k' WHERE id = ?1", [sent]).unwrap();
    let mut s = Settings::default();
    s.sync.enabled = true;
    let pending = |conn: &Connection| {
        let st = compute_state(conn, &lib.0, &s, true, "dev", &Runtime::default());
        (st.pending, st.bytes_pending, st.uploaded)
    };
    assert_eq!(pending(&conn), (1, 1000, 1));
    // The switch: the one chunk not uploaded yet stays here; the uploaded one is untouched.
    assert_eq!(store::keep_unsent_local(&conn).unwrap(), 1);
    assert_eq!(pending(&conn), (0, 0, 1));
    assert_eq!(store::keep_unsent_local(&conn).unwrap(), 0, "a second switch marks nothing new");
    // A chunk recorded after the switch is pending for the new destination.
    seed_chunk(&conn, &lib.0, start + 120_000, "after the switch");
    assert_eq!(pending(&conn), (1, 1000, 1));
    let local: i64 = conn.query_row("SELECT count(*) FROM video WHERE local_only = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(local, 1);
}

#[test]
fn backfill_indexes_chunks_uploaded_before_the_index() {
    let (lib, conn) = Lib::new();
    let a = seed_chunk(&conn, &lib.0, 1_790_985_599_000, "a");
    conn.execute("UPDATE video SET uploaded_at = 1, remote_key = 'kc/dev/2026/10/02/1790985599000-' || id WHERE id = ?1", [a]).unwrap();
    seed_chunk(&conn, &lib.0, 1_790_985_600_000, "not uploaded");
    backfill_index(&conn, "dev").unwrap();
    let (day, line): (String, String) = conn
        .query_row("SELECT day, line FROM sync_journal", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(day, "2026-10-02");
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        (v["op"].as_str(), v["manifest"].as_bool()),
        (Some("put"), Some(false))
    );
    assert_eq!(v["base"], format!("dev/2026/10/02/1790985599000-{a}"));
}

#[test]
fn cache_eviction_keeps_newest_and_the_fresh_download() {
    let dir = std::env::temp_dir().join(format!(
        "kortix-sync-cache-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["a.mp4", "b.mp4", "c.mp4"] {
        std::fs::write(dir.join(name), vec![0u8; 100]).unwrap();
        std::thread::sleep(Duration::from_millis(20));
    }
    evict_cache(&dir, 150, Some(&dir.join("a.mp4")));
    assert!(dir.join("a.mp4").exists(), "the file just fetched is kept");
    assert!(
        !dir.join("b.mp4").exists() && !dir.join("c.mp4").exists(),
        "older files go until the cache fits"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_and_unbuilt_providers_are_config_errors() {
    let (lib, _conn) = Lib::new();
    let mut s = Settings::default();
    for p in ["ftp"] {
        s.sync.provider = p.into();
        let err = target(&lib.0, &s).err().unwrap();
        assert_eq!(classify(&err), ErrorClass::Config, "{p}: {err:#}");
    }
}

#[test]
fn kortix_provider_refuses_encryption_before_asking_the_issuer() {
    let (lib, _conn) = Lib::new();
    let mut s = Settings::default();
    s.sync.provider = "kortix".into();
    s.sync.encrypt = true;
    let err = target(&lib.0, &s).err().unwrap();
    assert_eq!(classify(&err), ErrorClass::Config);
    assert!(
        format!("{err:#}").contains("not supported with the kortix provider"),
        "{err:#}"
    );
}

/// An encoded audio segment with one transcript line.
fn seed_audio(conn: &Connection, paths: &MemoryPaths, start: i64, words: &str) -> i64 {
    std::fs::create_dir_all(paths.audio_dir()).unwrap();
    let name = format!("{start}.m4a");
    std::fs::write(paths.audio_dir().join(&name), vec![9u8; 700]).unwrap();
    conn.execute(
        "INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources, transcript_status) VALUES (?1, ?2, ?3, 700, 'microphone,system', 2)",
        params![start, start + 60_000, name],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (?1, ?2, ?3, ?4)",
        params![id, start + 1000, start + 3000, words],
    )
    .unwrap();
    id
}

#[test]
fn audio_keys_tombstones_release_retention_and_forget() {
    let (lib, conn) = Lib::new();
    let p = &lib.0;
    assert_eq!(
        audio_rel("dev-1", 1_790_985_599_000, 7),
        "dev-1/2026/10/02/1790985599000-a7"
    );
    let now = 1_800_000_000_000;
    let a = seed_audio(&conn, p, now - 10 * MS_PER_DAY, "old budget words");
    let b = seed_audio(&conn, p, now - 60_000, "fresh zebrafish words");
    for (id, start) in [(a, now - 10 * MS_PER_DAY), (b, now - 60_000)] {
        conn.execute(
            "UPDATE audio SET uploaded_at = ?1, remote_key = ?2, remote_sha256 = 'ab' WHERE id = ?3",
            params![now - MS_PER_HOUR, format!("kc/{}", audio_rel("dev", start, id)), id],
        )
        .unwrap();
    }
    // "Keep on this Mac" = 0: uploaded audio leaves the disk and stays playable from the cloud.
    let mut s = Settings::default();
    s.sync.enabled = true;
    s.sync.s3.endpoint = "http://127.0.0.1:9".into();
    s.sync.s3.prefix = "kc".into();
    assert_eq!(release_local(&conn, p, &s.sync, now).unwrap(), 2);
    let status = |id: i64| -> i64 {
        conn.query_row("SELECT status FROM audio WHERE id = ?1", [id], |r| r.get(0))
            .unwrap()
    };
    assert_eq!((status(a), status(b)), (STATUS_REMOTE, STATUS_REMOTE));
    assert!(!p.audio_dir().join(format!("{}.m4a", now - 60_000)).exists());
    // Cloud retention of 7 days: the old segment's objects are queued for deletion.
    s.sync.remote_retention_days = 7;
    assert_eq!(remote_retention(&conn, &s.sync, "dev", now).unwrap(), 1);
    assert_eq!(status(a), STATUS_DELETED);
    let keys: Vec<String> = conn
        .prepare("SELECT key FROM sync_tombstone ORDER BY key")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|k| k.unwrap())
        .collect();
    assert!(
        keys.iter().any(|k| k.ends_with(&format!("-a{a}.m4a"))),
        "{keys:?}"
    );
    assert!(keys
        .iter()
        .any(|k| k.ends_with(&format!("-a{a}.manifest.json"))));
    // Forget the range of the fresh one: row, transcript, search and its cloud objects go.
    let r = forget(
        &conn,
        p,
        &s,
        "dev",
        TimeRange {
            start: Some(now - 30_000),
            end: Some(now - 20_000),
        },
        true,
    )
    .unwrap();
    assert_eq!((r.audio, r.remote_objects_queued), (1, 2), "dry run counts");
    let r = forget(
        &conn,
        p,
        &s,
        "dev",
        TimeRange {
            start: Some(now - 30_000),
            end: Some(now - 20_000),
        },
        false,
    )
    .unwrap();
    assert_eq!(r.audio, 1);
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM audio_fts WHERE audio_fts MATCH 'zebrafish'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM audio WHERE id = ?1", [b], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let deleted: i64 = conn
        .query_row(
            "SELECT count(*) FROM sync_tombstone WHERE key LIKE ?1",
            [format!("%-a{b}.%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 2);
}

#[test]
fn one_sync_lock_holder_per_library() {
    let (lib, _conn) = Lib::new();
    let held = lock_passes(&lib.0, false).unwrap();
    assert!(held.is_some(), "a free library locks");
    assert!(
        lock_passes(&lib.0, false).unwrap().is_none(),
        "a second uploader is refused while the first holds the lock"
    );
    // A waiter gets the lock the moment the holder's pass ends.
    let paths = lib.0.clone();
    let waiter = std::thread::spawn(move || {
        let t0 = Instant::now();
        let lock = lock_passes(&paths, true).unwrap();
        (lock.is_some(), t0.elapsed())
    });
    std::thread::sleep(Duration::from_millis(300));
    drop(held);
    let (got, waited) = waiter.join().unwrap();
    assert!(got && waited >= Duration::from_millis(250), "{waited:?}");
    assert!(lock_passes(&lib.0, false).unwrap().is_some());
}

#[test]
fn a_chunk_names_its_display_in_the_frames_and_the_manifest() {
    let (lib, conn) = Lib::new();
    let vid = seed_chunk(&conn, &lib.0, 1_000, "alpha");
    conn.execute(
        "UPDATE frame SET display_id = 2, display_name = 'LG ULTRAWIDE', display_main = 0, display_focused = 1,
                          capture_display_x = 1728, capture_display_y = 0, capture_display_width = 3440, capture_display_height = 1440
         WHERE video = ?1",
        [vid],
    )
    .unwrap();
    conn.execute(
        r#"UPDATE video SET display_id = 2, display = '{"id":2,"name":"LG ULTRAWIDE","x":1728,"y":0,"w":3440,"h":1440,"scale":1,"main":false}' WHERE id = ?1"#,
        [vid],
    )
    .unwrap();
    let (jsonl, _) = frames_jsonl(&conn, &lib.0, vid).unwrap();
    let first: Value =
        serde_json::from_slice(jsonl.split(|b| *b == b'\n').next().unwrap()).unwrap();
    assert_eq!(
        first["display"],
        json!({"id": 2, "name": "LG ULTRAWIDE", "main": false, "focused": true, "x": 1728.0, "y": 0.0, "w": 3440.0, "h": 1440.0})
    );
    assert_eq!(video_display(&conn, vid).unwrap()["name"], "LG ULTRAWIDE");
    // A chunk recorded before multi-display names no display.
    let old = seed_chunk(&conn, &lib.0, 9_000, "beta");
    assert_eq!(video_display(&conn, old), None);
}

#[test]
fn device_json_lists_the_displays_of_the_current_layout() {
    let (lib, conn) = Lib::new();
    let rec = crate::memory::recorder::RecorderStatus {
        displays: vec![crate::memory::recorder::DisplayStatus {
            id: 1,
            name: Some("Built-in Retina Display".into()),
            main: true,
            focused: true,
            x: 0.0,
            y: 0.0,
            w: 1728.0,
            h: 1117.0,
            scale: 2.0,
            last_frame_ms: Some(5),
        }],
        ..Default::default()
    };
    std::fs::write(lib.0.status(), serde_json::to_vec(&rec).unwrap()).unwrap();
    assert_eq!(
        device_displays(&lib.0),
        json!([{"id": 1, "name": "Built-in Retina Display", "x": 0.0, "y": 0.0, "w": 1728.0, "h": 1117.0, "scale": 2.0, "main": true}])
    );
    drop(conn);
}

#[test]
fn awake_since_restarts_after_a_sleep_gap_only() {
    let mut rt = Runtime::default();
    note_wake(&mut rt, 1_000);
    assert_eq!(rt.awake_since_ms, 1_000, "the first tick starts the awake spell");
    rt.last_tick_ms = 1_000;
    note_wake(&mut rt, 1_000 + SLEEP_GAP_MS);
    assert_eq!(rt.awake_since_ms, 1_000, "a gap of exactly the limit is not a sleep");
    rt.last_tick_ms = 1_000 + SLEEP_GAP_MS;
    note_wake(&mut rt, 1_000 + 2 * SLEEP_GAP_MS + 1);
    assert_eq!(rt.awake_since_ms, 1_000 + 2 * SLEEP_GAP_MS + 1, "a longer gap restarts it");
}
