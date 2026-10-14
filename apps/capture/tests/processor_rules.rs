use kortix_backend::{
    event_reorder::TimestampReorderedProcessor, processor::RealTimeEventProcessor,
    streaming_writer::StreamingJsonlinesWriter,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier, Mutex},
    thread,
};
use uuid::Uuid;

fn tmp_jsonl(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kortix_{name}_{}.jsonl", Uuid::new_v4()))
}

fn screenshot(ts: f64, label: &str) -> Value {
    json!({
        "type": "screenshot",
        "timestamp": ts,
        "data": {
            "image": label,
            "width": 100,
            "height": 100,
            "encoding": "jpg",
        }
    })
}

fn screenshot_image(ts: f64, image: &str) -> Value {
    json!({
        "type": "screenshot",
        "timestamp": ts,
        "data": {
            "image": image,
            "width": 8,
            "height": 8,
            "encoding": "png",
        }
    })
}

fn a11y_screenshot(ts: f64, end_ts: f64, label: &str) -> Value {
    json!({
        "type": "a11y+screenshot",
        "timestamp": ts,
        "end_timestamp": end_ts,
        "event_screenshot_hash": format!("temporary-{label}"),
        "data": {
            "image": label,
            "tree": format!("<window name=\"{label}\" />"),
            "width": 100,
            "height": 100,
            "encoding": "jpg",
        }
    })
}

fn key_down(ts: f64, key: &str) -> Value {
    json!({ "type": "key_down", "timestamp": ts, "data": { "key": key } })
}

fn key_up(ts: f64, key: &str) -> Value {
    json!({ "type": "key_up", "timestamp": ts, "data": { "key": key, "hold_duration": 0.03 } })
}

fn key_press(ts: f64, key: &str) -> Vec<Value> {
    vec![key_down(ts, key), key_up(ts + 0.03, key)]
}

fn control_backspace_press(ts: f64) -> Vec<Value> {
    vec![key_down(ts, "\u{8}"), key_up(ts + 0.03, "backspace")]
}

fn mouse_down(ts: f64, x: f64, y: f64, button: &str) -> Value {
    json!({ "type": "mouse_down", "timestamp": ts, "data": { "x": x, "y": y, "button": button } })
}

fn mouse_up(ts: f64, x: f64, y: f64, button: &str) -> Value {
    json!({ "type": "mouse_up", "timestamp": ts, "data": { "x": x, "y": y, "button": button } })
}

fn click(ts: f64, x: f64, y: f64, button: &str) -> Vec<Value> {
    vec![
        mouse_down(ts, x, y, button),
        mouse_up(ts + 0.05, x, y, button),
    ]
}

fn drag(ts: f64, x1: f64, y1: f64, x2: f64, y2: f64, button: &str) -> Vec<Value> {
    vec![
        mouse_down(ts, x1, y1, button),
        json!({
            "type": "mouse_move",
            "timestamp": ts + 0.2,
            "data": { "x": x2, "y": y2, "is_dragging": true }
        }),
        mouse_up(ts + 0.45, x2, y2, button),
    ]
}

fn scroll(ts: f64, clicks: i64) -> Value {
    json!({
        "type": "mouse_scroll",
        "timestamp": ts,
        "data": { "x": 0.4, "y": 0.5, "clicks": clicks }
    })
}

fn scroll_on_display(ts: f64, clicks: i64, display_id: u64) -> Value {
    json!({
        "type": "mouse_scroll",
        "timestamp": ts,
        "data": { "x": 0.4, "y": 0.5, "clicks": clicks, "display_id": display_id }
    })
}

fn checkpoint(ts: f64) -> Value {
    json!({ "type": "checkpoint", "timestamp": ts, "data": {} })
}

fn run_processor(events: Vec<Value>) -> Vec<Value> {
    let output = tmp_jsonl("processor_rules_preprocessed");
    let writer = StreamingJsonlinesWriter::new(&output, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let processor = RealTimeEventProcessor::new(Some(writer), None);

    for event in events {
        processor.add_event(event).expect("process event");
    }
    processor.stop().expect("stop processor");

    let processed = StreamingJsonlinesWriter::read_jsonl(&output).expect("read preprocessed");
    let _ = std::fs::remove_file(&output);
    processed
}

fn run_reordered_processor(events: Vec<Value>) -> Vec<Value> {
    let output = tmp_jsonl("processor_rules_preprocessed");
    let writer = StreamingJsonlinesWriter::new(&output, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let processor =
        TimestampReorderedProcessor::new(RealTimeEventProcessor::new(Some(writer), None));

    for event in events {
        processor.add_event(event).expect("process event");
    }
    processor.stop().expect("stop processor");

    let processed = StreamingJsonlinesWriter::read_jsonl(&output).expect("read preprocessed");
    let _ = std::fs::remove_file(&output);
    processed
}

fn load_processor_fixture(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("processor")
        .join(name);
    StreamingJsonlinesWriter::read_jsonl(path).expect("read processor fixture")
}

fn run_processor_with_a11y(events: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    let preprocessed_path = tmp_jsonl("processor_rules_preprocessed");
    let a11y_path = tmp_jsonl("processor_rules_a11y");
    let preprocessed_writer = StreamingJsonlinesWriter::new(&preprocessed_path, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let a11y_writer = StreamingJsonlinesWriter::new(&a11y_path, 1000, false)
        .open()
        .expect("open a11y writer");
    let processor = RealTimeEventProcessor::new(Some(preprocessed_writer), Some(a11y_writer));

    for event in events {
        processor.add_event(event).expect("process event");
    }
    processor.stop().expect("stop processor");

    let processed =
        StreamingJsonlinesWriter::read_jsonl(&preprocessed_path).expect("read preprocessed");
    let a11y = StreamingJsonlinesWriter::read_jsonl(&a11y_path).expect("read a11y");
    let _ = std::fs::remove_file(&preprocessed_path);
    let _ = std::fs::remove_file(&a11y_path);
    (processed, a11y)
}

fn actions(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) != Some("screenshot"))
        .cloned()
        .collect()
}

fn screenshots(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("screenshot"))
        .cloned()
        .collect()
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string()
        })
        .collect()
}

fn assert_approx(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "expected {actual} to be approximately {expected}"
    );
}

fn action_index_by_command_at(events: &[Value], command: &str, expected_ts: f64) -> usize {
    events
        .iter()
        .position(|event| {
            event.get("type").and_then(Value::as_str) != Some("screenshot")
                && event.get("command").and_then(Value::as_str) == Some(command)
                && event
                    .get("timestamp")
                    .and_then(Value::as_f64)
                    .map(|ts| (ts - expected_ts).abs() < 1e-6)
                    .unwrap_or(false)
        })
        .expect("find action by command and timestamp")
}

fn screenshot_before(events: &[Value], action_index: usize) -> &Value {
    events[..action_index]
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("screenshot"))
        .expect("screenshot before action")
}

fn screenshot_after(events: &[Value], action_index: usize) -> &Value {
    events[action_index + 1..]
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("screenshot"))
        .expect("screenshot after action")
}

fn screenshot_label(event: &Value) -> &str {
    event["args"]["image"].as_str().expect("screenshot label")
}

fn screenshot_frame_id(event: &Value) -> i64 {
    event["args"]["frame_id"]
        .as_i64()
        .expect("screenshot frame id")
}

