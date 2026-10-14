use serde_json::{json, Map, Value};

pub type Event = Value;

pub fn event_type(event: &Event) -> Option<&str> {
    event.get("type").and_then(Value::as_str)
}

pub fn timestamp(event: &Event) -> Option<f64> {
    event.get("timestamp").and_then(Value::as_f64)
}

pub fn timestamp_or_now(event: &Event) -> f64 {
    timestamp(event).unwrap_or_else(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    })
}

pub fn data_obj(event: &Event) -> Option<&Map<String, Value>> {
    event.get("data").and_then(Value::as_object)
}

pub fn get_str<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

pub fn get_f64(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(Value::as_f64)
}

pub fn create_processed_event(
    typ: &str,
    ts: f64,
    command: String,
    args: Value,
    start_ts: f64,
) -> Event {
    json!({
        "type": typ,
        "timestamp": ts,
        "start_timestamp": start_ts,
        "command": command,
        "args": args,
    })
}

pub fn is_modifier_key(key: &str) -> bool {
    matches!(
        key.to_lowercase().as_str(),
        "ctrl" | "shift" | "alt" | "command" | "win" | "windows"
    )
}

pub fn create_click_event(
    x: f64,
    y: f64,
    button: &str,
    clicks: i64,
    last_ts: f64,
    start_ts: Option<f64>,
    modifiers: Vec<String>,
    display_id: Option<u64>,
) -> Event {
    let start_ts = start_ts.unwrap_or(last_ts);
    let display_cmd = display_id
        .map(|id| format!(", display_id={id}"))
        .unwrap_or_default();
    let modifiers_cmd = if modifiers.is_empty() {
        String::new()
    } else {
        format!(", modifiers={:?}", modifiers)
    };
    let mut args = json!({
        "x": x,
        "y": y,
        "clicks": clicks,
        "button": button,
        "modifiers": modifiers,
    });
    if let Some(display_id) = display_id {
        args["display_id"] = json!(display_id);
    }
    create_processed_event(
        "click",
        last_ts,
        format!(
            "click(x={:.4}, y={:.4}, clicks={}, button='{}'{}{})",
            x, y, clicks, button, display_cmd, modifiers_cmd
        ),
        args,
        start_ts,
    )
}

pub fn create_drag_event(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    duration: f64,
    button: &str,
    ts: f64,
    start_ts: f64,
    modifiers: Vec<String>,
    display_id: Option<u64>,
) -> Event {
    let display_cmd = display_id
        .map(|id| format!(", display_id={id}"))
        .unwrap_or_default();
    let modifiers_cmd = if modifiers.is_empty() {
        String::new()
    } else {
        format!(", modifiers={:?}", modifiers)
    };
    let mut args = json!({
        "start_x": start_x,
        "start_y": start_y,
        "end_x": end_x,
        "end_y": end_y,
        "duration": duration,
        "button": button,
        "modifiers": modifiers,
    });
    if let Some(display_id) = display_id {
        args["display_id"] = json!(display_id);
    }
    create_processed_event(
        "drag",
        ts,
        format!(
            "drag(start_x={:.4}, start_y={:.4}, end_x={:.4}, end_y={:.4}, duration={:.2}, button='{}'{}{})",
            start_x, start_y, end_x, end_y, duration, button, display_cmd, modifiers_cmd
        ),
        args,
        start_ts,
    )
}

pub fn create_typewrite_event(
    text: String,
    interval: f64,
    last_ts: f64,
    first_ts: Option<f64>,
) -> Event {
    create_processed_event(
        "typewrite",
        last_ts,
        format!("typewrite(text='{}', interval={})", text, interval),
        json!({ "text": text, "interval": interval }),
        first_ts.unwrap_or(last_ts),
    )
}

pub fn create_press_event(key: &str, ts: f64, count: i64) -> Event {
    create_press_event_with_start(key, ts, count, ts)
}

pub fn create_press_event_with_start(key: &str, ts: f64, count: i64, start_ts: f64) -> Event {
    create_press_event_with_start_and_extra_args(key, ts, count, start_ts, None)
}

