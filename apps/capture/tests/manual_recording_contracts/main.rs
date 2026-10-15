use kortix_backend::{
    event_reorder::TimestampReorderedProcessor, processor::RealTimeEventProcessor,
    streaming_writer::StreamingJsonlinesWriter,
};
use serde_json::{json, Value};
use std::{
    env,
    path::{Path, PathBuf},
};
use uuid::Uuid;

// Manual raw JSONL recordings for these tests should be placed under:
// tests/manual_recording_contracts/raw_data/
//
// That folder is ignored by git. Keep local recorder captures there while
// iterating, then point MANUAL_BASIC_RAW_JSONL at the captured *_raw.jsonl file.

fn tmp_jsonl(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kortix_{name}_{}.jsonl", Uuid::new_v4()))
}

fn read_jsonl(path: impl AsRef<Path>) -> Vec<Value> {
    StreamingJsonlinesWriter::read_jsonl(path).expect("read jsonl")
}

fn process_raw_events_to_path(raw: Vec<Value>, output_path: &Path) -> Vec<Value> {
    let writer = StreamingJsonlinesWriter::new(output_path, 1000, true)
        .open()
        .expect("open preprocessed writer");
    let processor =
        TimestampReorderedProcessor::new(RealTimeEventProcessor::new(Some(writer), None));

    for event in raw {
        processor.add_event(event).expect("process event");
    }
    processor.stop().expect("stop processor");

    read_jsonl(output_path)
}

fn process_raw_to_path(raw_path: &Path, output_path: &Path) -> Vec<Value> {
    if raw_path == output_path {
        panic!(
            "manual contract output would overwrite input: {}",
            raw_path.display()
        );
    }

    let raw = read_jsonl(raw_path);
    process_raw_events_to_path(raw, output_path)
}

fn process_raw_events_temp(raw: Vec<Value>) -> Vec<Value> {
    let output = tmp_jsonl("manual_recording_contracts_preprocessed");
    let processed = process_raw_events_to_path(raw, &output);
    let _ = std::fs::remove_file(output);
    processed
}

fn event_type(event: &Value) -> &str {
    event.get("type").and_then(Value::as_str).unwrap_or("")
}

fn actions(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|event| event_type(event) != "screenshot")
        .collect()
}

fn screenshots(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|event| event_type(event) == "screenshot")
        .collect()
}

fn action_types(events: &[&Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| event_type(event).to_string())
        .collect()
}

fn screenshot_labels(events: &[&Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            event["args"]["image"]
                .as_str()
                .unwrap_or("<missing image>")
                .to_string()
        })
        .collect()
}

fn sleep_duration(event: &Value) -> Option<i64> {
    event["args"]["duration"].as_i64()
}

fn timestamp(event: &Value) -> f64 {
    event["timestamp"]
        .as_f64()
        .expect("event is missing numeric timestamp")
}

fn start_timestamp(event: &Value) -> f64 {
    event["start_timestamp"]
        .as_f64()
        .unwrap_or_else(|| timestamp(event))
}

fn assert_timestamp(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() < 0.000_001,
        "{label}: expected timestamp {expected:.6}, got {actual:.6}"
    );
}

fn count_events(events: &[Value], typ: &str) -> usize {
    events
        .iter()
        .filter(|event| event_type(event) == typ)
        .count()
}

fn is_valid_basic_sleep(event: &Value) -> bool {
    event_type(event) == "sleep"
        && sleep_duration(event)
            .map(|duration| (5..=7).contains(&duration))
            .unwrap_or(false)
}

fn is_enter_press(event: &Value) -> bool {
    event_type(event) == "press"
        && event["args"]["key"]
            .as_str()
            .map(|key| matches!(key.to_lowercase().as_str(), "enter" | "return"))
            .unwrap_or(false)
}

fn has_screenshot_before_and_after(events: &[Value], index: usize) -> bool {
    events[..index]
        .iter()
        .rev()
        .any(|event| event_type(event) == "screenshot")
        && events[index + 1..]
            .iter()
            .any(|event| event_type(event) == "screenshot")
}

fn screenshot_action_screenshot_triples(events: &[Value]) -> usize {
    events
        .iter()
        .enumerate()
        .filter(|(index, event)| {
            !matches!(
                event_type(event),
                "" | "screenshot" | "a11y+screenshot" | "sleep"
            ) && has_screenshot_before_and_after(events, *index)
        })
        .count()
}

fn find_basic_sequence(events: &[Value]) -> Option<[usize; 4]> {
    let mut click_idx = None;
    let mut sleep_idx = None;
    let mut drag_idx = None;

    for (idx, event) in events.iter().enumerate() {
        match (click_idx, sleep_idx, drag_idx, event_type(event)) {
            (None, _, _, "click") => click_idx = Some(idx),
            (Some(_), None, _, _) if is_valid_basic_sleep(event) => sleep_idx = Some(idx),
            (Some(_), Some(_), None, "drag") => drag_idx = Some(idx),
            (Some(click), Some(sleep), Some(drag), _) if is_enter_press(event) => {
                return Some([click, sleep, drag, idx]);
            }
            _ => {}
        }
    }

    None
}

fn assert_basic_recording_contract(processed: &[Value]) -> [usize; 4] {
    assert!(!processed.is_empty(), "processed output is empty");
    assert!(
        screenshots(processed).len() >= 4,
        "expected at least four processed screenshots for basic action synchronization"
    );
    assert!(
        processed.iter().any(|event| event_type(event) == "click"),
        "no click event found"
    );
    assert_eq!(
        processed
            .iter()
            .filter(|event| event_type(event) == "drag")
            .count(),
        1,
        "expected exactly one drag event"
    );
    assert!(
        processed.iter().any(is_enter_press),
        "no enter/return press event found"
    );
    assert!(
        processed.iter().any(is_valid_basic_sleep),
        "no sleep event with duration in the 5..=7 second range found"
    );

    let sequence = find_basic_sequence(processed)
        .expect("expected ordered basic sequence: click -> sleep(5..=7s) -> drag -> enter");
    for index in [sequence[0], sequence[2], sequence[3]] {
        assert!(
            has_screenshot_before_and_after(processed, index),
            "event at processed index {index} is missing before/after screenshot context"
        );
    }
    assert!(
        screenshot_action_screenshot_triples(processed) >= 3,
        "expected at least three screenshot/action/screenshot triples"
    );

    sequence
}

fn assert_confirmed_manual_basic_raw_contract(raw: &[Value]) {
    assert_eq!(raw.len(), 660, "confirmed raw event count changed");
    assert_eq!(count_events(raw, "screenshot"), 135);
    assert_eq!(count_events(raw, "a11y+screenshot"), 1);
    assert_eq!(count_events(raw, "mouse_move"), 339);
    assert_eq!(count_events(raw, "key_down"), 35);
    assert_eq!(count_events(raw, "key_up"), 35);
    assert_eq!(count_events(raw, "mouse_down"), 2);
    assert_eq!(count_events(raw, "mouse_up"), 2);
    assert_eq!(count_events(raw, "mouse_scroll"), 111);

    let key_events = raw
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            matches!(event_type(event), "key_down" | "key_up")
                && event["data"]["key"]
                    .as_str()
                    .map(|key| key == "ctrl" || key == "space")
                    .unwrap_or(false)
                && (6.0..=6.5).contains(&timestamp(event))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        key_events.len(),
        4,
        "expected exactly ctrl down, space down, ctrl up, space up near 6.2s"
    );

    let expected = [
        (203, "key_down", "ctrl", 6.155_355_708, json!([])),
        (205, "key_down", "space", 6.239_409_292, json!(["ctrl"])),
        (206, "key_up", "ctrl", 6.339_634_333, json!([])),
        (207, "key_up", "space", 6.339_660_292, json!([])),
    ];
    for ((actual_index, event), (expected_index, typ, key, ts, active_modifiers)) in
        key_events.iter().zip(expected)
    {
        assert_eq!(*actual_index, expected_index);
        assert_eq!(event_type(event), typ);
        assert_eq!(event["data"]["key"], key);
        assert_timestamp(timestamp(event), ts, key);
        assert_eq!(event["data"]["active_modifiers"], active_modifiers);
    }
}