#[test]
fn keyboard_rules_cover_typing_caps_repeat_press_and_hotkey() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(0.20, "a"));
    events.extend(key_press(0.30, "b"));
    events.extend(key_press(2.60, "c"));
    events.extend(key_press(2.90, "capslock"));
    events.extend(key_press(3.10, "d"));
    events.extend(key_press(4.00, "backspace"));
    events.extend(key_press(4.20, "backspace"));
    events.extend(key_press(4.40, "backspace"));
    events.push(key_down(5.00, "ctrl"));
    events.push(key_down(5.05, "shift"));
    events.push(key_down(5.10, "s"));
    events.push(key_up(5.13, "s"));
    events.push(key_up(5.20, "shift"));
    events.push(key_up(5.30, "ctrl"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(
        event_types(&actions),
        vec![
            "typewrite",
            "typewrite",
            "press",
            "typewrite",
            "press",
            "hotkey"
        ]
    );
    assert_eq!(actions[0]["args"]["text"], "ab");
    assert_eq!(actions[1]["args"]["text"], "c");
    assert_eq!(actions[2]["args"]["key"], "capslock");
    assert!(
        actions[2]["args"].get("lock_state").is_none(),
        "Caps Lock state should not be guessed when raw input did not observe it"
    );
    assert_eq!(actions[3]["args"]["text"], "D");
    assert_eq!(actions[4]["args"]["key"], "backspace");
    assert_eq!(actions[4]["args"]["count"], 3);
    assert_eq!(actions[5]["args"]["keys"], json!(["ctrl", "S"]));
}

#[test]
fn capslock_press_reports_only_observed_lock_state() {
    let mut unobserved_events = vec![screenshot(0.10, "start")];
    unobserved_events.extend(key_press(0.20, "capslock"));
    unobserved_events.extend(key_press(0.40, "capslock"));

    let unobserved_processed = run_processor(unobserved_events);
    let unobserved_actions = actions(&unobserved_processed);
    assert_eq!(event_types(&unobserved_actions), vec!["press", "press"]);
    assert!(
        unobserved_actions[0]["args"].get("lock_state").is_none(),
        "unobserved Caps Lock state must not be reported as ON/OFF"
    );
    assert!(
        unobserved_actions[1]["args"].get("lock_on").is_none(),
        "unobserved Caps Lock state must not be reported as a boolean"
    );

    let observed_events = vec![
        screenshot(1.00, "start"),
        json!({
            "type": "key_down",
            "timestamp": 1.20,
            "data": { "key": "capslock", "lock_on": false, "lock_state": "off" }
        }),
        key_up(1.23, "capslock"),
        json!({
            "type": "key_down",
            "timestamp": 1.40,
            "data": { "key": "capslock", "lock_on": true, "lock_state": "on" }
        }),
        key_up(1.43, "capslock"),
    ];

    let observed_processed = run_processor(observed_events);
    let observed_actions = actions(&observed_processed);
    assert_eq!(event_types(&observed_actions), vec!["press", "press"]);
    assert_eq!(observed_actions[0]["args"]["lock_state"], "off");
    assert_eq!(observed_actions[0]["args"]["lock_on"], false);
    assert_eq!(observed_actions[1]["args"]["lock_state"], "on");
    assert_eq!(observed_actions[1]["args"]["lock_on"], true);
}

#[test]
fn keyboard_held_backspace_autorepeat_stays_one_counted_press() {
    let events = vec![
        screenshot(0.10, "start"),
        key_down(1.00, "backspace"),
        screenshot(1.12, "after_first_backspace"),
        key_down(1.49, "backspace"),
        key_down(1.57, "backspace"),
        key_down(1.65, "backspace"),
        key_up(1.68, "backspace"),
        screenshot(1.80, "after_backspace_repeat"),
        mouse_down(2.50, 0.2, 0.3, "left"),
        mouse_up(2.55, 0.2, 0.3, "left"),
        screenshot(2.70, "after_click"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press", "click"]);
    assert_eq!(actions[0]["args"], json!({"count": 4, "key": "backspace"}));
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.65);
    assert!(
        processed
            .iter()
            .all(|event| event.get("type").and_then(Value::as_str) != Some("sleep")),
        "held autorepeat should not create a fake sleep between repeat key_down events"
    );
}

#[test]
fn keyboard_separate_slow_backspace_taps_do_not_use_held_repeat_delay() {
    let events = vec![
        screenshot(0.10, "start"),
        key_down(1.00, "backspace"),
        key_up(1.03, "backspace"),
        key_down(1.50, "backspace"),
        key_up(1.53, "backspace"),
        screenshot(1.70, "after_backspaces"),
        checkpoint(2.00),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press", "press"]);
    assert_eq!(actions[0]["args"], json!({"key": "backspace"}));
    assert_eq!(actions[1]["args"], json!({"key": "backspace"}));
}

#[test]
fn keyboard_tight_backspace_edits_pending_typewrite_text() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.10, "o"));
    events.extend(key_press(1.20, "r"));
    events.extend(key_press(1.70, "backspace"));
    events.extend(key_press(2.00, "n"));
    events.push(screenshot(2.20, "after_text"));
    events.push(checkpoint(2.60));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite"]);
    assert_eq!(actions[0]["args"]["text"], "aon");
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 2.00);
}

#[test]
fn keyboard_tight_control_backspace_edits_typewrite_across_screenshots() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(key_down(1.00, "a"));
    events.push(screenshot(1.02, "during_a"));
    events.push(key_up(1.03, "a"));
    events.push(key_down(1.10, "o"));
    events.push(screenshot(1.12, "during_o"));
    events.push(key_up(1.13, "o"));
    events.push(key_down(1.20, "r"));
    events.push(key_up(1.23, "r"));
    events.push(screenshot(1.55, "before_backspace"));
    events.extend(control_backspace_press(1.70));
    events.push(screenshot(1.78, "after_backspace"));
    events.extend(key_press(2.00, "n"));
    events.push(screenshot(2.20, "after_text"));
    events.push(checkpoint(2.60));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite"]);
    assert_eq!(actions[0]["args"]["text"], "aon");
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 2.00);
}

#[test]
fn keyboard_tight_backspace_keeps_leftover_delete_count_after_text_is_empty() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.10, "b"));
    events.extend(key_press(1.20, "c"));
    events.extend(key_press(1.50, "backspace"));
    events.extend(key_press(1.58, "backspace"));
    events.extend(key_press(1.66, "backspace"));
    events.extend(key_press(1.74, "backspace"));
    events.extend(key_press(1.82, "backspace"));
    events.push(screenshot(2.00, "after_deletes"));
    events.push(checkpoint(2.40));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"], json!({"count": 2, "key": "backspace"}));
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.82);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.82);
}

#[test]
fn keyboard_tight_control_backspace_autorepeat_keeps_leftover_delete_count() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.08, "b"));
    events.extend(key_press(1.16, "c"));
    events.push(key_down(1.40, "\u{8}"));
    events.push(key_down(1.48, "\u{8}"));
    events.push(key_down(1.56, "\u{8}"));
    events.push(key_down(1.64, "\u{8}"));
    events.push(key_down(1.72, "\u{8}"));
    events.push(key_up(1.75, "backspace"));
    events.push(screenshot(2.00, "after_deletes"));
    events.push(checkpoint(2.40));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"], json!({"count": 2, "key": "backspace"}));
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.64);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.72);
}

#[test]
fn keyboard_enter_breaks_tight_typewrite_backspace_merge() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.10, "enter"));
    events.extend(control_backspace_press(1.20));
    events.push(screenshot(1.40, "after_enter_backspace"));
    events.push(checkpoint(1.80));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite", "press", "press"]);
    assert_eq!(actions[0]["args"]["text"], "a");
    assert_eq!(actions[1]["args"]["key"], "enter");
    assert_eq!(actions[2]["args"]["key"], "backspace");
}

#[test]
fn keyboard_slow_backspace_does_not_edit_prior_typewrite() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.10, "b"));
    events.extend(control_backspace_press(2.10));
    events.push(screenshot(2.30, "after_slow_backspace"));
    events.push(checkpoint(2.70));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite", "press"]);
    assert_eq!(actions[0]["args"]["text"], "ab");
    assert_eq!(actions[1]["args"]["key"], "backspace");
}

#[test]
fn keyboard_click_breaks_tight_typewrite_merge() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "a"));
    events.extend(key_press(1.10, "b"));
    events.extend(click(1.30, 0.20, 0.30, "left"));
    events.extend(key_press(1.50, "c"));
    events.extend(control_backspace_press(1.60));
    events.extend(key_press(1.70, "d"));
    events.push(screenshot(1.90, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(
        event_types(&actions),
        vec!["typewrite", "click", "typewrite"]
    );
    assert_eq!(actions[0]["args"]["text"], "ab");
    assert_eq!(actions[1]["args"]["button"], "left");
    assert_eq!(actions[2]["args"]["text"], "d");
}

#[test]
fn keyboard_windows_key_is_hotkey_modifier() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "windows"),
        key_down(0.25, "r"),
        key_up(0.30, "r"),
        key_up(0.35, "windows"),
        screenshot(0.80, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["windows", "r"]));
}