pub fn create_press_event_with_start_and_extra_args(
    key: &str,
    ts: f64,
    count: i64,
    start_ts: f64,
    extra_args: Option<Map<String, Value>>,
) -> Event {
    let command_key = extra_args
        .as_ref()
        .and_then(|args| args.get("display_key"))
        .and_then(Value::as_str)
        .unwrap_or(key);
    let command = if count > 1 {
        format!("press('{}', count={})", command_key, count)
    } else {
        format!("press('{}')", command_key)
    };
    let mut args = json!({ "key": key });
    if let Some(key_code) = unresolved_key_code(key) {
        args["key_code"] = json!(key_code);
        args["unresolved"] = json!(true);
    }
    if let Some(extra_args) = extra_args {
        if let Some(args_object) = args.as_object_mut() {
            args_object.extend(extra_args);
        }
    }
    if count > 1 {
        args["count"] = json!(count);
    }
    create_processed_event("press", ts, command, args, start_ts)
}

pub fn create_hotkey_event(keys: Vec<String>, last_ts: f64, start_ts: f64) -> Event {
    let rendered = keys
        .iter()
        .map(|k| format!("{:?}", k))
        .collect::<Vec<_>>()
        .join(", ");
    create_processed_event(
        "hotkey",
        last_ts,
        format!("hotkey({})", rendered),
        json!({ "keys": keys }),
        start_ts,
    )
}

pub fn create_scroll_event(
    clicks: i64,
    x: f64,
    y: f64,
    last_ts: f64,
    start_ts: f64,
    display_id: Option<u64>,
) -> Event {
    let display_cmd = display_id
        .map(|id| format!(", display_id={id}"))
        .unwrap_or_default();
    let mut args = json!({ "clicks": clicks, "x": x, "y": y });
    if let Some(display_id) = display_id {
        args["display_id"] = json!(display_id);
    }
    create_processed_event(
        "scroll",
        last_ts,
        format!(
            "scroll(clicks={}, x={:.4}, y={:.4}{})",
            clicks, x, y, display_cmd
        ),
        args,
        start_ts,
    )
}

pub fn create_sleep_event(duration: i64, ts: f64) -> Event {
    create_processed_event(
        "sleep",
        ts,
        format!("sleep({})", duration),
        json!({ "duration": duration }),
        ts,
    )
}

pub fn create_screenshot_event(candidate: &Event) -> Event {
    json!({
        "type": "screenshot",
        "timestamp": candidate.get("timestamp").cloned().unwrap_or(json!(0.0)),
        "command": "",
        "args": candidate.get("data").cloned().unwrap_or_else(|| json!({})),
    })
}

pub fn map_control_char(key: &str) -> String {
    if key.chars().count() != 1 {
        return key.to_string();
    }
    let ch = key.chars().next().unwrap_or_default();
    if (ch as u32) >= 32 && (ch as u32) != 127 {
        return key.to_string();
    }
    match ch as u8 {
        8 => "backspace".to_string(),
        9 => "tab".to_string(),
        10 | 13 => "enter".to_string(),
        27 => "esc".to_string(),
        127 => "backspace".to_string(),
        1..=26 => ((b'a' + ((ch as u8) - 1)) as char).to_string(),
        _ => key.to_string(),
    }
}

pub fn map_control_char_for_hotkey(key: &str) -> String {
    if key.chars().count() != 1 {
        return key.to_string();
    }
    let ch = key.chars().next().unwrap_or_default();
    if (ch as u32) >= 32 && (ch as u32) != 127 {
        return key.to_string();
    }
    match ch as u8 {
        9 => "tab".to_string(),
        10 | 13 => "enter".to_string(),
        27 => "esc".to_string(),
        127 => "backspace".to_string(),
        1..=26 => ((b'a' + ((ch as u8) - 1)) as char).to_string(),
        _ => key.to_string(),
    }
}