fn assert_confirmed_manual_basic_capture_contract(processed: &[Value]) {
    /*
    Confirmed local macOS manual capture from the Rust native recorder:
    - Initial idle while the app is visible, then type h and backspace.
    - Click in the visible app, type "hello worl", and press backspace twice.
    - Press ctrl+space, backspace, then type "world " and "! " as two actions.
    - Switch/navigate with command+tab and alt+number hotkeys.
    - Scroll twice, press alt+4, click, and press Enter to stop.

    This contract intentionally uses the captured raw data as a stable
    regression case. It validates the exact processed action sequence,
    timestamps, and screenshot/action/screenshot neighbors that were manually
    reviewed as correct.
    */
    assert_eq!(processed.len(), 34, "processed event count changed");
    assert_eq!(screenshots(processed).len(), 17);
    assert_eq!(actions(processed).len(), 17);

    let indexed_actions = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) != "screenshot")
        .collect::<Vec<_>>();
    let action_events = indexed_actions
        .iter()
        .map(|(_, event)| *event)
        .collect::<Vec<_>>();

    assert_eq!(
        action_types(&action_events),
        vec![
            "typewrite",
            "press",
            "click",
            "typewrite",
            "press",
            "hotkey",
            "press",
            "typewrite",
            "typewrite",
            "hotkey",
            "hotkey",
            "hotkey",
            "scroll",
            "scroll",
            "hotkey",
            "click",
            "press"
        ]
    );

    let expected_action_indices = [
        1, 3, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32,
    ];
    assert_eq!(
        indexed_actions
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_action_indices
    );

    let expected_actions = vec![
        (
            "typewrite",
            2.215_375_875,
            2.215_375_875,
            json!({"interval": 0.1, "text": "h"}),
        ),
        (
            "press",
            2.973_280_583,
            2.973_280_583,
            json!({"key": "backspace"}),
        ),
        (
            "click",
            3.780_408_042,
            3.780_390_458,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.3778, "y": 0.6051}),
        ),
        (
            "typewrite",
            5.655_476_458,
            4.150_345_375,
            json!({"interval": 0.1, "text": "hello worl"}),
        ),
        (
            "press",
            6.055_276_25,
            6.055_276_25,
            json!({"count": 2, "key": "backspace"}),
        ),
        (
            "hotkey",
            6.239_409_292,
            6.155_355_708,
            json!({"keys": ["ctrl", " "]}),
        ),
        (
            "press",
            6.510_465_625,
            6.510_465_625,
            json!({"key": "backspace"}),
        ),
        (
            "typewrite",
            7.473_480_625,
            6.622_668_583,
            json!({"interval": 0.1, "text": "world "}),
        ),
        (
            "typewrite",
            7.788_307_208,
            7.650_888_25,
            json!({"interval": 0.1, "text": "! "}),
        ),
        (
            "hotkey",
            8.957_258_667,
            8.897_479_458,
            json!({"keys": ["command", "tab"]}),
        ),
        (
            "hotkey",
            10.328_074_583,
            10.116_108_042,
            json!({"keys": ["alt", "2"]}),
        ),
        (
            "hotkey",
            11.889_049_667,
            11.805_852_292,
            json!({"keys": ["alt", "1"]}),
        ),
        (
            "scroll",
            13.738_764_125,
            13.447_931_208,
            json!({"clicks": -235, "display_id": 1, "x": 0.4975, "y": 0.6421}),
        ),
        (
            "scroll",
            14.705_974_042,
            14.196_660_333,
            json!({"clicks": -975, "display_id": 1, "x": 0.5111, "y": 0.5929}),
        ),
        (
            "hotkey",
            15.039_033_458,
            14.911_011_208,
            json!({"keys": ["alt", "4"]}),
        ),
        (
            "click",
            16.650_760_583,
            16.648_972_25,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.9317, "y": 0.5472}),
        ),
        (
            "press",
            17.041_927_167,
            17.041_927_167,
            json!({"key": "enter"}),
        ),
    ];
    for ((_, event), (typ, ts, start_ts, args)) in indexed_actions.iter().zip(expected_actions) {
        assert_eq!(event_type(event), typ);
        assert_timestamp(timestamp(event), ts, typ);
        assert_timestamp(start_timestamp(event), start_ts, typ);
        assert_eq!(event["args"], args, "unexpected args for {typ}");
    }

    assert!(processed.iter().all(|event| event_type(event) != "sleep"));
    assert!(processed.iter().all(|event| event_type(event) != "drag"));

    let expected_screenshot_indices = [
        0, 2, 4, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33,
    ];
    let expected_screenshot_timestamps = [
        0.040_846_5,
        2.489_032_125,
        3.137_866_833,
        5.730_325_125,
        6.123_306_667,
        6.382_617_208,
        6.515_975_5,
        7.567_309_75,
        8.048_408_458,
        9.223_334_083,
        10.612_482_333,
        12.146_43,
        14.030_671_333,
        14.797_734_583,
        15.310_445_625,
        16.846_558_042,
        17.238_796_333,
    ];
    let indexed_screenshots = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) == "screenshot")
        .collect::<Vec<_>>();
    assert_eq!(
        indexed_screenshots
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_screenshot_indices
    );
    for ((_, screenshot), expected_ts) in indexed_screenshots
        .iter()
        .zip(expected_screenshot_timestamps)
    {
        assert_timestamp(timestamp(screenshot), expected_ts, "screenshot");
    }

    let expected_neighbors = [
        (0, 2),
        (2, 4),
        (4, 7),
        (4, 7),
        (7, 9),
        (9, 11),
        (11, 13),
        (13, 15),
        (15, 17),
        (17, 19),
        (19, 21),
        (21, 23),
        (23, 25),
        (25, 27),
        (27, 29),
        (29, 31),
        (31, 33),
    ];
    for ((action_index, _), (expected_before, expected_after)) in
        indexed_actions.iter().zip(expected_neighbors)
    {
        let before = processed[..*action_index]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, event)| event_type(event) == "screenshot")
            .map(|(index, _)| index);
        let after = processed[*action_index + 1..]
            .iter()
            .enumerate()
            .find(|(_, event)| event_type(event) == "screenshot")
            .map(|(offset, _)| *action_index + 1 + offset);
        assert_eq!(before, Some(expected_before));
        assert_eq!(after, Some(expected_after));
    }

    let mut saw_display_1 = false;
    for screenshot in screenshots(processed) {
        let args = &screenshot["args"];
        assert!(
            args.get("desktop_bounds").is_some(),
            "manual screenshot is missing desktop_bounds metadata"
        );
        let displays = args["displays"]
            .as_array()
            .expect("manual screenshot missing displays array");
        for display in displays {
            match display["display_id"].as_u64() {
                Some(1) => saw_display_1 = true,
                _ => {}
            }
            assert!(
                display.get("normalized_bounds").is_some(),
                "display screenshot is missing normalized_bounds metadata"
            );
        }
    }
    assert!(saw_display_1, "manual screenshots never recorded display 1");
}

