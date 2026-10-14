use kortix_backend::streaming_writer::StreamingJsonlinesWriter;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

fn tmp_jsonl(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kortix_{name}_{}.jsonl", Uuid::new_v4()))
}

fn event(ts: f64, id: usize) -> Value {
    json!({ "type": "checkpoint", "timestamp": ts, "data": { "id": id } })
}

#[test]
fn writer_flushes_eighty_percent_when_buffer_reaches_capacity() {
    let path = tmp_jsonl("writer_partial_flush");
    let mut writer = StreamingJsonlinesWriter::new(&path, 5, false)
        .open()
        .expect("open writer");

    for idx in 0..6 {
        writer
            .write(event(idx as f64, idx))
            .expect("write buffered event");
    }

    let visible = StreamingJsonlinesWriter::read_jsonl(&path).expect("read partially flushed file");
    assert_eq!(visible.len(), 4);

    writer.close().expect("close writer");
    let all = StreamingJsonlinesWriter::read_jsonl(&path).expect("read closed file");
    let _ = std::fs::remove_file(&path);

    assert_eq!(all.len(), 6);
    assert_eq!(all[0]["data"]["id"], 0);
    assert_eq!(all[5]["data"]["id"], 5);
}

#[test]
fn writer_sorts_buffer_by_timestamp_before_flush() {
    let path = tmp_jsonl("writer_sorted_flush");
    let mut writer = StreamingJsonlinesWriter::new(&path, 10, true)
        .open()
        .expect("open writer");

    writer.write(event(3.0, 3)).expect("write ts 3");
    writer.write(event(1.0, 1)).expect("write ts 1");
    writer.write(event(2.0, 2)).expect("write ts 2");
    writer.close().expect("close writer");

    let all = StreamingJsonlinesWriter::read_jsonl(&path).expect("read closed file");
    let _ = std::fs::remove_file(&path);
    let ids = all
        .iter()
        .map(|value| value["data"]["id"].as_u64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn writer_flush_opens_unopened_writer_without_losing_buffered_events() {
    let path = tmp_jsonl("writer_flush_reopens");
    let mut writer = StreamingJsonlinesWriter::new(&path, 10, false);

    writer.write(event(1.0, 1)).expect("write buffered event");
    writer.flush(true).expect("flush unopened writer");
    writer.close().expect("close writer");

    let all = StreamingJsonlinesWriter::read_jsonl(&path).expect("read flushed file");
    let _ = std::fs::remove_file(&path);

    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["data"]["id"], 1);
}