#[test]
fn keyboard_hotkey_flushes_when_trigger_key_is_released() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "alt"),
        key_down(0.24, "shift"),
        key_down(0.28, "1"),
        key_up(0.32, "shift"),
        key_up(0.34, "1"),
        key_down(0.50, "1"),
        key_up(0.56, "alt"),
        key_up(0.58, "1"),
        screenshot(0.80, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey", "hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["alt", "!"]));
    assert_eq!(actions[0]["timestamp"], json!(0.28));
    assert_eq!(actions[1]["args"]["keys"], json!(["alt", "1"]));
    assert_eq!(actions[1]["timestamp"], json!(0.50));
}

#[test]
fn keyboard_repeated_hotkeys_while_modifier_is_held_stay_separate() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "ctrl"),
        key_down(0.25, "c"),
        key_up(0.30, "c"),
        key_down(0.40, "v"),
        key_up(0.45, "v"),
        key_up(0.50, "ctrl"),
        screenshot(0.80, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey", "hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "c"]));
    assert_eq!(actions[1]["args"]["keys"], json!(["ctrl", "v"]));
}

#[test]
fn keyboard_hotkey_start_timestamp_tracks_modifier_down() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(1.00, "alt"),
        screenshot(1.10, "during_modifier"),
        key_down(1.30, "1"),
        key_up(1.34, "1"),
        key_up(1.40, "alt"),
        screenshot(1.70, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["alt", "1"]));
    assert_eq!(actions[0]["start_timestamp"], json!(1.00));
    assert_eq!(actions[0]["timestamp"], json!(1.30));
}

#[test]
fn sleep_before_hotkey_uses_frame_before_modifier_down_with_gap() {
    let events = vec![
        screenshot(0.10, "start"),
        screenshot(3.05, "safe_before_modifier"),
        screenshot(3.14, "too_close_before_modifier"),
        key_down(3.25, "alt"),
        screenshot(3.30, "during_modifier"),
        key_down(3.60, "1"),
        key_up(3.65, "1"),
        key_up(3.70, "alt"),
        screenshot(3.95, "after_hotkey"),
        checkpoint(4.30),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["sleep", "hotkey"]);
    assert_eq!(actions[1]["start_timestamp"], json!(3.25));
    assert_eq!(actions[1]["timestamp"], json!(3.60));
    assert_eq!(
        shot_labels,
        vec!["start", "safe_before_modifier", "after_hotkey"]
    );
}

#[test]
fn tray_20260517_action13_keeps_previous_click_settled_frame_as_before_context() {
    let processed = run_reordered_processor(load_processor_fixture(
        "tray_20260517_screenshot_sync_raw_slice.jsonl",
    ));
    let action_index =
        action_index_by_command_at(&processed, "hotkey(\"alt\", \"2\")", 23.608411417);
    let action = &processed[action_index];
    let before = screenshot_before(&processed, action_index);
    let after = screenshot_after(&processed, action_index);

    assert_eq!(action["args"]["keys"], json!(["alt", "2"]));
    assert_approx(action["start_timestamp"].as_f64().unwrap(), 23.557033417);
    assert_approx(action["timestamp"].as_f64().unwrap(), 23.608411417);

    assert_eq!(screenshot_label(before), "tray_085131_frame_0265");
    assert_eq!(screenshot_frame_id(before), 265);
    assert_approx(before["timestamp"].as_f64().unwrap(), 22.985803792);

    assert_eq!(
        screenshot_label(after),
        "tray_085131_action13_expected_after"
    );
    assert_eq!(screenshot_frame_id(after), 279);
    assert_approx(after["timestamp"].as_f64().unwrap(), 23.939278792);
}

#[test]
fn tray_20260517_action84_hotkey_uses_frame_before_modifier_down() {
    let processed = run_reordered_processor(load_processor_fixture(
        "tray_20260517_screenshot_sync_raw_slice.jsonl",
    ));
    let action_index =
        action_index_by_command_at(&processed, "hotkey(\"alt\", \"1\")", 368.955610584);
    let action = &processed[action_index];
    let before = screenshot_before(&processed, action_index);
    let after = screenshot_after(&processed, action_index);

    assert_eq!(action["args"]["keys"], json!(["alt", "1"]));
    assert_approx(action["start_timestamp"].as_f64().unwrap(), 368.493951375);
    assert_approx(action["timestamp"].as_f64().unwrap(), 368.955610584);

    assert_eq!(
        screenshot_label(before),
        "tray_085131_action84_expected_before"
    );
    assert_eq!(screenshot_frame_id(before), 1738);
    assert_approx(before["timestamp"].as_f64().unwrap(), 368.319214917);

    assert_eq!(
        screenshot_label(after),
        "tray_085131_action84_expected_after"
    );
    assert_eq!(screenshot_frame_id(after), 1751);
    assert_approx(after["timestamp"].as_f64().unwrap(), 369.232385875);
}

#[test]
fn keyboard_control_backspace_is_press_not_typewrite_h() {
    let mut events = vec![screenshot(0.10, "before")];
    events.extend(key_press(0.20, "x"));
    events.push(key_down(1.20, "\u{8}"));
    events.push(key_up(1.25, "backspace"));
    events.push(screenshot(1.50, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite", "press"]);
    assert_eq!(actions[0]["args"]["text"], "x");
    assert_eq!(actions[1]["args"]["key"], "backspace");
}

#[test]
fn keyboard_control_del_byte_from_windows_backspace_is_press() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "\u{7f}"),
        key_up(0.24, "backspace"),
        screenshot(0.50, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "backspace");
}

#[test]
fn keyboard_unresolved_native_keycode_is_press_not_typewrite() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "unknown_231"),
        key_up(0.24, "unknown_231"),
        key_down(0.30, "unknown_231"),
        key_up(0.34, "unknown_231"),
        screenshot(0.60, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "unknown_231");
    assert_eq!(actions[0]["args"]["key_code"], 231);
    assert_eq!(actions[0]["args"]["unresolved"], true);
    assert_eq!(actions[0]["args"]["count"], 2);
}