fn assert_manual_mouse_clicks_raw_contract(raw: &[Value]) {
    assert_eq!(raw.len(), 12_272, "confirmed mouse raw event count changed");
    assert_eq!(count_events(raw, "screenshot"), 260);
    assert_eq!(count_events(raw, "a11y+screenshot"), 2);
    assert_eq!(count_events(raw, "mouse_move"), 11_970);
    assert_eq!(count_events(raw, "mouse_down"), 17);
    assert_eq!(count_events(raw, "mouse_up"), 17);
    assert_eq!(count_events(raw, "mouse_scroll"), 4);
    assert_eq!(count_events(raw, "key_down"), 1);
    assert_eq!(count_events(raw, "key_up"), 1);

    let button_events = raw
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event_type(event), "mouse_down" | "mouse_up"))
        .collect::<Vec<_>>();
    let expected_button_events = [
        (1208, 4.845_751, "mouse_down", "right", 1, 2, 0.7013, 0.5344),
        (
            1210,
            4.934_744_458,
            "mouse_up",
            "right",
            1,
            2,
            0.7013,
            0.5344,
        ),
        (
            2106,
            7.934_739_667,
            "mouse_down",
            "left",
            1,
            2,
            0.7476,
            0.5635,
        ),
        (2108, 8.030_690_25, "mouse_up", "left", 1, 2, 0.7476, 0.5635),
        (
            4248,
            11.327_054_708,
            "mouse_down",
            "left",
            1,
            1,
            0.1608,
            0.6667,
        ),
        (
            4249,
            11.419_797_792,
            "mouse_up",
            "left",
            1,
            1,
            0.1608,
            0.6667,
        ),
        (
            5071,
            13.141_794_792,
            "mouse_down",
            "left",
            1,
            1,
            0.2216,
            0.9663,
        ),
        (
            5072,
            13.228_814_458,
            "mouse_up",
            "left",
            1,
            1,
            0.2216,
            0.9663,
        ),
        (
            6299,
            15.424_758_292,
            "mouse_down",
            "left",
            1,
            1,
            0.1907,
            0.7134,
        ),
        (
            6731,
            16.331_335_125,
            "mouse_up",
            "left",
            1,
            1,
            0.2121,
            0.9749,
        ),
        (
            8432,
            20.409_844_25,
            "mouse_down",
            "left",
            1,
            1,
            0.0783,
            0.6302,
        ),
        (
            8434,
            20.524_939_583,
            "mouse_up",
            "left",
            1,
            1,
            0.0783,
            0.6302,
        ),
        (
            9183,
            22.546_753_25,
            "mouse_down",
            "middle",
            1,
            1,
            0.0309,
            0.8917,
        ),
        (
            9189,
            23.146_196_958,
            "mouse_up",
            "middle",
            1,
            1,
            0.0309,
            0.8917,
        ),
        (
            9542,
            24.909_956_292,
            "mouse_down",
            "left",
            1,
            1,
            0.0705,
            0.7107,
        ),
        (
            9543,
            25.006_788_375,
            "mouse_up",
            "left",
            1,
            1,
            0.0705,
            0.7107,
        ),
        (
            9545,
            25.059_297_958,
            "mouse_down",
            "left",
            2,
            1,
            0.0705,
            0.7107,
        ),
        (
            9546,
            25.140_168_542,
            "mouse_up",
            "left",
            2,
            1,
            0.0705,
            0.7107,
        ),
        (
            10334,
            26.538_859_667,
            "mouse_down",
            "left",
            1,
            1,
            0.071,
            0.5467,
        ),
        (
            10337,
            26.625_184_333,
            "mouse_up",
            "left",
            1,
            1,
            0.071,
            0.5465,
        ),
        (
            10338,
            26.689_794_792,
            "mouse_down",
            "left",
            2,
            1,
            0.071,
            0.5465,
        ),
        (10340, 26.760_43, "mouse_up", "left", 2, 1, 0.071, 0.5465),
        (
            10342,
            26.837_748_708,
            "mouse_down",
            "left",
            3,
            1,
            0.071,
            0.5465,
        ),
        (
            10343,
            26.904_830_417,
            "mouse_up",
            "left",
            3,
            1,
            0.071,
            0.5465,
        ),
        (
            10594,
            27.840_068_125,
            "mouse_down",
            "left",
            1,
            1,
            0.0738,
            0.6097,
        ),
        (
            10595,
            27.916_864_25,
            "mouse_up",
            "left",
            1,
            1,
            0.0738,
            0.6097,
        ),
        (
            10597,
            27.994_983_958,
            "mouse_down",
            "left",
            2,
            1,
            0.0738,
            0.6097,
        ),
        (
            10598,
            28.059_636_458,
            "mouse_up",
            "left",
            2,
            1,
            0.0738,
            0.6097,
        ),
        (
            10600,
            28.143_074_417,
            "mouse_down",
            "left",
            3,
            1,
            0.0738,
            0.6097,
        ),
        (
            10601,
            28.209_803_833,
            "mouse_up",
            "left",
            3,
            1,
            0.0738,
            0.6097,
        ),
        (
            10603,
            28.311_574_958,
            "mouse_down",
            "left",
            4,
            1,
            0.0738,
            0.6097,
        ),
        (
            10605,
            28.427_868_292,
            "mouse_up",
            "left",
            4,
            1,
            0.0738,
            0.6097,
        ),
        (
            12229,
            32.052_702_917,
            "mouse_down",
            "left",
            1,
            2,
            0.9752,
            0.6486,
        ),
        (
            12241,
            32.191_792_042,
            "mouse_up",
            "left",
            1,
            2,
            0.9747,
            0.6488,
        ),
    ];
    assert_eq!(button_events.len(), expected_button_events.len());
    for (
        (actual_index, event),
        (expected_index, expected_ts, expected_type, button, click_count, display_id, x, y),
    ) in button_events.iter().zip(expected_button_events)
    {
        let data = &event["data"];
        assert_eq!(*actual_index, expected_index);
        assert_eq!(event_type(event), expected_type);
        assert_timestamp(timestamp(event), expected_ts, expected_type);
        assert_eq!(data["button"], button);
        assert_eq!(data["click_count"].as_i64(), Some(click_count));
        assert_eq!(data["display_id"].as_u64(), Some(display_id));
        assert_timestamp(data["x"].as_f64().unwrap(), x, "mouse x");
        assert_timestamp(data["y"].as_f64().unwrap(), y, "mouse y");
    }

    let key_events = raw
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event_type(event), "key_down" | "key_up"))
        .collect::<Vec<_>>();
    let expected_key_events = [
        (12265, 32.985_042_083, "key_down", "enter"),
        (12266, 33.016_517_208, "key_up", "enter"),
    ];
    assert_eq!(key_events.len(), expected_key_events.len());
    for ((actual_index, event), (expected_index, expected_ts, expected_type, key)) in
        key_events.iter().zip(expected_key_events)
    {
        assert_eq!(*actual_index, expected_index);
        assert_eq!(event_type(event), expected_type);
        assert_timestamp(timestamp(event), expected_ts, expected_type);
        assert_eq!(event["data"]["key"], key);
    }
}

