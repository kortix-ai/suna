//! Abrupt-shutdown recovery of action segments.
//!
//! When a segment of a segmented session is killed mid-recording it has no `end_time` and
//! may have an empty/missing preprocessed file (the streaming writer buffer never flushed).
//! `finalize_abandoned_segment` regenerates the preprocessed file from the raw stream and
//! closes the metadata; `recover_segments` then adds the segment to the capture library
//! and removes its spool, so nothing recorded is lost.

use kortix_backend::{daemon, processor};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use uuid::Uuid;

const RAW_EVENTS: &str = concat!(
    r#"{"type":"mouse_scroll","timestamp":1.0,"data":{"x":0.4,"y":0.5,"clicks":2,"display_id":111}}"#,
    "\n",
    r#"{"type":"screenshot","timestamp":1.2,"data":{"image":"after_first_scroll","width":100,"height":100,"encoding":"jpg"}}"#,
    "\n",
    r#"{"type":"mouse_scroll","timestamp":2.0,"data":{"x":0.4,"y":0.5,"clicks":2,"display_id":111}}"#,
    "\n",
    r#"{"type":"screenshot","timestamp":2.2,"data":{"image":"after_second_scroll","width":100,"height":100,"encoding":"jpg"}}"#,
    "\n",
);

fn nonempty_jsonl_lines(path: &PathBuf) -> usize {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty() && serde_json::from_str::<Value>(line).is_ok())
        .count()
}

#[test]
fn process_raw_to_preprocessed_produces_nonempty_output() {
    let dir = std::env::temp_dir().join(format!("kortix-proc-raw-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).expect("create dir");
    let raw = dir.join("seg_raw.jsonl");
    let preprocessed = dir.join("seg_preprocessed.jsonl");
    fs::write(&raw, RAW_EVENTS).expect("write raw");

    processor::process_raw_to_preprocessed(&raw, &preprocessed)
        .expect("process raw -> preprocessed");

    assert!(
        preprocessed.is_file(),
        "preprocessed file should be created"
    );
    assert!(
        nonempty_jsonl_lines(&preprocessed) > 0,
        "regenerated preprocessed should contain parseable events"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn finalize_recovers_orphaned_segment_with_missing_preprocessed() {
    let recordings_dir = std::env::temp_dir().join(format!("kortix-recovery-{}", Uuid::new_v4()));
    let name = "tray_20260616_210000";
    let recording_dir = recordings_dir.join(name);
    fs::create_dir_all(&recording_dir).expect("create recording dir");

    // Production-ephemeral recording killed mid-segment: raw exists, NO preprocessed,
    // no end_time, not uploaded.
    fs::write(recording_dir.join(format!("{name}_raw.jsonl")), RAW_EVENTS).expect("write raw");
    let metadata = json!({
        "name": name,
        "local_artifacts_mode": "production_ephemeral",
        "upload_status": "not_uploaded",
        "detailed_events": true,
        "save_raw_data": true,
        "start_time": "2026-06-16T21:00:00Z",
        "end_time": null,
    });
    fs::write(
        recording_dir.join(format!("{name}_metadata.json")),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .expect("write metadata");

    let finalized = daemon::finalize_abandoned_segment(&recording_dir, name).unwrap();
    assert!(finalized, "the orphaned segment should be finalized");

    // Preprocessed was regenerated from raw.
    let preprocessed = recording_dir.join(format!("{name}_preprocessed.jsonl"));
    assert!(
        preprocessed.is_file() && nonempty_jsonl_lines(&preprocessed) > 0,
        "preprocessed should be regenerated from raw and non-empty"
    );

    // Metadata was finalized so the segment can go into the library.
    let updated: Value = serde_json::from_slice(
        &fs::read(recording_dir.join(format!("{name}_metadata.json"))).expect("read metadata"),
    )
    .expect("parse metadata");
    assert!(
        updated.get("end_time").and_then(Value::as_str).is_some(),
        "finalize should synthesize an end_time"
    );
    assert_eq!(
        updated
            .get("recovered_after_unexpected_shutdown")
            .and_then(Value::as_bool),
        Some(true),
        "finalize should mark the recording as recovered"
    );

    let _ = fs::remove_dir_all(&recordings_dir);
}

#[test]
fn finalize_skips_already_finalized_segment() {
    let recordings_dir =
        std::env::temp_dir().join(format!("kortix-recovery-skip-{}", Uuid::new_v4()));
    let name = "tray_20260616_210500";
    let recording_dir = recordings_dir.join(name);
    fs::create_dir_all(&recording_dir).expect("create recording dir");
    fs::write(recording_dir.join(format!("{name}_raw.jsonl")), RAW_EVENTS).expect("write raw");
    // Already has an end_time: a cleanly stopped recording must not be re-finalized.
    let metadata = json!({
        "name": name,
        "local_artifacts_mode": "production_ephemeral",
        "upload_status": "not_uploaded",
        "start_time": "2026-06-16T21:05:00Z",
        "end_time": "2026-06-16T21:06:00Z",
    });
    fs::write(
        recording_dir.join(format!("{name}_metadata.json")),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .expect("write metadata");

    let finalized = daemon::finalize_abandoned_segment(&recording_dir, name).unwrap();
    assert!(
        !finalized,
        "a cleanly stopped segment must not be finalized"
    );

    let _ = fs::remove_dir_all(&recordings_dir);
}

#[test]
fn recovery_adds_orphaned_segments_to_the_library_and_clears_the_spool() {
    let root = std::env::temp_dir().join(format!("kortix-recover-{}", Uuid::new_v4()));
    let library = root.join("library");
    std::env::set_var("KORTIX_CAPTURE_DIR", &library);
    let recordings_dir = root.join("recordings");
    let name = "tray_chunk_0001_20260616_211000";
    let recording_dir = recordings_dir.join(name);
    fs::create_dir_all(&recording_dir).unwrap();
    fs::write(recording_dir.join(format!("{name}_raw.jsonl")), RAW_EVENTS).unwrap();
    fs::write(
        recording_dir.join(format!("{name}_metadata.json")),
        serde_json::to_vec_pretty(&json!({
            "name": name,
            "local_artifacts_mode": "production_ephemeral",
            "start_time": "2026-06-16T21:10:00Z",
        }))
        .unwrap(),
    )
    .unwrap();
    // A durable recording (the local API without a session) stays where it is.
    let manual = recordings_dir.join("manual");
    fs::create_dir_all(&manual).unwrap();
    fs::write(manual.join("manual_metadata.json"), "{}").unwrap();

    let added = daemon::recover_segments(&recordings_dir, None, u64::MAX);
    assert_eq!(added, 1);
    assert!(
        !recording_dir.exists(),
        "the spool of an ingested segment is removed"
    );
    assert!(manual.exists());
    let conn = rusqlite::Connection::open(library.join("memory.db")).unwrap();
    let (source, events): (String, i64) = conn
        .query_row("SELECT source, event_count FROM action_segment", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(source, name);
    assert!(events > 0);
    // Running recovery again adds nothing.
    assert_eq!(daemon::recover_segments(&recordings_dir, None, u64::MAX), 0);
    let _ = fs::remove_dir_all(&root);
}