#[test]
fn keyboard_unresolved_windows_key_preserves_virtual_key_diagnostics() {
    let events = vec![
        screenshot(0.10, "before"),
        json!({
            "type": "key_down",
            "timestamp": 0.20,
            "data": {
                "key": "unknown_185",
                "key_code": 185,
                "unresolved": true,
                "windows_virtual_key": "VK_RESERVED_0xB9"
            }
        }),
        json!({
            "type": "key_up",
            "timestamp": 0.24,
            "data": {
                "key": "unknown_185",
                "key_code": 185,
                "hold_duration": 0.04,
                "unresolved": true,
                "windows_virtual_key": "VK_RESERVED_0xB9"
            }
        }),
        screenshot(0.60, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["command"], "press('windows_reserved_key_0xB9')");
    assert_eq!(actions[0]["args"]["key"], "unknown_185");
    assert_eq!(
        actions[0]["args"]["display_key"],
        "windows_reserved_key_0xB9"
    );
    assert_eq!(actions[0]["args"]["key_code"], 185);
    assert_eq!(actions[0]["args"]["unresolved"], true);
    assert_eq!(
        actions[0]["args"]["windows_virtual_key"],
        "VK_RESERVED_0xB9"
    );
}

#[test]
fn keyboard_macos_cg_keycode_179_is_function_not_fast_forward() {
    let events = vec![
        screenshot(0.10, "before"),
        json!({
            "type": "key_down",
            "timestamp": 0.20,
            "data": {
                "key": "fast_forward",
                "key_code": 179,
                "fn_active": false,
                "unresolved": false
            }
        }),
        json!({
            "type": "key_up",
            "timestamp": 0.24,
            "data": {
                "key": "fast_forward",
                "key_code": 179,
                "hold_duration": 0.04,
                "fn_active": false,
                "unresolved": false
            }
        }),
        screenshot(0.60, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "function");
    assert!(actions[0]["args"].get("key_code").is_none());
    assert!(actions[0]["args"].get("unresolved").is_none());
}

#[test]
fn keyboard_macos_unresolved_top_row_keycodes_are_named_presses() {
    let mut events = vec![screenshot(0.10, "before")];
    for (index, code) in [131, 160, 176, 177, 178, 179].iter().enumerate() {
        let timestamp = 0.20 + index as f64 * 0.20;
        events.push(json!({
            "type": "key_down",
            "timestamp": timestamp,
            "data": {
                "key": format!("unknown_{code}"),
                "key_code": code,
                "fn_active": true,
                "unresolved": true
            }
        }));
        events.push(json!({
            "type": "key_up",
            "timestamp": timestamp + 0.04,
            "data": {
                "key": format!("unknown_{code}"),
                "key_code": code,
                "hold_duration": 0.04,
                "fn_active": true,
                "unresolved": true
            }
        }));
    }
    events.push(screenshot(1.60, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(
        actions
            .iter()
            .map(|action| action["args"]["key"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "launchpad",
            "mission_control",
            "dictation",
            "spotlight",
            "do_not_disturb",
            "function"
        ]
    );
    for action in actions {
        assert!(action["args"].get("key_code").is_none());
        assert!(action["args"].get("unresolved").is_none());
    }
}

#[test]
fn keyboard_delete_key_stays_distinct_from_backspace() {
    let events = vec![
        screenshot(0.10, "before"),
        key_down(0.20, "delete"),
        key_up(0.24, "delete"),
        screenshot(0.50, "after"),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "delete");
}

#[test]
fn keyboard_native_special_key_aliases_are_canonical_presses() {
    let mut events = vec![screenshot(0.10, "before")];
    for (index, key) in [
        "volumeup",
        "volumedown",
        "mute",
        "brightnessdown",
        "brightnessup",
        "playpause",
        "missioncontrol",
        "do-not-disturb",
        "function",
        "help",
        "escape",
        "return",
    ]
    .iter()
    .enumerate()
    {
        events.extend(key_press(0.20 + index as f64 * 0.20, key));
    }
    events.push(screenshot(1.80, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(
        event_types(&actions),
        vec![
            "press", "press", "press", "press", "press", "press", "press", "press", "press",
            "press", "press", "press"
        ]
    );
    assert_eq!(actions[0]["args"]["key"], "volume_up");
    assert_eq!(actions[1]["args"]["key"], "volume_down");
    assert_eq!(actions[2]["args"]["key"], "volume_mute");
    assert_eq!(actions[3]["args"]["key"], "brightness_down");
    assert_eq!(actions[4]["args"]["key"], "brightness_up");
    assert_eq!(actions[5]["args"]["key"], "play_pause");
    assert_eq!(actions[6]["args"]["key"], "mission_control");
    assert_eq!(actions[7]["args"]["key"], "do_not_disturb");
    assert_eq!(actions[8]["args"]["key"], "function");
    assert_eq!(actions[9]["args"]["key"], "insert");
    assert_eq!(actions[10]["args"]["key"], "esc");
    assert_eq!(actions[11]["args"]["key"], "enter");
}

#[test]
fn keyboard_control_character_hotkey_uses_human_readable_key() {
    let mut events = vec![screenshot(0.10, "before")];
    events.push(key_down(0.20, "ctrl"));
    events.push(key_down(0.25, "\u{1}"));
    events.push(key_up(0.31, "a"));
    events.push(key_up(0.36, "ctrl"));
    events.push(screenshot(0.60, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "a"]));
}

#[test]
fn keyboard_ctrl_h_control_byte_is_hotkey_h() {
    let mut events = vec![screenshot(0.10, "before")];
    events.push(key_down(0.20, "ctrl"));
    events.push(key_down(0.25, "\u{8}"));
    events.push(key_up(0.31, "h"));
    events.push(key_up(0.36, "ctrl"));
    events.push(screenshot(0.60, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "h"]));
}

#[test]
fn keyboard_ctrl_backspace_del_byte_stays_hotkey_backspace() {
    let mut events = vec![screenshot(0.10, "before")];
    events.push(key_down(0.20, "ctrl"));
    events.push(key_down(0.25, "\u{7f}"));
    events.push(key_up(0.31, "backspace"));
    events.push(key_up(0.36, "ctrl"));
    events.push(screenshot(0.60, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "backspace"]));
}

#[test]
fn keyboard_control_character_hotkey_preserves_shifted_letter() {
    let mut events = vec![screenshot(0.10, "before")];
    events.push(key_down(0.20, "ctrl"));
    events.push(key_down(0.24, "shift"));
    events.push(key_down(0.28, "\u{19}"));
    events.push(key_up(0.33, "y"));
    events.push(key_up(0.37, "shift"));
    events.push(key_up(0.41, "ctrl"));
    events.push(screenshot(0.65, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "Y"]));
}

#[test]
fn keyboard_ctrl_shift_special_key_hotkey_preserves_shift_modifier() {
    let mut events = vec![screenshot(0.10, "before")];
    events.push(key_down(0.20, "ctrl"));
    events.push(key_down(0.24, "shift"));
    events.push(key_down(0.28, "left"));
    events.push(key_up(0.33, "left"));
    events.push(key_up(0.37, "shift"));
    events.push(key_up(0.41, "ctrl"));
    events.push(screenshot(0.65, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["hotkey"]);
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "shift", "left"]));
}

#[test]
fn real_windows_notepad_select_delete_keys_are_human_readable() {
    let events = load_processor_fixture("windows_notepad_select_delete_raw_slice.jsonl");

    let processed = run_reordered_processor(events);
    let actions = actions(&processed);
    let shots = screenshots(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite", "hotkey", "press"]);
    assert_eq!(actions[0]["args"]["text"], "delete this line");
    assert_eq!(actions[1]["args"]["keys"], json!(["ctrl", "a"]));
    assert_eq!(actions[2]["args"]["key"], "backspace");
    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "typewrite",
            "screenshot",
            "hotkey",
            "screenshot",
            "press",
            "screenshot",
        ]
    );
    assert_eq!(
        shots[1]["args"]["image"],
        "windows-notepad-after-delete-line"
    );
    assert_eq!(shots[2]["args"]["image"], "windows-notepad-after-ctrl-a");
    assert_ne!(shots[2]["args"]["image"], "windows-notepad-after-backspace");
    assert_eq!(shots[3]["args"]["image"], "windows-notepad-after-backspace");
}

#[test]
fn mouse_rules_group_multiclicks_flush_on_timeout_and_drag_with_modifiers() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(0.20, 0.10, 0.10, "left"));
    events.extend(click(0.45, 0.10, 0.10, "left"));
    events.push(checkpoint(1.10));
    events.push(key_down(1.20, "ctrl"));
    events.extend(drag(1.30, 0.20, 0.20, 0.32, 0.35, "left"));
    events.push(key_up(1.85, "ctrl"));
    events.extend(click(2.50, 0.50, 0.40, "right"));
    events.push(checkpoint(3.20));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click", "drag", "click"]);
    assert_eq!(actions[0]["args"]["button"], "left");
    assert_eq!(actions[0]["args"]["clicks"], 2);
    assert_eq!(actions[1]["args"]["button"], "left");
    assert_eq!(actions[1]["args"]["modifiers"], json!(["ctrl"]));
    assert_eq!(actions[2]["args"]["button"], "right");
    assert_eq!(actions[2]["args"]["clicks"], 1);
}

#[test]
fn mouse_rules_group_triple_clicks() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(0.20, 0.25, 0.30, "left"));
    events.extend(click(0.45, 0.25, 0.30, "left"));
    events.extend(click(0.70, 0.25, 0.30, "left"));
    events.push(checkpoint(1.40));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click"]);
    assert_eq!(actions[0]["args"]["button"], "left");
    assert_eq!(actions[0]["args"]["clicks"], 3);
    assert_eq!(actions[0]["args"]["modifiers"], json!([]));
    assert_approx(actions[0]["args"]["x"].as_f64().unwrap(), 0.25);
    assert_approx(actions[0]["args"]["y"].as_f64().unwrap(), 0.30);
}

#[test]
fn mouse_rules_keep_shift_modifier_on_drag() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(key_down(0.20, "shift"));
    events.extend(drag(0.35, 0.42, 0.20, 0.18, 0.20, "left"));
    events.push(key_up(1.05, "shift"));
    events.push(checkpoint(1.50));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["drag"]);
    assert_eq!(actions[0]["args"]["button"], "left");
    assert_eq!(actions[0]["args"]["modifiers"], json!(["shift"]));
    assert_approx(actions[0]["args"]["start_x"].as_f64().unwrap(), 0.42);
    assert_approx(actions[0]["args"]["end_x"].as_f64().unwrap(), 0.18);
}