fn assert_manual_mouse_clicks_capture_contract(processed: &[Value]) {
    /*
    Legacy Python processor scenario: 2_mouse_clicks_recording_raw.jsonl

    Confirmed local macOS manual capture from the Rust native recorder. The run
    includes exploratory clicks and a small text-selection side effect before
    the intended middle/double/triple/quadruple click sequence. Those extra
    actions are intentionally frozen here so the saved raw trace remains a
    stable regression case for processing and screenshot synchronization.
    */
    assert_eq!(processed.len(), 36, "processed event count changed");
    assert_eq!(screenshots(processed).len(), 18);
    assert_eq!(actions(processed).len(), 18);
    let indexed_actions = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) != "screenshot")
        .collect::<Vec<_>>();
    let action_events = indexed_actions
        .iter()
        .map(|(_, event)| *event)
        .collect::<Vec<_>>();

    assert_eq!(
        action_types(&action_events),
        vec![
            "sleep", "click", "sleep", "click", "sleep", "click", "click", "drag", "sleep",
            "scroll", "click", "click", "click", "click", "click", "sleep", "click", "press"
        ]
    );

    let expected_action_indices = [
        1, 3, 5, 7, 9, 11, 13, 15, 17, 18, 20, 22, 24, 27, 29, 31, 33, 35,
    ];
    assert_eq!(
        indexed_actions
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_action_indices
    );

    let expected_actions = vec![
        (
            "sleep",
            0.070_079_875,
            0.070_079_875,
            json!({"duration": 4}),
        ),
        (
            "click",
            4.934_744_458,
            4.845_751,
            json!({"button": "right", "clicks": 1, "display_id": 2, "modifiers": [], "x": 0.7013, "y": 0.5344}),
        ),
        (
            "sleep",
            5.060_502_375,
            5.060_502_375,
            json!({"duration": 2}),
        ),
        (
            "click",
            8.030_690_25,
            7.934_739_667,
            json!({"button": "left", "clicks": 1, "display_id": 2, "modifiers": [], "x": 0.7476, "y": 0.5635}),
        ),
        ("sleep", 8.235_997, 8.235_997, json!({"duration": 3})),
        (
            "click",
            11.419_797_792,
            11.327_054_708,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.1608, "y": 0.6667}),
        ),
        (
            "click",
            13.228_814_458,
            13.141_794_792,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.2216, "y": 0.9663}),
        ),
        (
            "drag",
            16.331_335_125,
            15.424_758_292,
            json!({"button": "left", "display_id": 1, "duration": 0.5, "end_x": 0.2121, "end_y": 0.9749, "modifiers": [], "start_x": 0.1907, "start_y": 0.7134}),
        ),
        ("sleep", 17.348_766, 17.348_766, json!({"duration": 3})),
        (
            "scroll",
            19.058_776_167,
            18.989_726_5,
            json!({"clicks": -107, "display_id": 1, "x": 0.0666, "y": 0.7651}),
        ),
        (
            "click",
            20.524_939_583,
            20.409_844_25,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0783, "y": 0.6302}),
        ),
        (
            "click",
            23.146_196_958,
            22.546_753_25,
            json!({"button": "middle", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0309, "y": 0.8917}),
        ),
        (
            "click",
            25.140_168_542,
            24.909_956_292,
            json!({"button": "left", "clicks": 2, "display_id": 1, "modifiers": [], "x": 0.0705, "y": 0.7107}),
        ),
        (
            "click",
            26.904_830_417,
            26.538_859_667,
            json!({"button": "left", "clicks": 3, "display_id": 1, "modifiers": [], "x": 0.071, "y": 0.5467}),
        ),
        (
            "click",
            28.427_868_292,
            27.840_068_125,
            json!({"button": "left", "clicks": 4, "display_id": 1, "modifiers": [], "x": 0.0738, "y": 0.6097}),
        ),
        (
            "sleep",
            28.602_600_25,
            28.602_600_25,
            json!({"duration": 3}),
        ),
        (
            "click",
            32.191_792_042,
            32.052_702_917,
            json!({"button": "left", "clicks": 1, "display_id": 2, "modifiers": [], "x": 0.9752, "y": 0.6486}),
        ),
        (
            "press",
            32.985_042_083,
            32.985_042_083,
            json!({"key": "enter"}),
        ),
    ];
    for ((_, event), (typ, ts, start_ts, args)) in indexed_actions.iter().zip(expected_actions) {
        assert_eq!(event_type(event), typ);
        assert_timestamp(timestamp(event), ts, typ);
        assert_timestamp(start_timestamp(event), start_ts, typ);
        assert_eq!(event["args"], args, "unexpected args for {typ}");
    }

    let expected_screenshot_indices = [
        0, 2, 4, 6, 8, 10, 12, 14, 16, 19, 21, 23, 25, 26, 28, 30, 32, 34,
    ];
    let expected_screenshot_timestamps = [
        0.060_079_875,
        4.792_470_042,
        5.050_502_375,
        7.838_728_875,
        8.225_997,
        11.181_168_5,
        11.564_714_125,
        13.352_350_167,
        17.338_766,
        20.301_842_542,
        20.677_068_417,
        23.357_281_042,
        25.252_579_834,
        26.672_681_292,
        27.071_170_417,
        28.592_600_25,
        31.900_514_625,
        32.288_745_917,
    ];
    let indexed_screenshots = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) == "screenshot")
        .collect::<Vec<_>>();
    assert_eq!(
        indexed_screenshots
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_screenshot_indices
    );
    for ((_, screenshot), expected_ts) in indexed_screenshots
        .iter()
        .zip(expected_screenshot_timestamps)
    {
        assert_timestamp(timestamp(screenshot), expected_ts, "screenshot");
    }

    let expected_neighbors = [
        (Some(0), Some(2)),
        (Some(2), Some(4)),
        (Some(4), Some(6)),
        (Some(6), Some(8)),
        (Some(8), Some(10)),
        (Some(10), Some(12)),
        (Some(12), Some(14)),
        (Some(14), Some(16)),
        (Some(16), Some(19)),
        (Some(16), Some(19)),
        (Some(19), Some(21)),
        (Some(21), Some(23)),
        (Some(23), Some(25)),
        (Some(26), Some(28)),
        (Some(28), Some(30)),
        (Some(30), Some(32)),
        (Some(32), Some(34)),
        (Some(34), None),
    ];
    for ((action_index, _), (expected_before, expected_after)) in
        indexed_actions.iter().zip(expected_neighbors)
    {
        let before = processed[..*action_index]
            .iter()
            .enumerate()
            .rev()
            .find(|(_, event)| event_type(event) == "screenshot")
            .map(|(index, _)| index);
        let after = processed[*action_index + 1..]
            .iter()
            .enumerate()
            .find(|(_, event)| event_type(event) == "screenshot")
            .map(|(offset, _)| *action_index + 1 + offset);
        assert_eq!(before, expected_before);
        assert_eq!(after, expected_after);
    }

    assert_eq!(screenshot_action_screenshot_triples(processed), 12);

    let mut saw_display_1 = false;
    let mut saw_display_2 = false;
    for screenshot in screenshots(processed) {
        let args = &screenshot["args"];
        assert!(
            args.get("desktop_bounds").is_some(),
            "manual screenshot is missing desktop_bounds metadata"
        );
        let displays = args["displays"]
            .as_array()
            .expect("manual screenshot missing displays array");
        for display in displays {
            match display["display_id"].as_u64() {
                Some(1) => saw_display_1 = true,
                Some(2) => saw_display_2 = true,
                _ => {}
            }
            assert!(
                display.get("normalized_bounds").is_some(),
                "display screenshot is missing normalized_bounds metadata"
            );
        }
    }
    assert!(saw_display_1, "manual screenshots never recorded display 1");
    assert!(saw_display_2, "manual screenshots never recorded display 2");
}