pub fn canonical_key_name(key: &str) -> String {
    match key.to_lowercase().as_str() {
        "escape" => "esc".to_string(),
        "return" => "enter".to_string(),
        "page_down" | "page-down" => "pagedown".to_string(),
        "page_up" | "page-up" => "pageup".to_string(),
        "print_screen" | "print-screen" => "printscreen".to_string(),
        "playpause" | "play-pause" => "play_pause".to_string(),
        "missioncontrol" | "mission-control" => "mission_control".to_string(),
        "do-not-disturb" | "donotdisturb" => "do_not_disturb".to_string(),
        "brightnessdown" | "brightness-down" => "brightness_down".to_string(),
        "brightnessup" | "brightness-up" => "brightness_up".to_string(),
        "volumeup" | "volume-up" => "volume_up".to_string(),
        "volumedown" | "volume-down" => "volume_down".to_string(),
        "mute" | "volumemute" | "volume-mute" => "volume_mute".to_string(),
        "help" => "insert".to_string(),
        _ => key.to_string(),
    }
}

pub fn get_char_for_key(key: &str, shift_active: bool, capslock_on: bool) -> String {
    let lower = key.to_lowercase();
    if matches!(lower.as_str(), "left" | "right" | "up" | "down") {
        return lower;
    }
    if key == "space" {
        return " ".to_string();
    }

    let shifted = match key {
        "1" => Some("!"),
        "2" => Some("\""),
        "3" => Some("§"),
        "4" => Some("$"),
        "5" => Some("%"),
        "6" => Some("&"),
        "7" => Some("/"),
        "8" => Some("("),
        "9" => Some(")"),
        "0" => Some("="),
        "-" => Some("_"),
        "=" => Some("+"),
        "[" => Some("{"),
        "]" => Some("}"),
        "\\" => Some("|"),
        ";" => Some(":"),
        "'" => Some("\""),
        "," => Some(";"),
        "." => Some(":"),
        "/" => Some("?"),
        "`" => Some("~"),
        "#" => Some("'"),
        "<" => Some(">"),
        "ß" => Some("?"),
        "´" => Some("`"),
        "+" => Some("*"),
        "ü" => Some("Ü"),
        "ö" => Some("Ö"),
        "ä" => Some("Ä"),
        _ => None,
    };

    if let Some(shifted) = shifted {
        return if shift_active {
            shifted.to_string()
        } else {
            key.to_string()
        };
    }

    if key.chars().count() == 1 {
        let Some(ch) = key.chars().next() else {
            return key.to_string();
        };
        if ch.is_ascii_alphabetic() {
            let upper = shift_active ^ capslock_on;
            return if upper {
                ch.to_ascii_uppercase().to_string()
            } else {
                ch.to_ascii_lowercase().to_string()
            };
        }
        return if shift_active {
            key.to_uppercase()
        } else {
            key.to_lowercase()
        };
    }

    key.to_string()
}

pub fn should_break_typing(key: &str, _modifiers: &std::collections::HashSet<String>) -> bool {
    if unresolved_key_code(key).is_some() {
        return true;
    }

    matches!(
        key.to_lowercase().as_str(),
        "home"
            | "end"
            | "pageup"
            | "pagedown"
            | "backspace"
            | "delete"
            | "tab"
            | "left"
            | "right"
            | "up"
            | "down"
            | "enter"
            | "esc"
            | "capslock"
            | "insert"
            | "volume_mute"
            | "volume_down"
            | "volume_up"
            | "mission_control"
            | "launchpad"
            | "spotlight"
            | "dictation"
            | "do_not_disturb"
            | "function"
            | "brightness_down"
            | "brightness_up"
            | "play_pause"
            | "play_previous"
            | "play_next"
            | "fast_forward"
            | "rewind"
            | "keyboard_brightness_up"
            | "keyboard_brightness_down"
            | "keyboard_brightness_toggle"
            | "f1"
            | "f2"
            | "f3"
            | "f4"
            | "f5"
            | "f6"
            | "f7"
            | "f8"
            | "f9"
            | "f10"
            | "f11"
            | "f12"
            | "printscreen"
            | "scrolllock"
            | "numlock"
    )
}

pub fn unresolved_key_code(key: &str) -> Option<i64> {
    key.strip_prefix("unknown_")
        .and_then(|code| code.parse::<i64>().ok())
}

pub fn get_refresh_offset(action_type: &str) -> f64 {
    match action_type {
        "drag" => 1.0,
        "click" => 0.15,
        "scroll" => 0.3,
        "moveTo" => 0.0,
        "typewrite" => 0.3,
        "press" => 0.2,
        "hotkey" => 0.3,
        _ => 0.3,
    }
}