#[test]
fn mouse_drag_ignores_duplicate_down_after_drag_signal() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(mouse_down(0.20, 0.20, 0.20, "left"));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 0.40,
        "data": { "x": 0.42, "y": 0.20, "is_dragging": true }
    }));
    events.push(mouse_down(0.50, 0.42, 0.20, "left"));
    events.push(mouse_up(0.53, 0.42, 0.20, "left"));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 0.58,
        "data": { "x": 0.46, "y": 0.20, "is_dragging": true }
    }));
    events.push(mouse_up(0.70, 0.46, 0.20, "left"));
    events.push(checkpoint(1.20));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["drag"]);
    assert_eq!(actions[0]["args"]["button"], "left");
    assert_approx(actions[0]["args"]["start_x"].as_f64().unwrap(), 0.20);
    assert_approx(actions[0]["args"]["end_x"].as_f64().unwrap(), 0.42);
}

#[test]
fn mouse_rules_suppress_zero_net_drag_with_dragging_moves() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(mouse_down(1.00, 0.4214, 0.4204, "left"));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 1.20,
        "data": { "x": 0.3943, "y": 0.4102, "is_dragging": true }
    }));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 1.80,
        "data": { "x": 0.4208, "y": 0.4204, "is_dragging": true }
    }));
    events.push(mouse_up(2.00, 0.4208, 0.4204, "left"));
    events.push(checkpoint(2.80));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert!(
        actions.is_empty(),
        "zero-net drag should not be emitted as click: {actions:?}"
    );
}

#[test]
fn mouse_rules_keep_shaky_click_below_zero_net_drag_threshold() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(mouse_down(1.00, 0.20, 0.20, "left"));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 1.10,
        "data": { "x": 0.21, "y": 0.20, "is_dragging": true }
    }));
    events.push(mouse_up(1.20, 0.2005, 0.20, "left"));
    events.push(checkpoint(1.80));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click"]);
}

#[test]
fn mouse_rules_preserve_display_id_without_global_coordinates() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(json!({
        "type": "mouse_down",
        "timestamp": 0.20,
        "data": { "x": 0.10, "y": 0.20, "button": "left", "display_id": 2 }
    }));
    events.push(json!({
        "type": "mouse_up",
        "timestamp": 0.25,
        "data": { "x": 0.10, "y": 0.20, "button": "left", "display_id": 2 }
    }));
    events.push(checkpoint(0.90));
    events.push(json!({
        "type": "mouse_down",
        "timestamp": 1.00,
        "data": { "x": 0.30, "y": 0.30, "button": "left", "display_id": 3 }
    }));
    events.push(json!({
        "type": "mouse_move",
        "timestamp": 1.20,
        "data": { "x": 0.45, "y": 0.30, "is_dragging": true, "display_id": 3 }
    }));
    events.push(json!({
        "type": "mouse_up",
        "timestamp": 1.45,
        "data": { "x": 0.45, "y": 0.30, "button": "left", "display_id": 3 }
    }));
    events.push(json!({
        "type": "mouse_scroll",
        "timestamp": 1.80,
        "data": { "x": 0.60, "y": 0.70, "clicks": -1, "display_id": 4 }
    }));
    events.push(json!({
        "type": "mouse_scroll",
        "timestamp": 1.90,
        "data": { "x": 0.60, "y": 0.70, "clicks": -2, "display_id": 4 }
    }));
    events.push(checkpoint(2.30));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click", "drag", "scroll"]);
    assert_eq!(actions[0]["args"]["display_id"], 2);
    assert_eq!(actions[1]["args"]["display_id"], 3);
    assert_eq!(actions[2]["args"]["display_id"], 4);
    for action in actions {
        let args = action["args"].as_object().expect("action args");
        assert!(args.get("global_x").is_none());
        assert!(args.get("global_y").is_none());
        assert!(args.get("screen_x").is_none());
        assert!(args.get("screen_y").is_none());
    }
}

#[test]
fn mouse_click_timeout_flush_does_not_consume_following_key() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(0.20, 0.10, 0.10, "left"));
    events.extend(key_press(0.90, "w"));
    events.push(screenshot(1.20, "after"));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click", "typewrite"]);
    assert_eq!(actions[1]["args"]["text"], "w");
}

#[test]
fn pending_click_flushes_before_key_action_inside_multiclick_window() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot(1.20, "after_click"));
    events.extend(key_press(1.30, "enter"));
    events.push(screenshot(1.45, "after_enter"));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["click", "press"]);
    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "click", "screenshot", "press", "screenshot"]
    );
    assert_eq!(actions[1]["args"]["key"], "enter");
    assert_eq!(shot_labels, vec!["start", "after_click", "after_enter"]);
}

#[test]
fn pending_press_flushes_before_next_typed_key_visual_context() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "backspace"));
    events.push(screenshot(1.08, "after_backspace"));
    events.extend(key_press(1.20, "h"));
    events.push(screenshot(1.45, "after_h"));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["press", "typewrite"]);
    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "press",
            "screenshot",
            "typewrite",
            "screenshot"
        ]
    );
    assert_eq!(actions[0]["args"]["key"], "backspace");
    assert_eq!(actions[1]["args"]["text"], "h");
    assert_eq!(shot_labels, vec!["start", "after_backspace", "after_h"]);
}

#[test]
fn action_screenshot_prefers_first_frame_after_refresh_target() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(key_press(1.00, "enter"));
    events.push(screenshot_image(1.15, BLACK));
    events.push(screenshot_image(1.31, WHITE));
    events.extend(key_press(1.70, "tab"));
    events.push(screenshot_image(1.95, WHITE));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["press", "press"]);
    assert_eq!(actions[0]["args"]["key"], "enter");
    assert_eq!(actions[1]["args"]["key"], "tab");
    assert_eq!(shot_timestamps.len(), 3);
    assert_approx(shot_timestamps[0], 0.10);
    assert_approx(shot_timestamps[1], 1.31);
    assert_approx(shot_timestamps[2], 1.95);
}

#[test]
fn stale_action_screenshot_prefers_first_frame_after_refresh_target() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(key_press(1.00, "enter"));
    events.push(screenshot_image(1.15, BLACK));
    events.push(screenshot_image(1.31, WHITE));
    events.push(screenshot_image(1.50, WHITE));
    events.push(screenshot_image(3.70, WHITE));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "enter");
    assert_eq!(shot_timestamps.len(), 2);
    assert_approx(shot_timestamps[0], 0.10);
    assert_approx(shot_timestamps[1], 1.31);
}

#[test]
fn action_screenshot_keeps_frame_that_is_already_close_to_refresh_target() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(key_press(1.00, "enter"));
    events.push(screenshot(1.19, "close_before_refresh"));
    events.push(screenshot(1.32, "first_after_refresh"));
    events.push(screenshot(3.70, "stale_flush_trigger"));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["press"]);
    assert_eq!(actions[0]["args"]["key"], "enter");
    assert_eq!(shot_labels, vec!["start", "close_before_refresh"]);
}

#[test]
fn pending_click_flushed_by_screenshot_timeout_keeps_next_click_context() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(1.70, BLACK));
    events.push(screenshot_image(3.80, WHITE));
    events.push(screenshot_image(7.80, WHITE));
    events.extend(click(8.00, 0.30, 0.30, "left"));
    events.push(screenshot_image(8.70, WHITE));
    events.push(checkpoint(9.50));

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&actions(&processed)),
        vec!["click", "sleep", "click"]
    );
    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "click",
            "screenshot",
            "sleep",
            "screenshot",
            "click",
            "screenshot"
        ]
    );
    assert_eq!(shot_timestamps, vec![0.10, 3.80, 7.80, 8.70]);
}

#[test]
fn pending_click_uses_delayed_visual_frame_before_next_action() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(2.40, BLACK));
    events.push(screenshot_image(3.20, WHITE));
    events.extend(click(3.48, 0.30, 0.30, "left"));
    events.push(screenshot_image(3.75, WHITE));
    events.push(checkpoint(4.20));

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions(&processed)), vec!["click", "click"]);
    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "click", "screenshot", "click", "screenshot"]
    );
    assert_eq!(shot_timestamps, vec![0.10, 3.20, 3.75]);
}