fn assert_manual_modifiers_raw_contract(raw: &[Value]) {
    assert_eq!(
        raw.len(),
        22_149,
        "manual modifiers raw event count changed"
    );
    assert_eq!(count_events(raw, "mouse_move"), 21_353);
    assert_eq!(count_events(raw, "screenshot"), 692);
    assert_eq!(count_events(raw, "a11y+screenshot"), 2);
    assert_eq!(count_events(raw, "mouse_down"), 21);
    assert_eq!(count_events(raw, "mouse_up"), 21);
    assert_eq!(count_events(raw, "key_down"), 42);
    assert_eq!(count_events(raw, "key_up"), 18);
    assert!(
        raw.iter().any(|event| {
            event_type(event) == "mouse_move"
                && event["data"]["is_dragging"].as_bool().unwrap_or(false)
        }),
        "expected raw dragging mouse_move events"
    );

    let key_count = |typ: &str, key: &str| {
        raw.iter()
            .filter(|event| {
                event_type(event) == typ
                    && event["data"]["key"]
                        .as_str()
                        .map(|actual| actual.eq_ignore_ascii_case(key))
                        .unwrap_or(false)
            })
            .count()
    };
    assert_eq!(key_count("key_down", "ctrl"), 2);
    assert_eq!(key_count("key_up", "ctrl"), 2);
    assert_eq!(key_count("key_down", "command"), 3);
    assert_eq!(key_count("key_up", "command"), 3);
    assert_eq!(key_count("key_down", "shift"), 1);
    assert_eq!(key_count("key_up", "shift"), 1);
    assert_eq!(key_count("key_down", "q"), 25);
    assert_eq!(key_count("key_up", "q"), 10);
    assert_eq!(key_count("key_down", "backspace"), 10);
    assert_eq!(key_count("key_up", "backspace"), 1);
    assert_eq!(key_count("key_down", "enter"), 1);
    assert_eq!(key_count("key_up", "enter"), 1);
}

fn assert_manual_modifiers_capture_contract(processed: &[Value]) {
    /*
    Confirmed local macOS manual capture from the Rust native recorder:
    - Multi-monitor click/drag activity on displays 1 and 2.
    - Ctrl, Command, and Shift modified mouse actions.
    - Delayed visual page transition after a click, then a double-click.
    - Long q key sequence, then a held Backspace auto-repeat collapsed into
      press('backspace', count=10).
    - Final click on display 2 and Enter to stop.

    This contract freezes the visually reviewed raw trace exactly so recorder
    and processor changes keep the same action sequence, timestamps, and
    screenshot/action/screenshot alignment.
    */
    assert_eq!(processed.len(), 69, "processed event count changed");
    assert_eq!(screenshots(processed).len(), 35);
    assert_eq!(actions(processed).len(), 34);
    assert_eq!(screenshot_action_screenshot_triples(processed), 23);

    let indexed_actions = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) != "screenshot")
        .collect::<Vec<_>>();
    let expected_action_indices = [
        1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 22, 25, 27, 29, 31, 33, 35, 36, 39, 41, 43, 45, 47,
        49, 51, 53, 55, 57, 59, 61, 63, 65, 67,
    ];
    assert_eq!(
        indexed_actions
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_action_indices
    );

    let expected_actions = vec![
        ("sleep", 0.079_462, 0.079_462, json!({"duration": 3})),
        (
            "drag",
            4.231_238,
            3.112_062_208,
            json!({"button": "left", "display_id": 2, "duration": 0.5, "end_x": 0.9293, "end_y": 0.818, "modifiers": [], "start_x": 0.9005, "start_y": 0.8205}),
        ),
        (
            "click",
            5.284_356_417,
            5.198_318_5,
            json!({"button": "left", "clicks": 1, "display_id": 2, "modifiers": [], "x": 0.9426, "y": 0.8168}),
        ),
        (
            "sleep",
            5.425_987_375,
            5.425_987_375,
            json!({"duration": 11}),
        ),
        (
            "click",
            17.007_106_542,
            16.916_518_667,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": ["ctrl"], "x": 0.1346, "y": 0.6123}),
        ),
        (
            "click",
            17.864_226_042,
            17.791_045_333,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": ["ctrl"], "x": 0.135, "y": 0.6127}),
        ),
        ("sleep", 18.042_599, 18.042_599, json!({"duration": 3})),
        (
            "click",
            21.126_368_75,
            21.065_191_583,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.1374, "y": 0.5768}),
        ),
        (
            "sleep",
            21.281_825_042,
            21.281_825_042,
            json!({"duration": 4}),
        ),
        (
            "click",
            25.719_535_625,
            25.636_314_583,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": ["command"], "x": 0.1218, "y": 0.6332}),
        ),
        (
            "sleep",
            25.882_035_125,
            25.882_035_125,
            json!({"duration": 5}),
        ),
        (
            "click",
            30.656_324_292,
            30.591_442_583,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": ["shift"], "x": 0.0952, "y": 0.6631}),
        ),
        (
            "click",
            34.361_340_083,
            34.286_289_875,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0889, "y": 0.7364}),
        ),
        (
            "click",
            35.037_193_583,
            34.956_253_708,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0893, "y": 0.7395}),
        ),
        (
            "click",
            37.074_458_708,
            37.017_365_208,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0911, "y": 0.5311}),
        ),
        (
            "sleep",
            39.735_869_125,
            39.735_869_125,
            json!({"duration": 13}),
        ),
        (
            "click",
            53.000_502_708,
            52.754_356_333,
            json!({"button": "left", "clicks": 2, "display_id": 1, "modifiers": [], "x": 0.0814, "y": 0.7201}),
        ),
        (
            "sleep",
            53.172_329_875,
            53.172_329_875,
            json!({"duration": 16}),
        ),
        (
            "click",
            69.665_613_375,
            69.573_397_458,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.1289, "y": 0.407}),
        ),
        (
            "drag",
            72.772_414_875,
            72.073_194_292,
            json!({"button": "left", "display_id": 1, "duration": 0.5, "end_x": 0.0895, "end_y": 0.7633, "modifiers": ["ctrl"], "start_x": 0.015, "start_y": 0.7971}),
        ),
        (
            "drag",
            76.964_242_708,
            75.200_385_25,
            json!({"button": "left", "display_id": 1, "duration": 0.5, "end_x": 0.1292, "end_y": 0.7319, "modifiers": ["command"], "start_x": 0.0154, "start_y": 0.8013}),
        ),
        (
            "click",
            79.631_102_625,
            79.517_065_875,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.1118, "y": 0.4052}),
        ),
        (
            "sleep",
            79.794_415_417,
            79.794_415_417,
            json!({"duration": 13}),
        ),
        (
            "click",
            93.686_384_333,
            93.618_150_458,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.2056, "y": 0.9698}),
        ),
        (
            "drag",
            95.741_361_5,
            94.948_810_875,
            json!({"button": "left", "display_id": 1, "duration": 0.5, "end_x": 0.217, "end_y": 0.96, "modifiers": ["command"], "start_x": 0.2044, "start_y": 0.9281}),
        ),
        (
            "sleep",
            96.805_703_667,
            96.805_703_667,
            json!({"duration": 4}),
        ),
        (
            "click",
            101.312_487_917,
            101.222_351_083,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.0126, "y": 0.869}),
        ),
        (
            "click",
            101.888_360_042,
            101.824_543_792,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.1076, "y": 0.7144}),
        ),
        (
            "typewrite",
            108.601_518_583,
            104.297_694_417,
            json!({"interval": 0.1, "text": "qqqqqqqqqqqqqqqqqqqqqqqqq"}),
        ),
        (
            "sleep",
            108.910_776_708,
            108.910_776_708,
            json!({"duration": 4}),
        ),
        (
            "press",
            114.714_306_583,
            113.548_157_75,
            json!({"count": 10, "key": "backspace"}),
        ),
        (
            "sleep",
            114.963_093_833,
            114.963_093_833,
            json!({"duration": 3}),
        ),
        (
            "click",
            118.729_271_917,
            118.645_400_542,
            json!({"button": "left", "clicks": 1, "display_id": 2, "modifiers": [], "x": 0.9172, "y": 0.6241}),
        ),
        (
            "press",
            119.286_016_875,
            119.286_016_875,
            json!({"key": "enter"}),
        ),
    ];
    assert_eq!(indexed_actions.len(), expected_actions.len());
    for ((_, event), (typ, ts, start_ts, args)) in indexed_actions.iter().zip(expected_actions) {
        assert_eq!(event_type(event), typ);
        assert_timestamp(timestamp(event), ts, typ);
        assert_timestamp(start_timestamp(event), start_ts, typ);
        assert_eq!(event["args"], args, "unexpected args for {typ}");
    }

    let expected_screenshot_indices = [
        0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 23, 24, 26, 28, 30, 32, 34, 37, 38, 40, 42, 44, 46,
        48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68,
    ];
    let actual_screenshot_indices = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) == "screenshot")
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    assert_eq!(actual_screenshot_indices, expected_screenshot_indices);

    let expected_screenshot_timestamps = [
        0.069_462,
        3.004_773_75,
        5.052_253_25,
        5.415_987_375,
        16.769_132_958,
        17.142_980_042,
        18.032_599,
        21.024_359_708,
        21.271_825_042,
        25.489_831_625,
        25.872_035_125,
        30.901_768_375,
        33.208_039_333,
        34.478_153_542,
        35.244_894_167,
        39.725_869_125,
        52.637_829_125,
        53.162_329_875,
        69.699_760_917,
        69.814_533_708,
        73.786_280_542,
        78.002_734_208,
        79.784_415_417,
        93.424_331_458,
        93.851_457_875,
        96.795_703_667,
        101.123_618_208,
        101.504_805_833,
        102.019_883_375,
        108.900_776_708,
        113.484_937_708,
        114.953_093_833,
        118.500_725_875,
        118.877_535_042,
        119.535_980_208,
    ];
    for (event, expected_ts) in screenshots(processed)
        .iter()
        .zip(expected_screenshot_timestamps)
    {
        assert_timestamp(timestamp(event), expected_ts, "screenshot");
    }
}

fn assert_manual_special_keys_raw_contract(raw: &[Value]) {
    /*
    Confirmed local macOS manual capture for the first special-key slice.
    This freezes the raw trace visually reviewed as 4_special_keys:
    setup clicks/shortcuts, Esc, backtick, Tab, Caps Lock twice, and the
    F1/Fn+F1 plus F2/Fn+F2 function/media-key inversion paths.
    */
    assert_eq!(
        raw.len(),
        582,
        "manual special keys raw event count changed"
    );
    assert_eq!(count_events(raw, "mouse_move"), 348);
    assert_eq!(count_events(raw, "screenshot"), 187);
    assert_eq!(count_events(raw, "a11y+screenshot"), 1);
    assert_eq!(count_events(raw, "mouse_down"), 4);
    assert_eq!(count_events(raw, "mouse_up"), 4);
    assert_eq!(count_events(raw, "key_down"), 20);
    assert_eq!(count_events(raw, "key_up"), 18);

    let key_count = |typ: &str, key: &str| {
        raw.iter()
            .filter(|event| {
                event_type(event) == typ
                    && event["data"]["key"]
                        .as_str()
                        .map(|actual| actual.eq_ignore_ascii_case(key))
                        .unwrap_or(false)
            })
            .count()
    };

    assert_eq!(key_count("key_down", "alt"), 1);
    assert_eq!(key_count("key_up", "alt"), 1);
    assert_eq!(key_count("key_down", "shift"), 1);
    assert_eq!(key_count("key_up", "shift"), 1);
    assert_eq!(key_count("key_down", "command"), 1);
    assert_eq!(key_count("key_up", "command"), 1);
    assert_eq!(key_count("key_down", "1"), 2);
    assert_eq!(key_count("key_up", "1"), 2);
    assert_eq!(key_count("key_down", "l"), 1);
    assert_eq!(key_count("key_up", "l"), 1);
    assert_eq!(key_count("key_down", "k"), 1);
    assert_eq!(key_count("key_up", "k"), 1);
    assert_eq!(key_count("key_down", "e"), 1);
    assert_eq!(key_count("key_up", "e"), 1);
    assert_eq!(key_count("key_down", "y"), 1);
    assert_eq!(key_count("key_up", "y"), 1);
    assert_eq!(key_count("key_down", "enter"), 2);
    assert_eq!(key_count("key_up", "enter"), 2);
    assert_eq!(key_count("key_down", "esc"), 1);
    assert_eq!(key_count("key_up", "esc"), 1);
    assert_eq!(key_count("key_down", "`"), 1);
    assert_eq!(key_count("key_up", "`"), 1);
    assert_eq!(key_count("key_down", "tab"), 1);
    assert_eq!(key_count("key_up", "tab"), 1);
    assert_eq!(key_count("key_down", "capslock"), 2);
    assert_eq!(key_count("key_up", "capslock"), 0);
    assert_eq!(key_count("key_down", "brightness_down"), 1);
    assert_eq!(key_count("key_up", "brightness_down"), 1);
    assert_eq!(key_count("key_down", "f1"), 1);
    assert_eq!(key_count("key_up", "f1"), 1);
    assert_eq!(key_count("key_down", "brightness_up"), 1);
    assert_eq!(key_count("key_up", "brightness_up"), 1);
    assert_eq!(key_count("key_down", "f2"), 1);
    assert_eq!(key_count("key_up", "f2"), 1);
}