#[test]
fn pending_click_uses_first_delayed_visual_change_before_next_action() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(2.00, WHITE));
    events.push(screenshot_image(3.20, WHITE));
    events.extend(click(3.48, 0.30, 0.30, "left"));
    events.push(screenshot_image(3.75, WHITE));
    events.push(checkpoint(4.20));

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions(&processed)), vec!["click", "click"]);
    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "click", "screenshot", "click", "screenshot"]
    );
    assert_eq!(shot_timestamps, vec![0.10, 2.00, 3.75]);
}

#[test]
fn enter_press_uses_first_delayed_visual_change_before_next_action() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(key_press(1.00, "enter"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(1.40, BLACK));
    events.push(screenshot_image(2.60, WHITE));
    events.extend(key_press(3.80, "backspace"));
    events.push(screenshot_image(4.10, WHITE));

    let processed = run_processor(events);
    let enter_index = processed
        .iter()
        .position(|event| event.get("type").and_then(Value::as_str) == Some("press"))
        .expect("find enter press action");
    let after = screenshot_after(&processed, enter_index);

    assert_eq!(event_types(&actions(&processed)), vec!["press", "press"]);
    assert_approx(after["timestamp"].as_f64().unwrap(), 2.60);
}

#[test]
fn idle_finalized_click_keeps_early_frame_when_visuals_are_stable() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(1.70, BLACK));
    events.push(screenshot_image(3.80, BLACK));

    let processed = run_processor(events);
    let shots = screenshots(&processed);

    assert_eq!(event_types(&actions(&processed)), vec!["click"]);
    assert_eq!(shots.len(), 2);
    assert_approx(shots[1]["timestamp"].as_f64().unwrap(), 1.20);
}

#[test]
fn stale_click_uses_first_delayed_visual_change() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK)];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot_image(1.20, BLACK));
    events.push(screenshot_image(2.00, WHITE));
    events.push(screenshot_image(3.20, WHITE));
    events.push(screenshot_image(3.80, WHITE));

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions(&processed)), vec!["click"]);
    assert_eq!(shot_timestamps, vec![0.10, 2.00]);
}

#[test]
fn double_click_uses_closer_before_frame_and_later_after_frame() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(screenshot(2.50, "old_idle_before_double_click"));
    events.push(mouse_down(3.00, 0.20, 0.20, "left"));
    events.push(screenshot(3.04, "first_down_before_group_end"));
    events.push(mouse_up(3.06, 0.20, 0.20, "left"));
    events.push(screenshot(3.12, "between_clicks"));
    events.push(mouse_down(3.20, 0.20, 0.20, "left"));
    events.push(screenshot(3.24, "second_down_before_group_end"));
    events.push(mouse_up(3.28, 0.20, 0.20, "left"));
    events.push(screenshot(3.42, "early_after_double_click"));
    events.push(screenshot(3.62, "settled_after_double_click"));
    events.push(screenshot(3.88, "late_before_next_click"));
    events.extend(click(4.00, 0.40, 0.40, "left"));
    events.push(screenshot(4.30, "after_next_click"));

    let processed = run_processor(events);
    let double_click_index = action_index_by_command_at(
        &processed,
        "click(x=0.2000, y=0.2000, clicks=2, button='left')",
        3.28,
    );
    let double_click = &processed[double_click_index];
    let before = screenshot_before(&processed, double_click_index);
    let after = screenshot_after(&processed, double_click_index);

    assert_eq!(
        event_types(&actions(&processed)),
        vec!["sleep", "click", "click"]
    );
    assert_eq!(double_click["args"]["clicks"], 2);
    assert_eq!(screenshot_label(before), "second_down_before_group_end");
    assert_approx(before["timestamp"].as_f64().unwrap(), 3.24);
    assert_eq!(screenshot_label(after), "settled_after_double_click");
    assert_approx(after["timestamp"].as_f64().unwrap(), 3.62);
}

#[test]
fn click_screenshot_sync_uses_settled_frame_capped_by_next_action() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(screenshot(2.50, "old_idle_before_click"));
    events.push(mouse_down(3.00, 0.30, 0.30, "left"));
    events.push(screenshot(3.04, "during_click_before_up"));
    events.push(mouse_up(3.08, 0.30, 0.30, "left"));
    events.push(screenshot(3.12, "early_after_click"));
    events.push(screenshot(3.28, "settled_before_next_guard"));
    events.push(screenshot(3.36, "too_close_to_next_action"));
    events.extend(click(3.45, 0.50, 0.50, "left"));
    events.push(screenshot(3.80, "after_next_click"));

    let processed = run_processor(events);
    let click_index = action_index_by_command_at(
        &processed,
        "click(x=0.3000, y=0.3000, clicks=1, button='left')",
        3.08,
    );
    let before = screenshot_before(&processed, click_index);
    let after = screenshot_after(&processed, click_index);

    assert_eq!(
        event_types(&actions(&processed)),
        vec!["sleep", "click", "click"]
    );
    assert_eq!(screenshot_label(before), "during_click_before_up");
    assert_eq!(screenshot_label(after), "settled_before_next_guard");
    assert_approx(after["timestamp"].as_f64().unwrap(), 3.28);
}

#[test]
fn settled_click_frame_does_not_suppress_next_pre_action_anchor() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot(1.40, "settled_after_first_click"));
    events.push(screenshot(3.70, "close_before_second_click"));
    events.extend(click(3.85, 0.40, 0.40, "left"));
    events.push(screenshot(4.25, "after_second_click"));

    let processed = run_processor(events);
    let second_click_index = action_index_by_command_at(
        &processed,
        "click(x=0.4000, y=0.4000, clicks=1, button='left')",
        3.90,
    );
    let before = screenshot_before(&processed, second_click_index);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&actions(&processed)),
        vec!["click", "sleep", "click"]
    );
    assert_eq!(screenshot_label(before), "close_before_second_click");
    assert_eq!(
        shot_labels,
        vec![
            "start",
            "settled_after_first_click",
            "close_before_second_click",
            "after_second_click"
        ]
    );
}

#[test]
fn idle_visual_activity_emits_sleep_and_snapshots_on_5_then_10_second_cadence() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let events = vec![
        screenshot_image(0.10, BLACK),
        screenshot_image(4.90, WHITE),
        screenshot_image(5.20, WHITE),
        screenshot_image(10.20, BLACK),
        screenshot_image(15.30, BLACK),
    ];

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();
    let sleep_events = actions(&processed)
        .into_iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("sleep"))
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "sleep", "screenshot", "sleep", "screenshot"]
    );
    assert_eq!(shot_timestamps, vec![0.10, 5.20, 15.30]);
    assert_eq!(sleep_events.len(), 2);
    assert_eq!(sleep_events[0]["args"]["duration"], 5);
    assert_eq!(sleep_events[1]["args"]["duration"], 10);
}

#[test]
fn idle_visual_activity_skips_stable_screenshots() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";

    let processed = run_processor(vec![
        screenshot_image(0.10, BLACK),
        screenshot_image(5.20, BLACK),
        screenshot_image(15.30, BLACK),
    ]);

    assert_eq!(event_types(&processed), vec!["screenshot"]);
    assert_eq!(screenshots(&processed).len(), 1);
}

#[test]
fn idle_visual_activity_does_not_steal_later_action_screenshot() {
    const BLACK: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADElEQVR4nGNgGB4AAADIAAGtQHYiAAAAAElFTkSuQmCC";
    const WHITE: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC";

    let mut events = vec![screenshot_image(0.10, BLACK), screenshot_image(5.20, WHITE)];
    events.extend(key_press(7.00, "enter"));
    events.push(screenshot_image(7.30, BLACK));

    let processed = run_processor(events);
    let shot_timestamps = screenshots(&processed)
        .iter()
        .map(|event| event["timestamp"].as_f64().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "sleep", "screenshot", "press", "screenshot"]
    );
    assert_eq!(event_types(&actions(&processed)), vec!["sleep", "press"]);
    assert_eq!(shot_timestamps, vec![0.10, 5.20, 7.30]);
}

#[test]
fn scroll_rules_aggregate_by_time_and_direction() {
    let events = vec![
        screenshot(0.10, "start"),
        scroll(0.20, -1),
        scroll(0.30, -2),
        scroll(0.45, 1),
        scroll(0.60, 2),
        scroll(1.00, 4),
        checkpoint(1.50),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["scroll", "scroll"]);
    assert_eq!(actions[0]["args"]["clicks"], -3);
    assert_eq!(actions[1]["args"]["clicks"], 7);
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 0.20);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 0.30);
    assert_approx(actions[1]["start_timestamp"].as_f64().unwrap(), 0.45);
    assert_approx(actions[1]["timestamp"].as_f64().unwrap(), 1.00);
}