fn assert_manual_special_keys_capture_contract(processed: &[Value]) {
    /*
    This contract freezes the visually reviewed 4_special_keys trace exactly so
    recorder and processor changes keep the same action sequence, timestamps,
    and screenshot/action/screenshot alignment. Remaining legacy function-key
    coverage moves to 5_other_keys.
    */
    assert_eq!(processed.len(), 43, "processed event count changed");
    assert_eq!(screenshots(processed).len(), 22);
    assert_eq!(actions(processed).len(), 21);
    assert_eq!(screenshot_action_screenshot_triples(processed), 19);

    let indexed_actions = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) != "screenshot")
        .collect::<Vec<_>>();
    let expected_action_indices = [
        1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41,
    ];
    assert_eq!(
        indexed_actions
            .iter()
            .map(|(index, _)| *index)
            .collect::<Vec<_>>(),
        expected_action_indices
    );

    let expected_actions = vec![
        (
            "click",
            2.102_986_083,
            2.098_413_25,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.6984, "y": 0.6916}),
        ),
        (
            "hotkey",
            3.215_846_75,
            2.556_066_167,
            json!({"keys": ["alt", "!"]}),
        ),
        (
            "hotkey",
            3.659_617_458,
            2.556_066_167,
            json!({"keys": ["alt", "1"]}),
        ),
        (
            "click",
            5.599_539_75,
            5.594_683_25,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.2454, "y": 0.3875}),
        ),
        (
            "hotkey",
            6.081_531_833,
            5.902_513_875,
            json!({"keys": ["command", "l"]}),
        ),
        (
            "typewrite",
            7.039_846_083,
            6.713_539_792,
            json!({"interval": 0.1, "text": "key"}),
        ),
        ("press", 7.337_984_5, 7.337_984_5, json!({"key": "enter"})),
        (
            "sleep",
            7.574_217_667,
            7.574_217_667,
            json!({"duration": 2}),
        ),
        (
            "click",
            10.506_401_167,
            10.503_717_833,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.2445, "y": 0.6005}),
        ),
        ("press", 11.220_178_75, 11.220_178_75, json!({"key": "esc"})),
        (
            "typewrite",
            13.272_275_083,
            13.272_275_083,
            json!({"interval": 0.1, "text": "`"}),
        ),
        ("press", 13.736_132_75, 13.736_132_75, json!({"key": "tab"})),
        (
            "press",
            14.390_671_375,
            14.390_671_375,
            json!({"key": "capslock"}),
        ),
        (
            "press",
            14.963_064_583,
            14.963_064_583,
            json!({"key": "capslock"}),
        ),
        (
            "press",
            16.715_947_667,
            16.715_947_667,
            json!({"key": "brightness_down"}),
        ),
        (
            "sleep",
            17.007_974_875,
            17.007_974_875,
            json!({"duration": 3}),
        ),
        (
            "press",
            20.610_881_542,
            20.610_881_542,
            json!({"key": "f1"}),
        ),
        (
            "press",
            22.443_403_208,
            22.443_403_208,
            json!({"key": "brightness_up"}),
        ),
        (
            "press",
            24.301_371_875,
            24.301_371_875,
            json!({"key": "f2"}),
        ),
        (
            "click",
            26.540_118_208,
            26.540_052_375,
            json!({"button": "left", "clicks": 1, "display_id": 1, "modifiers": [], "x": 0.5773, "y": 0.632}),
        ),
        (
            "press",
            27.225_977_958,
            27.225_977_958,
            json!({"key": "enter"}),
        ),
    ];
    for ((_, event), (typ, ts, start_ts, args)) in indexed_actions.iter().zip(expected_actions) {
        assert_eq!(event_type(event), typ);
        assert_timestamp(timestamp(event), ts, typ);
        assert_timestamp(start_timestamp(event), start_ts, typ);
        assert_eq!(event["args"], args, "unexpected args for {typ}");
    }

    let actual_screenshot_indices = processed
        .iter()
        .enumerate()
        .filter(|(_, event)| event_type(event) == "screenshot")
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let expected_screenshot_indices = [
        0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42,
    ];
    assert_eq!(actual_screenshot_indices, expected_screenshot_indices);

    let expected_screenshot_timestamps = [
        0.041_140_125,
        2.257_321,
        3.549_245_5,
        3.937_937_917,
        5.746_574_167,
        6.409_584_959,
        7.189_137_75,
        7.564_217_667,
        10.430_848_75,
        10.694_521_917,
        11.469_290_459,
        13.517_489_417,
        13.913_309_5,
        14.565_630_959,
        15.215_603_875,
        16.997_974_875,
        20.575_533_875,
        20.814_424_292,
        22.693_824_75,
        24.491_189_667,
        26.689_125_875,
        27.476_808,
    ];
    for (event, expected_ts) in screenshots(processed)
        .iter()
        .zip(expected_screenshot_timestamps)
    {
        assert_timestamp(timestamp(event), expected_ts, "screenshot");
    }
}

#[test]
fn legacy_basic_recording_fixture_matches_contract() {
    /*
    Legacy Python processor scenario: 0_basic_recording_raw.jsonl

    Expected actions after processing:
    - One click.
    - One sleep in the 5..=7 second range.
    - Exactly one drag.
    - One Enter/Return press.
    - Screenshot/action/screenshot context around each real action.
    */
    let processed = process_raw_events_temp(vec![
        json!({"type":"screenshot","timestamp":0.1,"data":{"image":"start","width":100,"height":100,"encoding":"jpg"}}),
        json!({"type":"mouse_down","timestamp":0.2,"data":{"x":0.2,"y":0.2,"button":"left"}}),
        json!({"type":"mouse_up","timestamp":0.25,"data":{"x":0.2,"y":0.2,"button":"left"}}),
        json!({"type":"screenshot","timestamp":0.5,"data":{"image":"after_click","width":100,"height":100,"encoding":"jpg"}}),
        json!({"type":"screenshot","timestamp":5.9,"data":{"image":"before_drag","width":100,"height":100,"encoding":"jpg"}}),
        json!({"type":"mouse_down","timestamp":6.0,"data":{"x":0.25,"y":0.25,"button":"left"}}),
        json!({"type":"mouse_move","timestamp":6.2,"data":{"x":0.45,"y":0.45,"is_dragging":true}}),
        json!({"type":"mouse_up","timestamp":6.45,"data":{"x":0.45,"y":0.45,"button":"left"}}),
        json!({"type":"screenshot","timestamp":6.8,"data":{"image":"after_drag","width":100,"height":100,"encoding":"jpg"}}),
        json!({"type":"key_down","timestamp":7.0,"data":{"key":"enter"}}),
        json!({"type":"key_up","timestamp":7.03,"data":{"key":"enter","hold_duration":0.03}}),
        json!({"type":"screenshot","timestamp":7.3,"data":{"image":"after_enter","width":100,"height":100,"encoding":"jpg"}}),
    ]);
    let action_events = actions(&processed);
    let shot_events = screenshots(&processed);

    assert_eq!(
        action_types(&action_events),
        vec!["click", "sleep", "drag", "press"]
    );
    assert_eq!(
        screenshot_labels(&shot_events),
        vec![
            "start",
            "after_click",
            "before_drag",
            "after_drag",
            "after_enter"
        ]
    );

    let sequence = assert_basic_recording_contract(&processed);
    assert_eq!(sequence, [1, 3, 5, 7]);
}