#[test]
fn scroll_rules_keep_long_idle_gaps_as_separate_actions() {
    let events = vec![
        screenshot(0.10, "start"),
        scroll(1.00, 1),
        scroll(1.70, 2),
        scroll(2.51, 3),
        checkpoint(3.00),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["scroll", "scroll"]);
    assert_eq!(actions[0]["args"]["clicks"], 3);
    assert_eq!(actions[1]["args"]["clicks"], 3);
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.70);
    assert_approx(actions[1]["start_timestamp"].as_f64().unwrap(), 2.51);
    assert_approx(actions[1]["timestamp"].as_f64().unwrap(), 2.51);
}

#[test]
fn scroll_rules_do_not_split_on_screenshots_or_mouse_moves() {
    let events = vec![
        screenshot(0.10, "start"),
        scroll(1.00, 1),
        screenshot(1.20, "during_scroll"),
        json!({
            "type": "mouse_move",
            "timestamp": 1.35,
            "data": { "x": 0.5, "y": 0.6 }
        }),
        scroll(1.55, 2),
        screenshot(1.90, "after_scroll"),
        checkpoint(2.40),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shots = screenshots(&processed);

    assert_eq!(event_types(&actions), vec!["scroll"]);
    assert_eq!(actions[0]["args"]["clicks"], 3);
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.55);
    assert_eq!(shots.last().map(screenshot_label), Some("after_scroll"));
}

#[test]
fn scroll_rules_split_on_display_change_direction_reversal_and_clicks() {
    let mut events = vec![screenshot(0.10, "start")];
    events.push(scroll_on_display(1.00, 1, 111));
    events.push(scroll_on_display(1.10, 2, 222));
    events.push(scroll_on_display(1.20, -3, 222));
    events.extend(click(1.40, 0.30, 0.30, "left"));
    events.push(scroll_on_display(1.55, -4, 222));
    events.push(checkpoint(2.20));

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(
        event_types(&actions),
        vec!["scroll", "scroll", "scroll", "click", "scroll"]
    );
    assert_eq!(actions[0]["args"]["clicks"], 1);
    assert_eq!(actions[1]["args"]["clicks"], 2);
    assert_eq!(actions[2]["args"]["clicks"], -3);
    assert_eq!(actions[4]["args"]["clicks"], -4);
}

#[test]
fn scroll_rules_split_long_continuous_sessions_for_intermediate_state() {
    let events = vec![
        screenshot(0.10, "start"),
        scroll(1.00, 1),
        scroll(1.60, 1),
        scroll(2.20, 1),
        scroll(2.80, 1),
        scroll(3.40, 1),
        checkpoint(4.00),
    ];

    let processed = run_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["scroll", "scroll"]);
    assert_eq!(actions[0]["args"]["clicks"], 4);
    assert_eq!(actions[1]["args"]["clicks"], 1);
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 2.80);
    assert_approx(actions[1]["start_timestamp"].as_f64().unwrap(), 3.40);
    assert_approx(actions[1]["timestamp"].as_f64().unwrap(), 3.40);
}

#[test]
fn scroll_session_fixture_merges_noisy_human_scrolls() {
    let events = load_processor_fixture("scroll_session_raw_slice.jsonl");
    let processed = run_reordered_processor(events);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["scroll", "scroll"]);
    assert_eq!(actions[0]["args"]["clicks"], 9);
    assert_eq!(actions[1]["args"]["clicks"], -5);
    assert_approx(actions[0]["start_timestamp"].as_f64().unwrap(), 1.00);
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.70);
    assert_approx(actions[1]["start_timestamp"].as_f64().unwrap(), 2.80);
    assert_approx(actions[1]["timestamp"].as_f64().unwrap(), 3.10);
}

#[test]
fn screenshot_assignment_prefers_between_actions_and_marks_screenshots_used() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(screenshot(1.08, "early_after_first"));
    events.push(screenshot(1.20, "best_after_first"));
    events.extend(click(2.00, 0.30, 0.30, "left"));
    events.push(screenshot(2.20, "best_after_second"));
    events.push(checkpoint(2.70));

    let processed = run_processor(events);
    let shots = screenshots(&processed);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click", "click"]);
    assert_eq!(shots.len(), 3);
    assert_eq!(shots[0]["args"]["image"], "start");
    assert_eq!(shots[1]["args"]["image"], "best_after_first");
    assert_eq!(shots[2]["args"]["image"], "best_after_second");
}

#[test]
fn reordered_screenshot_before_next_action_is_available_for_previous_action() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(key_down(2.00, "z"));
    events.push(key_up(2.03, "z"));
    events.push(checkpoint(2.10));
    events.push(screenshot(1.99, "arrived_late_before_key"));
    events.push(screenshot(2.35, "after_key"));
    events.push(checkpoint(2.80));

    let processed = run_reordered_processor(events);
    let actions = actions(&processed);
    let shots = screenshots(&processed);

    assert_eq!(event_types(&actions), vec!["click", "typewrite"]);
    assert_eq!(actions[1]["args"]["text"], "z");
    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "click",
            "screenshot",
            "typewrite",
            "screenshot"
        ]
    );
    assert_eq!(shots[1]["args"]["image"], "arrived_late_before_key");
    assert_eq!(shots[2]["args"]["image"], "after_key");
}

#[test]
fn hotkey_slow_modal_transition_uses_later_frame_before_next_action() {
    let mut events = vec![screenshot(0.10, "notepad")];
    events.push(key_down(1.00, "ctrl"));
    events.push(key_down(1.05, "p"));
    events.push(key_up(1.10, "p"));
    events.push(key_up(1.15, "ctrl"));
    events.push(screenshot(1.35, "unchanged_notepad"));
    events.push(screenshot(2.20, "print_dialog"));
    events.push(screenshot(3.80, "print_dialog_later_idle"));
    events.push(key_down(5.00, "enter"));
    events.push(key_up(5.03, "enter"));
    events.push(screenshot(5.40, "after_enter"));
    events.push(checkpoint(5.90));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shots = screenshots(&processed);
    let shot_labels = shots
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(event_types(&actions), vec!["hotkey", "sleep", "press"]);
    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "hotkey",
            "screenshot",
            "sleep",
            "screenshot",
            "press",
            "screenshot"
        ]
    );
    assert_eq!(actions[0]["args"]["keys"], json!(["ctrl", "p"]));
    assert_eq!(actions[2]["args"]["key"], "enter");
    assert_eq!(
        shot_labels,
        vec![
            "notepad",
            "print_dialog",
            "print_dialog_later_idle",
            "after_enter"
        ]
    );
    assert!(!shot_labels.contains(&"unchanged_notepad".to_string()));
}

#[test]
fn reordered_processor_keeps_concurrent_callbacks_in_timestamp_order() {
    let output = tmp_jsonl("processor_rules_concurrent_reorder");
    let writer = StreamingJsonlinesWriter::new(&output, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let processor = Arc::new(TimestampReorderedProcessor::with_limits(
        RealTimeEventProcessor::new(Some(writer), None),
        1000.0,
        1024,
    ));
    let text = "concurrent";
    let barrier = Arc::new(Barrier::new(text.len()));
    let mut handles = Vec::new();

    for (index, key) in text.chars().enumerate() {
        let processor = Arc::clone(&processor);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            let timestamp = 1.0 + (index as f64 * 0.1);
            processor
                .add_event(key_down(timestamp, &key.to_string()))
                .expect("process key down");
            processor
                .add_event(key_up(timestamp + 0.03, &key.to_string()))
                .expect("process key up");
        }));
    }

    for handle in handles {
        handle.join().expect("callback thread joined");
    }
    processor.stop().expect("stop processor");

    let processed = StreamingJsonlinesWriter::read_jsonl(&output).expect("read preprocessed");
    let _ = std::fs::remove_file(&output);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["typewrite"]);
    assert_eq!(actions[0]["args"]["text"], text);
}

#[test]
fn reordered_processor_holds_late_screenshots_for_action_context() {
    let mut events = vec![screenshot(0.10, "initial")];
    events.extend(click(3.00, 0.20, 0.20, "left"));
    events.extend(key_press(4.00, "enter"));
    events.push(screenshot(2.80, "before_click_arrived_late"));
    events.push(screenshot(3.25, "after_click_arrived_late"));
    events.push(screenshot(4.30, "after_enter_arrived_late"));

    let processed = run_reordered_processor(events);

    assert_eq!(
        event_types(&processed),
        vec![
            "screenshot",
            "sleep",
            "screenshot",
            "click",
            "screenshot",
            "press",
            "screenshot"
        ]
    );
    let shots = screenshots(&processed);
    let shot_labels = shots
        .iter()
        .map(|event| screenshot_label(event))
        .collect::<Vec<_>>();
    assert_eq!(
        shot_labels,
        vec![
            "initial",
            "before_click_arrived_late",
            "after_click_arrived_late",
            "after_enter_arrived_late"
        ]
    );
}

#[test]
fn finite_next_action_boundary_does_not_use_later_screenshot() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.extend(click(2.00, 0.30, 0.30, "left"));
    events.push(screenshot(2.10, "after_second_but_first_available"));
    events.push(checkpoint(2.70));

    let processed = run_processor(events);
    let shots = screenshots(&processed);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click", "click"]);
    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "click", "click", "screenshot"]
    );
    assert_eq!(shots.len(), 2);
    assert_eq!(
        shots[1]["args"]["image"],
        "after_second_but_first_available"
    );
    assert_approx(actions[0]["timestamp"].as_f64().unwrap(), 1.05);
}

#[test]
fn pending_drag_finalizes_at_next_raw_input_boundary() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(drag(1.00, 0.20, 0.20, 0.45, 0.45, "left"));
    events.push(screenshot(1.55, "after_drag_early"));
    events.push(screenshot(1.80, "after_drag_best_before_click"));
    events.push(screenshot(1.92, "after_drag_too_close_to_click"));
    events.extend(click(2.00, 0.55, 0.55, "left"));
    for index in 0..60 {
        events.push(screenshot(
            2.10 + (index as f64 * 0.02),
            &format!("post_click_{index:02}"),
        ));
    }
    events.push(checkpoint(4.00));

    let processed = run_processor(events);
    let processed_types = event_types(&processed);
    let drag_index = processed_types
        .iter()
        .position(|event_type| event_type == "drag")
        .expect("drag action emitted");

    assert_eq!(processed[drag_index + 1]["type"], "screenshot");
    assert_eq!(
        processed[drag_index + 1]["args"]["image"],
        "after_drag_best_before_click"
    );
    assert!(
        processed[drag_index + 1]["timestamp"].as_f64().unwrap() < 2.00,
        "drag after-screenshot must remain before the next click starts"
    );
    assert_eq!(event_types(&actions(&processed)), vec!["drag", "click"]);
}

#[test]
fn stale_pending_action_is_finalized_by_late_screenshot() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(checkpoint(1.60));
    events.push(screenshot(3.70, "stale_finalizer"));

    let processed = run_processor(events);
    let shots = screenshots(&processed);
    let actions = actions(&processed);

    assert_eq!(event_types(&actions), vec!["click"]);
    assert_eq!(shots.len(), 2);
    assert_eq!(shots[1]["args"]["image"], "stale_finalizer");
}

#[test]
fn first_action_short_idle_does_not_insert_pre_action_screenshot() {
    let mut events = vec![
        screenshot(0.10, "start"),
        screenshot(1.90, "older_idle"),
        screenshot(2.08, "before_action"),
    ];
    events.extend(key_press(2.20, "h"));
    events.push(screenshot(2.23, "early_after_action"));
    events.push(screenshot(2.50, "after_action"));
    events.push(checkpoint(3.00));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "typewrite", "screenshot"]
    );
    assert_eq!(event_types(&actions), vec!["typewrite"]);
    assert_eq!(shot_labels, vec!["start", "after_action"]);
}

#[test]
fn sleep_insertion_uses_prior_screenshot_without_reusing_action_screenshot() {
    let mut events = vec![
        screenshot(4.95, "start"),
        screenshot(9.50, "before_first_action"),
    ];
    events.extend(click(10.00, 0.25, 0.25, "left"));
    events.push(screenshot(18.93, "after_first_action"));
    events.push(screenshot(21.50, "before_second_action"));
    events.extend(click(22.00, 0.35, 0.35, "left"));
    events.push(screenshot(22.50, "after_second_action"));
    events.push(checkpoint(30.00));
    events.push(screenshot(30.40, "late_frame"));

    let processed = run_processor(events);
    let actions = actions(&processed);
    let sleep_events = actions
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("sleep"))
        .collect::<Vec<_>>();
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(sleep_events.len(), 2);
    assert_approx(sleep_events[0]["timestamp"].as_f64().unwrap(), 4.96);
    assert_eq!(sleep_events[0]["args"]["duration"], 5);
    assert_approx(sleep_events[1]["timestamp"].as_f64().unwrap(), 18.94);
    assert_eq!(sleep_events[1]["args"]["duration"], 3);
    assert_eq!(
        shot_labels,
        vec![
            "start",
            "before_first_action",
            "after_first_action",
            "before_second_action",
            "after_second_action"
        ]
    );
}

#[test]
fn screenshot_buffer_pressure_keeps_recent_sleep_and_action_frames() {
    let mut events = vec![screenshot(0.10, "start")];
    for idx in 0..65 {
        events.push(screenshot(0.20 + idx as f64 * 0.10, &format!("idle-{idx}")));
    }
    events.extend(click(7.00, 0.25, 0.25, "left"));
    events.push(screenshot(7.60, "after_click"));

    let processed = run_processor(events);
    let shot_labels = screenshots(&processed)
        .iter()
        .map(|event| event["args"]["image"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        event_types(&processed),
        vec!["screenshot", "sleep", "screenshot", "click", "screenshot"]
    );
    assert_eq!(shot_labels, vec!["start", "idle-64", "after_click"]);
}

#[test]
fn a11y_events_skip_near_actions_and_drop_temporary_hash_before_write() {
    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(checkpoint(1.70));
    events.push(a11y_screenshot(0.70, 0.80, "skip_near_click"));
    events.push(a11y_screenshot(3.00, 3.10, "keep_idle"));

    let (_processed, a11y) = run_processor_with_a11y(events);

    assert_eq!(a11y.len(), 1);
    assert_eq!(a11y[0]["data"]["image"], "keep_idle");
    assert!(a11y[0].get("event_screenshot_hash").is_none());
}

#[test]
fn a11y_hash_acceptor_runs_only_after_a11y_write() {
    let preprocessed_path = tmp_jsonl("processor_rules_preprocessed");
    let a11y_path = tmp_jsonl("processor_rules_a11y");
    let preprocessed_writer = StreamingJsonlinesWriter::new(&preprocessed_path, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let a11y_writer = StreamingJsonlinesWriter::new(&a11y_path, 1000, false)
        .open()
        .expect("open a11y writer");
    let accepted_hashes = Arc::new(Mutex::new(Vec::new()));
    let accepted_hashes_for_callback = accepted_hashes.clone();
    let processor = RealTimeEventProcessor::new_with_a11y_hash_acceptor(
        Some(preprocessed_writer),
        Some(a11y_writer),
        Some(Arc::new(move |hash| {
            accepted_hashes_for_callback.lock().unwrap().push(hash);
        })),
    );

    let mut events = vec![screenshot(0.10, "start")];
    events.extend(click(1.00, 0.20, 0.20, "left"));
    events.push(checkpoint(1.70));
    events.push(a11y_screenshot(0.70, 0.80, "skip_near_click"));
    events.push(a11y_screenshot(3.00, 3.10, "keep_idle"));
    for event in events {
        processor.add_event(event).expect("process event");
    }
    processor.stop().expect("stop processor");

    let a11y = StreamingJsonlinesWriter::read_jsonl(&a11y_path).expect("read a11y");
    let _ = std::fs::remove_file(&preprocessed_path);
    let _ = std::fs::remove_file(&a11y_path);

    assert_eq!(a11y.len(), 1);
    assert_eq!(
        accepted_hashes.lock().unwrap().as_slice(),
        ["temporary-keep_idle"]
    );
}