#[test]
#[ignore = "set MANUAL_BASIC_RAW_JSONL to a locally captured *_raw.jsonl file"]
fn manual_1_basic_recording_capture_matches_contract() {
    /*
    Manual recorder action checklist:
    - Start recording with detailed/raw events enabled.
    - Leave the visible app idle briefly, type h, then press Backspace.
    - Click once in the app.
    - Type hello worl, press Backspace twice, press Ctrl+Space, then Backspace.
    - Type world, Space, Shift+1, Space. This must process as "world " then "! ".
    - Press Command+Tab, Alt+2, Alt+1, scroll twice, Alt+4, then click once.
    - Press Enter or Return in the terminal to stop.
    - Stop recording.

    This test reprocesses the captured raw JSONL and validates the confirmed
    local action sequence above, including timestamps and screenshot context.
    */
    let raw_path = env::var_os("MANUAL_BASIC_RAW_JSONL")
        .map(PathBuf::from)
        .expect("set MANUAL_BASIC_RAW_JSONL=/path/to/<recording>_raw.jsonl");
    let output_path = env::var_os("MANUAL_BASIC_PREPROCESSED_JSONL")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let raw_name = raw_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("1_basic_raw.jsonl");
            let output_name = if raw_name.ends_with("_raw.jsonl") {
                raw_name.replace("_raw.jsonl", "_preprocessed.jsonl")
            } else {
                format!("{raw_name}_preprocessed.jsonl")
            };
            raw_path.with_file_name(output_name)
        });

    let raw = read_jsonl(&raw_path);
    assert_confirmed_manual_basic_raw_contract(&raw);

    let processed = process_raw_to_path(&raw_path, &output_path);
    assert_confirmed_manual_basic_capture_contract(&processed);
    eprintln!(
        "manual basic contract passed: raw={} preprocessed={} triples={}",
        raw_path.display(),
        output_path.display(),
        screenshot_action_screenshot_triples(&processed)
    );
}

#[test]
#[ignore = "set MANUAL_MOUSE_CLICKS_RAW_JSONL to a locally captured *_raw.jsonl file"]
fn manual_2_mouse_clicks_recording_capture_matches_contract() {
    /*
    Manual recorder action checklist, based on legacy Python test_2:
    - Start recording with detailed/raw events enabled.
    - Right click once.
    - Middle click once.
    - Double left click at one stable pointer location.
    - Pause for about one second.
    - Triple left click at one stable pointer location.
    - Pause for about one second.
    - Quadruple left click at one stable pointer location.
    - Press Enter or Return in the terminal to stop.
    - Stop recording.

    This test reprocesses the confirmed captured raw JSONL and validates the
    exact local action sequence, raw event counts, timestamps, and screenshot
    context.
    */
    let raw_path = env::var_os("MANUAL_MOUSE_CLICKS_RAW_JSONL")
        .map(PathBuf::from)
        .expect("set MANUAL_MOUSE_CLICKS_RAW_JSONL=/path/to/<recording>_raw.jsonl");
    let output_path = env::var_os("MANUAL_MOUSE_CLICKS_PREPROCESSED_JSONL")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let raw_name = raw_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("2_mouse_clicks_raw.jsonl");
            let output_name = if raw_name.ends_with("_raw.jsonl") {
                raw_name.replace("_raw.jsonl", "_preprocessed.jsonl")
            } else {
                format!("{raw_name}_preprocessed.jsonl")
            };
            raw_path.with_file_name(output_name)
        });

    let processed = process_raw_to_path(&raw_path, &output_path);
    let raw = read_jsonl(&raw_path);
    assert_manual_mouse_clicks_raw_contract(&raw);
    assert_manual_mouse_clicks_capture_contract(&processed);
    eprintln!(
        "manual mouse clicks contract passed: raw={} preprocessed={} triples={}",
        raw_path.display(),
        output_path.display(),
        screenshot_action_screenshot_triples(&processed)
    );
}

#[test]
#[ignore = "set MANUAL_MODIFIERS_RAW_JSONL to a locally captured *_raw.jsonl file"]
fn manual_3_modifiers_recording_capture_matches_contract() {
    /*
    Frozen local macOS recorder trace based on legacy Python test_3 and test_4,
    then expanded during manual investigation to include multi-monitor sync,
    delayed screenshots, long typing, and held Backspace auto-repeat.
    */
    let raw_path = env::var_os("MANUAL_MODIFIERS_RAW_JSONL")
        .map(PathBuf::from)
        .expect("set MANUAL_MODIFIERS_RAW_JSONL=/path/to/<recording>_raw.jsonl");
    let output_path = env::var_os("MANUAL_MODIFIERS_PREPROCESSED_JSONL")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let raw_name = raw_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("3_modifiers_raw.jsonl");
            let output_name = if raw_name.ends_with("_raw.jsonl") {
                raw_name.replace("_raw.jsonl", "_preprocessed.jsonl")
            } else {
                format!("{raw_name}_preprocessed.jsonl")
            };
            raw_path.with_file_name(output_name)
        });

    let raw = read_jsonl(&raw_path);
    assert_manual_modifiers_raw_contract(&raw);

    let processed = process_raw_to_path(&raw_path, &output_path);
    assert_manual_modifiers_capture_contract(&processed);
    eprintln!(
        "manual modifiers contract passed: raw={} preprocessed={} triples={}",
        raw_path.display(),
        output_path.display(),
        screenshot_action_screenshot_triples(&processed)
    );
}

#[test]
#[ignore = "set MANUAL_SPECIAL_KEYS_RAW_JSONL to a locally captured *_raw.jsonl file"]
fn manual_4_special_keys_recording_capture_matches_contract() {
    /*
    Frozen manual recorder contract, based on the confirmed first slice from
    legacy Python test_5:
    - Start recording with detailed/raw events enabled.
    - Exploratory setup clicks and shortcuts.
    - Esc, backtick, Tab, and Caps Lock twice.
    - F1/Fn+F1 and F2/Fn+F2 on this Mac.
    - Final click and Enter or Return in the terminal to stop.
    - Stop recording.

    Remaining function/navigation/media key coverage is intentionally left for
    5_other_keys.
    */
    let raw_path = env::var_os("MANUAL_SPECIAL_KEYS_RAW_JSONL")
        .map(PathBuf::from)
        .expect("set MANUAL_SPECIAL_KEYS_RAW_JSONL=/path/to/<recording>_raw.jsonl");
    let output_path = env::var_os("MANUAL_SPECIAL_KEYS_PREPROCESSED_JSONL")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let raw_name = raw_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("4_special_keys_raw.jsonl");
            let output_name = if raw_name.ends_with("_raw.jsonl") {
                raw_name.replace("_raw.jsonl", "_preprocessed.jsonl")
            } else {
                format!("{raw_name}_preprocessed.jsonl")
            };
            raw_path.with_file_name(output_name)
        });

    let raw = read_jsonl(&raw_path);
    assert_manual_special_keys_raw_contract(&raw);

    let processed = process_raw_to_path(&raw_path, &output_path);
    assert_manual_special_keys_capture_contract(&processed);
    eprintln!(
        "manual special keys contract passed: raw={} preprocessed={} actions={} screenshots={}",
        raw_path.display(),
        output_path.display(),
        actions(&processed).len(),
        screenshots(&processed).len()
    );
}
