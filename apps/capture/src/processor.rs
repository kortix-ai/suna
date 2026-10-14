use crate::{
    streaming_writer::StreamingJsonlinesWriter,
    utils::{
        canonical_key_name, create_click_event, create_drag_event, create_hotkey_event,
        create_press_event, create_press_event_with_start_and_extra_args, create_screenshot_event,
        create_scroll_event, create_sleep_event, create_typewrite_event, data_obj, event_type,
        get_char_for_key, get_f64, get_refresh_offset, get_str, is_modifier_key, map_control_char,
        map_control_char_for_hotkey, should_break_typing, timestamp_or_now, unresolved_key_code,
        Event,
    },
};
use anyhow::Result;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    hash::{Hash, Hasher},
    sync::Arc,
};

fn get_u64(map: Option<&Map<String, Value>>, key: &str) -> Option<u64> {
    map.and_then(|data| data.get(key)).and_then(Value::as_u64)
}

fn key_name_from_event_data(data: Option<&Map<String, Value>>) -> String {
    let raw_key = data.and_then(|d| get_str(d, "key")).unwrap_or_default();
    let key = canonical_key_name(raw_key);

    if let Some(alias) = macos_keyboard_event_alias(data) {
        return alias.to_string();
    }

    key
}

fn key_press_diagnostic_args(
    data: Option<&Map<String, Value>>,
    key: &str,
) -> Option<Map<String, Value>> {
    let data = data?;
    let unresolved = unresolved_key_code(key).is_some()
        || data
            .get("windows_virtual_key")
            .and_then(Value::as_str)
            .is_some();
    if !unresolved {
        return None;
    }

    let mut args = Map::new();
    for field in ["key_code", "unresolved", "windows_virtual_key"] {
        if let Some(value) = data.get(field) {
            args.insert(field.to_string(), value.clone());
        }
    }
    if let Some(display_key) = diagnostic_display_key(data, key) {
        args.insert("display_key".to_string(), json!(display_key));
    }
    (!args.is_empty()).then_some(args)
}

fn diagnostic_display_key(data: &Map<String, Value>, key: &str) -> Option<String> {
    let key_code = unresolved_key_code(key)?;
    match data.get("windows_virtual_key").and_then(Value::as_str) {
        Some(value) if value.starts_with("VK_RESERVED_") => {
            Some(format!("windows_reserved_key_0x{key_code:02X}"))
        }
        Some("VK_PACKET") => Some("windows_text_input_packet".to_string()),
        _ => None,
    }
}

fn macos_keyboard_event_alias(data: Option<&Map<String, Value>>) -> Option<&'static str> {
    let data = data?;
    if get_u64(Some(data), "system_key_code").is_some()
        || data
            .get("system_event")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return None;
    }

    // These are CG keyboard-event codes for Apple top-row and Fn keys,
    // not NX_SYSDEFINED media-key codes. Keep this as a processor fallback so
    // older raw traces with unknown_* labels can be normalized after recorder
    // mappings improve.
    Some(match get_u64(Some(data), "key_code")? {
        131 => "launchpad",
        160 => "mission_control",
        176 => "dictation",
        177 => "spotlight",
        178 => "do_not_disturb",
        179 => "function",
        _ => return None,
    })
}

fn lock_state_from_event_data(data: Option<&Map<String, Value>>) -> Option<bool> {
    let data = data?;
    if let Some(lock_on) = data.get("lock_on").and_then(Value::as_bool) {
        return Some(lock_on);
    }

    match get_str(data, "lock_state")?.to_ascii_lowercase().as_str() {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

fn create_lock_press_event(key: &str, ts: f64, lock_on: Option<bool>) -> Event {
    let mut event = create_press_event(key, ts, 1);
    if let Some(lock_on) = lock_on {
        if let Some(args) = event.get_mut("args").and_then(Value::as_object_mut) {
            args.insert("lock_on".to_string(), json!(lock_on));
            args.insert(
                "lock_state".to_string(),
                json!(if lock_on { "on" } else { "off" }),
            );
        }
    }
    event
}

fn screenshot_image_str(event: &Event) -> Option<&str> {
    event
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("image"))
        .or_else(|| {
            event
                .get("args")
                .and_then(Value::as_object)
                .and_then(|args| args.get("image"))
        })
        .and_then(Value::as_str)
}

fn screenshot_luma_sample(image: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose, Engine as _};
    use image::imageops::FilterType;

    let bytes = general_purpose::STANDARD.decode(image).ok()?;
    let decoded = image::load_from_memory(&bytes).ok()?.to_luma8();
    let sample = image::imageops::resize(&decoded, 64, 36, FilterType::Triangle);
    Some(sample.into_raw())
}

fn screenshot_image_hash(image: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    image.hash(&mut hasher);
    hasher.finish()
}

fn luma_sample_change_stats(a_sample: &[u8], b_sample: &[u8]) -> Option<(f64, u8)> {
    if a_sample.len() != b_sample.len() || a_sample.is_empty() {
        return None;
    }

    let mut total = 0_u64;
    let mut peak = 0_u8;
    for (left, right) in a_sample.iter().zip(b_sample.iter()) {
        let diff = left.abs_diff(*right);
        total += diff as u64;
        peak = peak.max(diff);
    }

    Some((total as f64 / a_sample.len() as f64, peak))
}

fn screenshot_luma_change_stats(a: &Event, b: &Event) -> Option<(f64, u8)> {
    let a_image = screenshot_image_str(a)?;
    let b_image = screenshot_image_str(b)?;
    if a_image == b_image {
        return Some((0.0, 0));
    }

    let (Some(a_sample), Some(b_sample)) = (
        screenshot_luma_sample(a_image),
        screenshot_luma_sample(b_image),
    ) else {
        return None;
    };
    if a_sample.len() != b_sample.len() || a_sample.is_empty() {
        return None;
    }

    let mut total = 0_u64;
    let mut peak = 0_u8;
    for (left, right) in a_sample.iter().zip(b_sample.iter()) {
        let diff = left.abs_diff(*right);
        total += diff as u64;
        peak = peak.max(diff);
    }

    Some((total as f64 / a_sample.len() as f64, peak))
}

#[derive(Debug, Clone)]
struct ProcessedScreenshotVisual {
    image_hash: u64,
    luma_sample: Vec<u8>,
}

impl ProcessedScreenshotVisual {
    fn from_event(event: &Event) -> Option<Self> {
        let image = screenshot_image_str(event)?;
        Some(Self {
            image_hash: screenshot_image_hash(image),
            luma_sample: screenshot_luma_sample(image)?,
        })
    }

    fn changed_from_event(&self, event: &Event, threshold: f64) -> bool {
        let Some(image) = screenshot_image_str(event) else {
            return false;
        };
        if screenshot_image_hash(image) == self.image_hash {
            return false;
        }
        let Some(candidate_sample) = screenshot_luma_sample(image) else {
            return false;
        };
        luma_sample_change_stats(&self.luma_sample, &candidate_sample)
            .map(|(mean, _)| mean > threshold)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone)]
struct ScreenshotManager {
    buffer: VecDeque<Event>,
    used_screenshots: VecDeque<f64>,
    max_screenshots: usize,
}

impl ScreenshotManager {
    const NEXT_ACTION_SCREENSHOT_GUARD: f64 = 0.10;
    const HOTKEY_LATE_FRAME_IDLE_GAP: f64 = 2.5;
    const HOTKEY_LATE_FRAME_DELAY: f64 = 0.15;
    const CLICK_SETTLED_REFRESH_OFFSET: f64 = 0.35;
    const DELAYED_VISUAL_FRAME_IDLE_GAP: f64 = 2.5;
    const DELAYED_VISUAL_CHANGE_THRESHOLD: f64 = 3.0;
    const LOCAL_VISUAL_CHANGE_PEAK_THRESHOLD: u8 = 8;
    const EARLY_REFRESH_TARGET_TOLERANCE: f64 = 0.04;

    fn new(max_screenshots: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(max_screenshots),
            used_screenshots: VecDeque::with_capacity(max_screenshots),
            max_screenshots,
        }
    }

    fn add_screenshot(&mut self, event: Event) {
        if !matches!(event_type(&event), Some("screenshot" | "a11y+screenshot")) {
            return;
        }
        if self.buffer.len() == self.max_screenshots {
            self.buffer.pop_front();
        }
        self.buffer.push_back(event);
    }

    fn handle_screenshot(&mut self, event: Event) {
        self.add_screenshot(event);
    }

    fn mark_as_used(&mut self, screenshot: &Event) {
        if let Some(ts) = screenshot.get("timestamp").and_then(Value::as_f64) {
            if self.used_screenshots.len() == self.max_screenshots {
                self.used_screenshots.pop_front();
            }
            self.used_screenshots.push_back(ts);
        }
    }

    fn is_used(&self, ts: f64) -> bool {
        self.used_screenshots
            .iter()
            .any(|used_ts| (*used_ts - ts).abs() < f64::EPSILON)
    }

    fn find_closest_screenshot(
        &self,
        target_timestamp: f64,
        search_before: bool,
        limit_timestamp: Option<f64>,
        max_distance: f64,
        min_distance: f64,
    ) -> Option<Event> {
        self.buffer
            .iter()
            .filter_map(|sc| {
                let ts = sc.get("timestamp").and_then(Value::as_f64)?;
                if self.is_used(ts) {
                    return None;
                }
                if search_before && ts >= target_timestamp {
                    return None;
                }
                if let Some(limit) = limit_timestamp {
                    if (target_timestamp - ts) > (target_timestamp - limit) {
                        return None;
                    }
                }
                let diff = (ts - target_timestamp).abs();
                if diff < min_distance {
                    return None;
                }
                if diff > max_distance {
                    return None;
                }
                Some((sc.clone(), diff))
            })
            .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(sc, _)| sc)
    }

    fn find_closest_screenshot_before(
        &self,
        target_timestamp: f64,
        limit_timestamp: f64,
        min_timestamp_offset: f64,
    ) -> Option<Event> {
        self.find_closest_screenshot(
            target_timestamp,
            true,
            Some(limit_timestamp),
            f64::INFINITY,
            min_timestamp_offset,
        )
    }

    fn closest_to_target(candidates: &[(Event, f64)], target_ts: f64) -> Option<Event> {
        candidates
            .iter()
            .min_by(|(_, a), (_, b)| {
                (a - target_ts)
                    .abs()
                    .partial_cmp(&(b - target_ts).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(sc, _)| sc.clone())
    }

    fn first_at_or_after_target(candidates: &[(Event, f64)], target_ts: f64) -> Option<Event> {
        candidates
            .iter()
            .filter(|(_, ts)| *ts >= target_ts)
            .min_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(sc, _)| sc.clone())
    }

    fn first_after_target_if_visual_changed(
        candidates: &[(Event, f64)],
        target_ts: f64,
    ) -> Option<Event> {
        let closest = candidates.iter().min_by(|(_, a), (_, b)| {
            (a - target_ts)
                .abs()
                .partial_cmp(&(b - target_ts).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some((closest_sc, ts)) = closest {
            if *ts < target_ts && target_ts - *ts > Self::EARLY_REFRESH_TARGET_TOLERANCE {
                if let Some(after_target) = Self::first_at_or_after_target(candidates, target_ts) {
                    // Keep the legacy closest-frame behavior unless the first
                    // frame after the refresh target has a real local visual
                    // change. This handles delayed UI animations on any OS
                    // without key-specific or platform-specific exceptions.
                    let has_local_change = screenshot_luma_change_stats(closest_sc, &after_target)
                        .map(|(_, peak)| peak >= Self::LOCAL_VISUAL_CHANGE_PEAK_THRESHOLD)
                        .unwrap_or(false);

                    if has_local_change {
                        return Some(after_target);
                    }
                }
            }
        }
        closest.map(|(sc, _)| sc.clone())
    }

    fn first_changed_after_target(
        candidates: &[(Event, f64)],
        baseline: &Event,
        target_ts: f64,
    ) -> Option<Event> {
        candidates
            .iter()
            .filter(|(_, ts)| *ts >= target_ts)
            .find_map(|(candidate, _)| {
                screenshot_luma_change_stats(baseline, candidate)
                    .map(|(mean, peak)| {
                        mean > Self::DELAYED_VISUAL_CHANGE_THRESHOLD
                            || peak >= Self::LOCAL_VISUAL_CHANGE_PEAK_THRESHOLD
                    })
                    .unwrap_or(false)
                    .then(|| candidate.clone())
            })
    }

    fn choose_screenshot_for_action(
        &self,
        action_type: &str,
        t_current: f64,
        t_next: f64,
        refresh_offset: f64,
        allow_delayed_visual_frame: bool,
    ) -> Option<Event> {
        let raw_target_ts = t_current + refresh_offset;
        let unused = self
            .buffer
            .iter()
            .filter_map(|sc| {
                let ts = sc.get("timestamp").and_then(Value::as_f64)?;
                if self.is_used(ts) {
                    None
                } else {
                    Some((sc.clone(), ts))
                }
            })
            .collect::<Vec<_>>();

        let after_current = unused
            .iter()
            .filter(|(_, ts)| *ts > t_current)
            .cloned()
            .collect::<Vec<_>>();
        if after_current.is_empty() {
            return None;
        }

        if t_next == f64::INFINITY {
            let closest = Self::closest_to_target(&after_current, raw_target_ts);
            if closest.is_some() {
                if allow_delayed_visual_frame {
                    let newest_ts = after_current
                        .iter()
                        .map(|(_, ts)| *ts)
                        .fold(f64::NEG_INFINITY, f64::max);
                    if newest_ts - t_current > Self::DELAYED_VISUAL_FRAME_IDLE_GAP {
                        if let Some(closest_sc) = closest.as_ref() {
                            if let Some(changed) = Self::first_changed_after_target(
                                &after_current,
                                closest_sc,
                                raw_target_ts,
                            ) {
                                return Some(changed);
                            }
                        }
                    }
                }
                if action_type == "hotkey" && after_current.len() > 1 {
                    let newest_ts = after_current
                        .iter()
                        .map(|(_, ts)| *ts)
                        .fold(f64::NEG_INFINITY, f64::max);
                    if newest_ts - t_current > Self::HOTKEY_LATE_FRAME_IDLE_GAP {
                        let late_target_ts = raw_target_ts + Self::HOTKEY_LATE_FRAME_DELAY;
                        return after_current
                            .into_iter()
                            .filter(|(_, ts)| *ts >= late_target_ts)
                            .min_by(|(_, a), (_, b)| {
                                a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                            })
                            .map(|(sc, _)| sc)
                            .or(closest);
                    }
                }
            }
            return Self::first_after_target_if_visual_changed(&after_current, raw_target_ts);
        }

        let between = after_current
            .iter()
            .filter(|(_, ts)| *ts < t_next)
            .cloned()
            .collect::<Vec<_>>();
        if !between.is_empty() {
            let stable_between = between
                .iter()
                .filter(|(_, ts)| *ts <= t_next - Self::NEXT_ACTION_SCREENSHOT_GUARD)
                .cloned()
                .collect::<Vec<_>>();
            let target_ts = if stable_between.is_empty() {
                raw_target_ts.min(t_next)
            } else {
                raw_target_ts.min(t_next - Self::NEXT_ACTION_SCREENSHOT_GUARD)
            };
            let has_stable_between = !stable_between.is_empty();
            let candidates = if stable_between.is_empty() {
                between
            } else {
                stable_between
            };
            let closest = Self::closest_to_target(&candidates, target_ts);
            if closest.is_some() {
                if allow_delayed_visual_frame
                    && has_stable_between
                    && candidates.len() > 1
                    && t_next - t_current + Self::NEXT_ACTION_SCREENSHOT_GUARD
                        >= Self::DELAYED_VISUAL_FRAME_IDLE_GAP
                {
                    if let Some(closest_sc) = closest.as_ref() {
                        if let Some(changed) =
                            Self::first_changed_after_target(&candidates, closest_sc, target_ts)
                        {
                            return Some(changed);
                        }
                    }
                }
                // Slow hotkeys such as Ctrl+P can show an unchanged frame near
                // the refresh offset, then a modal/menu frame during a long idle
                // gap. Attach the first later stable frame to the hotkey instead
                // of letting the next action's sleep insertion consume it.
                if action_type == "hotkey"
                    && candidates.len() > 1
                    && t_next - t_current > Self::HOTKEY_LATE_FRAME_IDLE_GAP
                {
                    let late_target_ts = (target_ts + Self::HOTKEY_LATE_FRAME_DELAY).min(t_next);
                    return candidates
                        .into_iter()
                        .filter(|(_, ts)| *ts >= late_target_ts)
                        .min_by(|(_, a), (_, b)| {
                            a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .map(|(sc, _)| sc)
                        .or(closest);
                }
            }
            return Self::first_after_target_if_visual_changed(&candidates, target_ts);
        }

        None
    }

    fn assign_screenshot(
        &mut self,
        action: &Event,
        t_next: f64,
        min_timestamp_offset: f64,
    ) -> Option<Event> {
        let action_type = event_type(action).unwrap_or("unknown");
        let t_current = action.get("timestamp").and_then(Value::as_f64)?;
        let is_enter_press = action_type == "press"
            && action
                .get("args")
                .and_then(|args| args.get("key"))
                .and_then(Value::as_str)
                == Some("enter");
        let allow_delayed_visual_frame = matches!(action_type, "click" | "drag") || is_enter_press;
        let refresh_offset = if action_type == "click" {
            get_refresh_offset(action_type).max(Self::CLICK_SETTLED_REFRESH_OFFSET)
        } else {
            get_refresh_offset(action_type)
        };
        let mut candidate = self.choose_screenshot_for_action(
            action_type,
            t_current,
            t_next,
            refresh_offset,
            allow_delayed_visual_frame,
        );
        if let Some(sc) = &candidate {
            if sc
                .get("timestamp")
                .and_then(Value::as_f64)
                .map(|ts| ts < t_current - min_timestamp_offset)
                .unwrap_or(false)
            {
                candidate = None;
            }
        }
        if let Some(sc) = &candidate {
            self.mark_as_used(sc);
        }
        candidate
    }
}

#[derive(Debug, Default)]
struct MouseMoveProcessor {
    pending_mouse_move: Option<PendingMove>,
    last_position: (f64, f64),
}

#[derive(Debug, Clone)]
struct PendingMove {
    last_ts: f64,
}

impl MouseMoveProcessor {
    const MOVE_THRESHOLD: f64 = 0.8;

    fn process(&mut self, event: &Event) {
        if event_type(event) != Some("mouse_move") {
            self.pending_mouse_move = None;
            return;
        }
        let ts = timestamp_or_now(event);
        let data = data_obj(event);
        let x = data
            .and_then(|d| get_f64(d, "x"))
            .unwrap_or(self.last_position.0);
        let y = data
            .and_then(|d| get_f64(d, "y"))
            .unwrap_or(self.last_position.1);
        self.last_position = (x, y);

        match self.pending_mouse_move.as_mut() {
            Some(pending) if ts - pending.last_ts <= Self::MOVE_THRESHOLD => {
                pending.last_ts = ts;
            }
            _ => self.pending_mouse_move = Some(PendingMove { last_ts: ts }),
        }
    }

    fn flush(&mut self) -> Vec<Event> {
        self.pending_mouse_move = None;
        Vec::new()
    }
}

#[derive(Debug, Clone)]
struct PendingClick {
    start_ts: f64,
    last_ts: f64,
    x: f64,
    y: f64,
    button: String,
    click_count: i64,
    modifiers: Vec<String>,
    display_id: Option<u64>,
}

#[derive(Debug)]
struct MouseClickProcessor {
    pending_mouse_down: Option<Event>,
    pending_click: Option<PendingClick>,
    pending_drag_seen: bool,
    pending_drag_max_distance: f64,
}

impl MouseClickProcessor {
    const CLICK_THRESHOLD: f64 = 0.5;
    const DRAG_THRESHOLD: f64 = 0.005;
    const ZERO_NET_DRAG_SUPPRESS_THRESHOLD: f64 = 0.02;
    const DRAG_DURATION: f64 = 0.5;

    fn new() -> Self {
        Self {
            pending_mouse_down: None,
            pending_click: None,
            pending_drag_seen: false,
            pending_drag_max_distance: 0.0,
        }
    }

    fn process(&mut self, event: &Event, keyboard: &KeyboardProcessor) -> Vec<Event> {
        let event_type = event_type(event).unwrap_or_default();
        let ts = timestamp_or_now(event);
        let mut actions = Vec::new();

        if event_type == "mouse_down" {
            if self.pending_mouse_down.is_some() && self.pending_drag_seen {
                return actions;
            }
            if self
                .pending_click
                .as_ref()
                .map(|click| ts - click.last_ts > Self::CLICK_THRESHOLD)
                .unwrap_or(false)
            {
                if let Some(action) = self.flush_pending_click() {
                    actions.push(action);
                }
            }
            self.pending_drag_seen = false;
            self.pending_drag_max_distance = 0.0;
            self.pending_mouse_down = Some(event.clone());
            return actions;
        }

        if event_type == "mouse_up" {
            if let Some(action) = self.handle_mouse_up(event, keyboard) {
                actions.push(action);
            }
            return actions;
        }

        if matches!(event_type, "key_down" | "mouse_scroll") {
            if let Some(action) = self.flush_pending_click() {
                actions.push(action);
            }
        } else if !matches!(event_type, "mouse_down" | "mouse_up")
            && self
                .pending_click
                .as_ref()
                .map(|click| ts - click.last_ts > Self::CLICK_THRESHOLD)
                .unwrap_or(false)
        {
            if let Some(action) = self.flush_pending_click() {
                actions.push(action);
            }
        }

        actions
    }

    fn observe_mouse_move(&mut self, event: &Event) {
        let Some(mouse_down) = self.pending_mouse_down.as_ref() else {
            return;
        };
        let Some(move_data) = data_obj(event) else {
            return;
        };
        if !move_data
            .get("is_dragging")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }

        let down_data = data_obj(mouse_down);
        let start_x = down_data.and_then(|data| get_f64(data, "x")).unwrap_or(0.0);
        let start_y = down_data.and_then(|data| get_f64(data, "y")).unwrap_or(0.0);
        let current_x = get_f64(move_data, "x").unwrap_or(start_x);
        let current_y = get_f64(move_data, "y").unwrap_or(start_y);
        let distance = ((current_x - start_x).powi(2) + (current_y - start_y).powi(2)).sqrt();

        self.pending_drag_seen = true;
        self.pending_drag_max_distance = self.pending_drag_max_distance.max(distance);
    }

    fn handle_mouse_up(&mut self, event: &Event, keyboard: &KeyboardProcessor) -> Option<Event> {
        let mouse_down = self.pending_mouse_down.take()?;
        let drag_seen = self.pending_drag_seen;
        let drag_max_distance = self.pending_drag_max_distance;
        self.pending_drag_seen = false;
        self.pending_drag_max_distance = 0.0;
        let ts = timestamp_or_now(event);
        let up_data = data_obj(event);
        let down_data = data_obj(&mouse_down);

        let start_x = down_data.and_then(|d| get_f64(d, "x")).unwrap_or(0.0);
        let start_y = down_data.and_then(|d| get_f64(d, "y")).unwrap_or(0.0);
        let current_x = up_data.and_then(|d| get_f64(d, "x")).unwrap_or(start_x);
        let current_y = up_data.and_then(|d| get_f64(d, "y")).unwrap_or(start_y);
        let display_id =
            get_u64(down_data, "display_id").or_else(|| get_u64(up_data, "display_id"));
        let distance = ((current_x - start_x).powi(2) + (current_y - start_y).powi(2)).sqrt();
        let down_ts = timestamp_or_now(&mouse_down);
        let down_button = down_data
            .and_then(|d| get_str(d, "button"))
            .unwrap_or("left")
            .to_string();

        let modifiers = keyboard.sorted_active_modifiers();

        if distance < Self::DRAG_THRESHOLD {
            if drag_seen && drag_max_distance >= Self::ZERO_NET_DRAG_SUPPRESS_THRESHOLD {
                return self.flush_pending_click();
            }
            let mut action_to_return = None;
            if let Some(pending) = self.pending_click.as_mut() {
                if ts - pending.last_ts <= Self::CLICK_THRESHOLD {
                    let click_dist =
                        ((start_x - pending.x).powi(2) + (start_y - pending.y).powi(2)).sqrt();
                    if down_button == pending.button
                        && display_id == pending.display_id
                        && click_dist < Self::DRAG_THRESHOLD
                    {
                        pending.click_count += 1;
                        pending.last_ts = ts;
                        return None;
                    }
                    action_to_return = self.flush_pending_click();
                }
            }
            self.pending_click = Some(PendingClick {
                start_ts: down_ts,
                last_ts: ts,
                x: start_x,
                y: start_y,
                button: down_button,
                click_count: 1,
                modifiers,
                display_id,
            });
            action_to_return
        } else {
            let _ = self.flush_pending_click();
            Some(create_drag_event(
                start_x,
                start_y,
                current_x,
                current_y,
                Self::DRAG_DURATION,
                &down_button,
                ts,
                down_ts,
                modifiers,
                display_id,
            ))
        }
    }

    fn flush_pending_click(&mut self) -> Option<Event> {
        let click = self.pending_click.take()?;
        Some(create_click_event(
            click.x,
            click.y,
            &click.button,
            click.click_count,
            click.last_ts,
            Some(click.start_ts),
            click.modifiers,
            click.display_id,
        ))
    }

    fn flush_pending_click_if_stale(&mut self, ts: f64) -> Option<Event> {
        if self
            .pending_click
            .as_ref()
            .map(|click| ts - click.last_ts > Self::CLICK_THRESHOLD)
            .unwrap_or(false)
        {
            self.flush_pending_click()
        } else {
            None
        }
    }

    fn flush(&mut self) -> Vec<Event> {
        let mut result = Vec::new();
        if let Some(action) = self.flush_pending_click() {
            result.push(action);
        }
        self.pending_mouse_down = None;
        self.pending_drag_seen = false;
        self.pending_drag_max_distance = 0.0;
        result
    }
}

#[derive(Debug, Clone)]
struct PendingHotkey {
    timestamp: f64,
    last_ts: f64,
    keys: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingRepeatPress {
    key: String,
    diagnostic_args: Option<Map<String, Value>>,
    count: i64,
    start_ts: f64,
    last_ts: f64,
    key_is_down: bool,
    auto_repeating: bool,
}

#[derive(Debug)]
struct KeyboardProcessor {
    typing_buffer: Vec<String>,
    first_type_time: Option<f64>,
    last_type_time: f64,
    active_modifiers: HashSet<String>,
    active_modifier_timestamps: HashMap<String, f64>,
    pending_hotkey: Option<PendingHotkey>,
    capslock_on: bool,
    pending_repeat_press: Option<PendingRepeatPress>,
}

impl KeyboardProcessor {
    const TYPE_THRESHOLD: f64 = 2.0;
    const EDIT_BACKSPACE_THRESHOLD: f64 = 0.8;
    const HOTKEY_THRESHOLD: f64 = 0.5;
    const REPEAT_THRESHOLD: f64 = 0.3;
    const INITIAL_HELD_REPEAT_THRESHOLD: f64 = 0.75;

    fn new() -> Self {
        Self {
            typing_buffer: Vec::new(),
            first_type_time: None,
            last_type_time: 0.0,
            active_modifiers: HashSet::new(),
            active_modifier_timestamps: HashMap::new(),
            pending_hotkey: None,
            capslock_on: false,
            pending_repeat_press: None,
        }
    }

    fn sorted_active_modifiers(&self) -> Vec<String> {
        let mut modifiers = self.active_modifiers.iter().cloned().collect::<Vec<_>>();
        modifiers.sort();
        modifiers
    }

    fn hotkey_start_timestamp(&self, fallback_ts: f64) -> f64 {
        self.active_modifiers
            .iter()
            .filter(|modifier| modifier.as_str() != "shift")
            .filter_map(|modifier| self.active_modifier_timestamps.get(modifier))
            .copied()
            .min_by(|a, b| a.total_cmp(b))
            .unwrap_or(fallback_ts)
    }

    fn process(&mut self, event: &Event) -> Vec<Event> {
        match event_type(event) {
            Some("key_down") => self.handle_key_down(event),
            Some("key_up") => self.handle_key_up(event),
            Some(_) | None => {
                let mut out = Vec::new();
                if let Some(action) = self.flush_typing_buffer() {
                    out.push(action);
                }
                if let Some(action) = self.flush_pending_repeat_press() {
                    out.push(action);
                }
                out
            }
        }
    }

    fn handle_key_down(&mut self, event: &Event) -> Vec<Event> {
        let ts = timestamp_or_now(event);
        let data = data_obj(event);
        let key = key_name_from_event_data(data);
        let mut key_lower = key.to_lowercase();
        let mut out = Vec::new();

        if self
            .pending_hotkey
            .as_ref()
            .map(|hotkey| ts - hotkey.last_ts > Self::HOTKEY_THRESHOLD)
            .unwrap_or(false)
        {
            if let Some(action) = self.flush_pending_hotkey() {
                out.push(action);
            }
        }

        if is_modifier_key(&key_lower) {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            if let Some(action) = self.flush_pending_repeat_press() {
                out.push(action);
            }
            self.active_modifier_timestamps
                .entry(key_lower.clone())
                .or_insert(ts);
            self.active_modifiers.insert(key_lower);
            return out;
        }

        if key_lower == "capslock" {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            if let Some(action) = self.flush_pending_repeat_press() {
                out.push(action);
            }
            let observed_lock_on = lock_state_from_event_data(data);
            // Older raw traces did not include lock state. Keep the legacy
            // toggle for following text normalization, but only expose ON/OFF
            // when the raw event carries observed OS state.
            self.capslock_on = observed_lock_on.unwrap_or(!self.capslock_on);
            out.push(create_lock_press_event(&key, ts, observed_lock_on));
            return out;
        }

        if self
            .active_modifiers
            .iter()
            .any(|modifier| modifier != "shift")
        {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            if let Some(action) = self.flush_pending_repeat_press() {
                out.push(action);
            }
            let shift_active = self.active_modifiers.contains("shift");
            let normalized_key = map_control_char_for_hotkey(&key);
            let char_key = get_char_for_key(&normalized_key, shift_active, false);
            if let Some(pending) = self.pending_hotkey.as_mut() {
                if !pending.keys.contains(&char_key) {
                    pending.keys.push(char_key);
                }
                pending.last_ts = ts;
            } else {
                let mut modifiers = self
                    .active_modifiers
                    .iter()
                    .filter(|modifier| modifier.as_str() != "shift")
                    .cloned()
                    .collect::<Vec<_>>();
                if shift_active && char_key == normalized_key {
                    modifiers.push("shift".to_string());
                }
                modifiers.sort();
                let start_ts = self.hotkey_start_timestamp(ts);
                modifiers.push(char_key);
                self.pending_hotkey = Some(PendingHotkey {
                    timestamp: start_ts,
                    last_ts: ts,
                    keys: modifiers,
                });
            }
            return out;
        }

        let normalized_key = map_control_char(&key);
        if normalized_key != key {
            key_lower = normalized_key.to_lowercase();
        }

        if key_lower == "backspace" && self.fold_backspace_into_typing_buffer(ts) {
            return out;
        }

        if matches!(
            key_lower.as_str(),
            "backspace" | "delete" | "left" | "right" | "up" | "down"
        ) || unresolved_key_code(&key_lower).is_some()
        {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            if let Some(pending) = self.pending_repeat_press.as_mut() {
                let repeat_threshold = if pending.key_is_down && pending.count == 1 {
                    Self::INITIAL_HELD_REPEAT_THRESHOLD
                } else {
                    Self::REPEAT_THRESHOLD
                };
                if pending.key.eq_ignore_ascii_case(&normalized_key)
                    && ts - pending.last_ts <= repeat_threshold
                {
                    pending.count += 1;
                    pending.last_ts = ts;
                    pending.auto_repeating |= pending.key_is_down;
                    pending.key_is_down = true;
                    return out;
                }
            }
            if let Some(action) = self.flush_pending_repeat_press() {
                out.push(action);
            }
            self.pending_repeat_press = Some(PendingRepeatPress {
                key: normalized_key,
                diagnostic_args: key_press_diagnostic_args(data, &key_lower),
                count: 1,
                start_ts: ts,
                last_ts: ts,
                key_is_down: true,
                auto_repeating: false,
            });
            return out;
        }

        if let Some(action) = self.flush_pending_repeat_press() {
            out.push(action);
        }

        let shift_active = self.active_modifiers.contains("shift");
        if should_break_typing(&key_lower, &self.active_modifiers) {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            if let Some(diagnostic_args) = key_press_diagnostic_args(data, &key_lower) {
                out.push(create_press_event_with_start_and_extra_args(
                    &normalized_key,
                    ts,
                    1,
                    ts,
                    Some(diagnostic_args),
                ));
            } else {
                out.push(create_press_event(&normalized_key, ts, 1));
            }
        } else if !self.typing_buffer.is_empty() && ts - self.last_type_time > Self::TYPE_THRESHOLD
        {
            if let Some(action) = self.flush_typing_buffer() {
                out.push(action);
            }
            self.first_type_time = Some(ts);
            self.typing_buffer.push(get_char_for_key(
                &normalized_key,
                shift_active,
                self.capslock_on,
            ));
            self.last_type_time = ts;
        } else {
            if self.typing_buffer.is_empty() {
                self.first_type_time = Some(ts);
            }
            self.typing_buffer.push(get_char_for_key(
                &normalized_key,
                shift_active,
                self.capslock_on,
            ));
            self.last_type_time = ts;
        }

        out
    }

    fn fold_backspace_into_typing_buffer(&mut self, ts: f64) -> bool {
        if self.typing_buffer.is_empty()
            || self.last_type_time == 0.0
            || ts - self.last_type_time > Self::EDIT_BACKSPACE_THRESHOLD
        {
            return false;
        }

        self.typing_buffer.pop();
        if self.typing_buffer.is_empty() {
            self.first_type_time = None;
            self.last_type_time = 0.0;
        } else {
            self.last_type_time = ts;
        }
        true
    }

    fn handle_key_up(&mut self, event: &Event) -> Vec<Event> {
        let data = data_obj(event);
        let raw_key = key_name_from_event_data(data);
        let key = map_control_char(&raw_key).to_lowercase();
        let mut out = Vec::new();

        if is_modifier_key(&key) {
            self.active_modifiers.remove(&key);
            self.active_modifier_timestamps.remove(&key);
            if !self
                .active_modifiers
                .iter()
                .any(|modifier| modifier != "shift")
                && self.pending_hotkey.is_some()
            {
                if let Some(action) = self.flush_pending_repeat_press() {
                    out.push(action);
                }
                if let Some(action) = self.flush_typing_buffer() {
                    out.push(action);
                }
                if let Some(action) = self.flush_pending_hotkey() {
                    out.push(action);
                }
            }
        } else {
            if self.pending_hotkey.is_some() {
                if let Some(action) = self.flush_pending_repeat_press() {
                    out.push(action);
                }
                if let Some(action) = self.flush_typing_buffer() {
                    out.push(action);
                }
                if let Some(action) = self.flush_pending_hotkey() {
                    out.push(action);
                }
            }
            let should_flush_repeat = if let Some(pending) = self.pending_repeat_press.as_mut() {
                if pending.key.eq_ignore_ascii_case(&key) {
                    pending.key_is_down = false;
                    pending.auto_repeating
                } else {
                    false
                }
            } else {
                false
            };
            if should_flush_repeat {
                if let Some(action) = self.flush_pending_repeat_press() {
                    out.push(action);
                }
            }
        }

        out
    }

    fn flush_typing_buffer(&mut self) -> Option<Event> {
        if self.typing_buffer.is_empty() {
            return None;
        }
        let text = self.typing_buffer.join("");
        let action = create_typewrite_event(text, 0.1, self.last_type_time, self.first_type_time);
        self.typing_buffer.clear();
        self.last_type_time = 0.0;
        self.first_type_time = None;
        Some(action)
    }

    fn flush_pending_hotkey(&mut self) -> Option<Event> {
        let hotkey = self.pending_hotkey.take()?;
        Some(create_hotkey_event(
            hotkey.keys,
            hotkey.last_ts,
            hotkey.timestamp,
        ))
    }

    fn flush_pending_repeat_press(&mut self) -> Option<Event> {
        let pending = self.pending_repeat_press.take()?;
        let start_ts = if pending.auto_repeating {
            pending.start_ts
        } else {
            pending.last_ts
        };
        Some(create_press_event_with_start_and_extra_args(
            &pending.key,
            pending.last_ts,
            pending.count,
            start_ts,
            pending.diagnostic_args,
        ))
    }

    fn flush(&mut self) -> Vec<Event> {
        let mut out = Vec::new();
        if let Some(action) = self.flush_pending_repeat_press() {
            out.push(action);
        }
        if let Some(action) = self.flush_typing_buffer() {
            out.push(action);
        }
        if let Some(action) = self.flush_pending_hotkey() {
            out.push(action);
        }
        out
    }
}

#[derive(Debug, Clone)]
struct PendingScroll {
    timestamp: f64,
    last_ts: f64,
    x: f64,
    y: f64,
    cumulative_clicks: i64,
    display_id: Option<u64>,
}

#[derive(Debug, Default)]
struct ScrollProcessor {
    pending_scroll: Option<PendingScroll>,
}

fn same_scroll_direction(existing_clicks: i64, next_clicks: i64) -> bool {
    existing_clicks == 0 || next_clicks == 0 || existing_clicks.signum() == next_clicks.signum()
}

impl ScrollProcessor {
    const SCROLL_SESSION_GAP_THRESHOLD: f64 = 0.75;
    const SCROLL_SESSION_MAX_DURATION: f64 = 2.0;

    fn process(&mut self, event: &Event) -> Vec<Event> {
        if event_type(event) != Some("mouse_scroll") {
            return self.flush();
        }
        let ts = timestamp_or_now(event);
        let data = data_obj(event);
        let x = data.and_then(|d| get_f64(d, "x")).unwrap_or(0.0);
        let y = data.and_then(|d| get_f64(d, "y")).unwrap_or(0.0);
        let display_id = get_u64(data, "display_id");
        let clicks = data
            .and_then(|d| d.get("clicks"))
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0);

        if let Some(pending) = self.pending_scroll.as_mut() {
            let gap = ts - pending.last_ts;
            let session_duration = ts - pending.timestamp;
            if gap <= Self::SCROLL_SESSION_GAP_THRESHOLD
                && session_duration <= Self::SCROLL_SESSION_MAX_DURATION
                && pending.display_id == display_id
                && same_scroll_direction(pending.cumulative_clicks, clicks)
            {
                pending.cumulative_clicks += clicks;
                pending.last_ts = ts;
                return Vec::new();
            }
            let action = self.flush();
            self.pending_scroll = Some(PendingScroll {
                timestamp: ts,
                last_ts: ts,
                x,
                y,
                cumulative_clicks: clicks,
                display_id,
            });
            return action;
        }

        self.pending_scroll = Some(PendingScroll {
            timestamp: ts,
            last_ts: ts,
            x,
            y,
            cumulative_clicks: clicks,
            display_id,
        });
        Vec::new()
    }

    fn flush(&mut self) -> Vec<Event> {
        let Some(scroll) = self.pending_scroll.take() else {
            return Vec::new();
        };
        vec![create_scroll_event(
            scroll.cumulative_clicks,
            scroll.x,
            scroll.y,
            scroll.last_ts,
            scroll.timestamp,
            scroll.display_id,
        )]
    }
}

pub struct ProcessingPipeline {
    screenshot_manager: ScreenshotManager,
    preprocessed_writer: Option<StreamingJsonlinesWriter>,
    a11y_writer: Option<StreamingJsonlinesWriter>,
    a11y_hash_acceptor: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pending_action: Option<Event>,
    last_event_timestamp: f64,
    last_non_sleep_action_timestamp: Option<f64>,
    last_processed_screenshot_visual: Option<ProcessedScreenshotVisual>,
    idle_visual_snapshot_active: bool,
    first_screenshot_written: bool,
    keyboard_processor: KeyboardProcessor,
    mouse_move_processor: MouseMoveProcessor,
    mouse_click_processor: MouseClickProcessor,
    scroll_processor: ScrollProcessor,
    recent_actions: VecDeque<(String, f64)>,
}

impl ProcessingPipeline {
    const SCREENSHOT_TIMESTAMP_THRESHOLD: f64 = 0.02;
    const PRE_ACTION_SCREENSHOT_MIN_GAP: f64 = 0.15;
    const SLEEP_GAP_THRESHOLD: f64 = 2.5;
    const PRE_ACTION_CONTEXT_GAP_THRESHOLD: f64 = 2.0;
    const STALE_ACTION_THRESHOLD: f64 = 2.5;
    const FIRST_IDLE_VISUAL_SNAPSHOT_GAP: f64 = 5.0;
    const NEXT_IDLE_VISUAL_SNAPSHOT_GAP: f64 = 10.0;

    pub fn new(
        preprocessed_writer: Option<StreamingJsonlinesWriter>,
        a11y_writer: Option<StreamingJsonlinesWriter>,
    ) -> Self {
        Self::new_with_a11y_hash_acceptor(preprocessed_writer, a11y_writer, None)
    }

    pub fn new_with_a11y_hash_acceptor(
        preprocessed_writer: Option<StreamingJsonlinesWriter>,
        a11y_writer: Option<StreamingJsonlinesWriter>,
        a11y_hash_acceptor: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> Self {
        Self {
            screenshot_manager: ScreenshotManager::new(50),
            preprocessed_writer,
            a11y_writer,
            a11y_hash_acceptor,
            pending_action: None,
            last_event_timestamp: 0.0,
            last_non_sleep_action_timestamp: None,
            last_processed_screenshot_visual: None,
            idle_visual_snapshot_active: false,
            first_screenshot_written: false,
            keyboard_processor: KeyboardProcessor::new(),
            mouse_move_processor: MouseMoveProcessor::default(),
            mouse_click_processor: MouseClickProcessor::new(),
            scroll_processor: ScrollProcessor::default(),
            recent_actions: VecDeque::with_capacity(30),
        }
    }

    pub fn process_event(&mut self, event: Event) -> Result<()> {
        let event_kind = event_type(&event).map(str::to_string);
        let event_ts = timestamp_or_now(&event);
        if self.pending_action.is_some() && Self::is_raw_action_boundary(event_kind.as_deref()) {
            self.finalize_pending_action(event_ts)?;
        }

        match event_type(&event) {
            Some("screenshot") => self.handle_screenshot(event),
            Some("a11y+screenshot") => self.handle_a11y_screenshot(event),
            Some("mouse_move") => {
                self.mouse_click_processor.observe_mouse_move(&event);
                self.mouse_move_processor.process(&event);
                Ok(())
            }
            _ => {
                let mut actions = Vec::new();
                if event_kind.as_deref() != Some("mouse_scroll") {
                    actions.extend(self.scroll_processor.process(&event));
                }
                if matches!(event_kind.as_deref(), Some("mouse_down" | "mouse_up")) {
                    actions.extend(self.keyboard_processor.process(&event));
                }
                actions.extend(
                    self.mouse_click_processor
                        .process(&event, &self.keyboard_processor),
                );
                if !matches!(event_kind.as_deref(), Some("mouse_down" | "mouse_up")) {
                    actions.extend(self.keyboard_processor.process(&event));
                    if event_kind.as_deref() == Some("mouse_scroll") {
                        actions.extend(self.scroll_processor.process(&event));
                    }
                }
                for action in actions {
                    self.queue_action(action)?;
                }
                if Self::is_raw_action_boundary(event_kind.as_deref()) {
                    let pending_ends_before_boundary = self
                        .pending_action
                        .as_ref()
                        .and_then(|action| action.get("timestamp").and_then(Value::as_f64))
                        .map(|action_ts| action_ts < event_ts)
                        .unwrap_or(false);
                    if pending_ends_before_boundary {
                        self.finalize_pending_action(event_ts)?;
                    }
                }
                Ok(())
            }
        }
    }

    fn write_processed_screenshot(
        &mut self,
        source: &Event,
        idle_visual_snapshot: bool,
    ) -> Result<()> {
        let Some(writer) = self.preprocessed_writer.as_mut() else {
            return Ok(());
        };
        let screenshot_event = create_screenshot_event(source);
        let screenshot_ts = screenshot_event
            .get("timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(self.last_event_timestamp);
        writer.write(screenshot_event)?;
        self.last_event_timestamp = screenshot_ts;
        self.last_processed_screenshot_visual = ProcessedScreenshotVisual::from_event(source);
        self.idle_visual_snapshot_active = idle_visual_snapshot;
        Ok(())
    }

    fn maybe_emit_idle_visual_snapshot(&mut self, event: &Event, ts: f64) -> Result<()> {
        if self.preprocessed_writer.is_none()
            || !self.first_screenshot_written
            || self.pending_action.is_some()
            || self.last_event_timestamp == 0.0
        {
            return Ok(());
        }

        let required_gap = if self.idle_visual_snapshot_active {
            Self::NEXT_IDLE_VISUAL_SNAPSHOT_GAP
        } else {
            Self::FIRST_IDLE_VISUAL_SNAPSHOT_GAP
        };
        let sleep_gap = ts - self.last_event_timestamp;
        if sleep_gap < required_gap {
            return Ok(());
        }

        let Some(last_visual) = self.last_processed_screenshot_visual.as_ref() else {
            return Ok(());
        };
        if !last_visual
            .changed_from_event(event, ScreenshotManager::DELAYED_VISUAL_CHANGE_THRESHOLD)
        {
            return Ok(());
        }

        let sleep_event_ts = self.last_event_timestamp + 0.01;
        let sleep_event = create_sleep_event(sleep_gap.floor().max(1.0) as i64, sleep_event_ts);
        if let Some(writer) = self.preprocessed_writer.as_mut() {
            writer.write(sleep_event)?;
        }
        self.last_event_timestamp = sleep_event_ts;
        self.write_processed_screenshot(event, true)?;
        self.screenshot_manager.mark_as_used(event);
        Ok(())
    }

    fn handle_screenshot(&mut self, event: Event) -> Result<()> {
        let ts = event
            .get("timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let mut saw_action_context = self.pending_action.is_some();
        if let Some(action) = self.mouse_click_processor.flush_pending_click_if_stale(ts) {
            self.queue_action(action)?;
            saw_action_context = true;
        }
        if !self.first_screenshot_written {
            if self.preprocessed_writer.is_some() {
                self.write_processed_screenshot(&event, false)?;
                self.first_screenshot_written = true;
                self.screenshot_manager.mark_as_used(&event);
            }
        }
        if saw_action_context {
            self.screenshot_manager.handle_screenshot(event.clone());
        }
        if let Some(action) = &self.pending_action {
            saw_action_context = true;
            let pending_ts = action
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or(ts);
            if ts - pending_ts > Self::STALE_ACTION_THRESHOLD && Self::is_high_level_action(action)
            {
                self.finalize_pending_action(f64::INFINITY)?;
            }
        }
        if !saw_action_context {
            self.maybe_emit_idle_visual_snapshot(&event, ts)?;
            self.screenshot_manager.handle_screenshot(event);
        }
        Ok(())
    }

    fn handle_a11y_screenshot(&mut self, event: Event) -> Result<()> {
        let event_timestamp = event
            .get("timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let end_timestamp = event
            .get("end_timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(event_timestamp + 1.0);
        if self.has_actions_in_interval(event_timestamp - 0.5, end_timestamp + 0.5) {
            return Ok(());
        }
        let accepted_hash = event
            .get("event_screenshot_hash")
            .and_then(a11y_hash_value_to_string);
        if let Some(writer) = self.a11y_writer.as_mut() {
            let mut clean_event = event;
            if let Some(object) = clean_event.as_object_mut() {
                object.remove("event_screenshot_hash");
            }
            writer.write(clean_event)?;
            if let (Some(acceptor), Some(hash)) = (&self.a11y_hash_acceptor, accepted_hash) {
                acceptor(hash);
            }
        }
        Ok(())
    }

    fn is_high_level_action(action: &Event) -> bool {
        matches!(
            event_type(action),
            Some("click" | "drag" | "hotkey" | "scroll" | "typewrite" | "sleep" | "press")
        )
    }

    fn is_raw_action_boundary(event_kind: Option<&str>) -> bool {
        matches!(event_kind, Some("mouse_down" | "key_down" | "mouse_scroll"))
    }

    fn queue_action(&mut self, action: Event) -> Result<()> {
        let action_type = event_type(&action).unwrap_or("").to_lowercase();
        if Self::is_high_level_action(&action) {
            let ts = action
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or_default();
            if self.recent_actions.len() == 30 {
                self.recent_actions.pop_front();
            }
            self.recent_actions.push_back((action_type, ts));
        }

        if self.pending_action.is_some() && Self::is_high_level_action(&action) {
            let next_start = action
                .get("start_timestamp")
                .and_then(Value::as_f64)
                .or_else(|| action.get("timestamp").and_then(Value::as_f64))
                .unwrap_or(f64::INFINITY);
            self.finalize_pending_action(next_start)?;
        }

        if Self::is_high_level_action(&action) {
            self.pending_action = Some(action);
        }
        Ok(())
    }

    fn finalize_pending_action(&mut self, t_next: f64) -> Result<()> {
        let Some(action) = self.pending_action.take() else {
            return Ok(());
        };
        if !Self::is_high_level_action(&action) || event_type(&action) == Some("moveto") {
            return Ok(());
        }

        if self.screenshot_manager.buffer.is_empty() {
            if let Some(writer) = self.preprocessed_writer.as_mut() {
                writer.write(action.clone())?;
                self.last_event_timestamp = action
                    .get("timestamp")
                    .and_then(Value::as_f64)
                    .unwrap_or(self.last_event_timestamp);
                if event_type(&action) != Some("sleep") {
                    self.last_non_sleep_action_timestamp = Some(self.last_event_timestamp);
                }
                self.idle_visual_snapshot_active = false;
            }
            return Ok(());
        }

        let candidate = self.screenshot_manager.assign_screenshot(
            &action,
            t_next,
            Self::SCREENSHOT_TIMESTAMP_THRESHOLD,
        );

        self.insert_sleep_if_needed(&action)?;

        if let Some(writer) = self.preprocessed_writer.as_mut() {
            writer.write(action.clone())?;
            self.last_event_timestamp = action
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or(self.last_event_timestamp);
            if event_type(&action) != Some("sleep") {
                self.last_non_sleep_action_timestamp = Some(self.last_event_timestamp);
            }
            self.idle_visual_snapshot_active = false;
        }
        if let Some(candidate) = candidate {
            self.write_processed_screenshot(&candidate, false)?;
        }
        Ok(())
    }

    fn insert_sleep_if_needed(&mut self, action: &Event) -> Result<()> {
        let t_current = action
            .get("timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let action_start_ts = action
            .get("start_timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(t_current);
        let sleep_screenshot_target_ts =
            if action.get("type").and_then(Value::as_str) == Some("click") {
                t_current
            } else {
                action_start_ts
            };
        if self.last_event_timestamp == 0.0 {
            return Ok(());
        }
        let sleep_gap = action_start_ts - self.last_event_timestamp;
        let idle_gap_after_last_action = self
            .last_non_sleep_action_timestamp
            .map(|last_action_ts| action_start_ts - last_action_ts)
            .unwrap_or(sleep_gap);
        let needs_sleep = sleep_gap > Self::SLEEP_GAP_THRESHOLD
            || (idle_gap_after_last_action > Self::SLEEP_GAP_THRESHOLD
                && sleep_gap > Self::PRE_ACTION_CONTEXT_GAP_THRESHOLD);
        if needs_sleep {
            let pre_action_min_gap = if action.get("type").and_then(Value::as_str) == Some("hotkey")
            {
                Self::PRE_ACTION_SCREENSHOT_MIN_GAP
            } else {
                Self::SCREENSHOT_TIMESTAMP_THRESHOLD
            };
            if let Some(sleep_screenshot) = self.screenshot_manager.find_closest_screenshot_before(
                sleep_screenshot_target_ts,
                self.last_event_timestamp,
                pre_action_min_gap,
            ) {
                let sleep_event_ts = self.last_event_timestamp + 0.01;
                let sleep_event =
                    create_sleep_event(sleep_gap.floor().max(1.0) as i64, sleep_event_ts);
                self.screenshot_manager.mark_as_used(&sleep_screenshot);
                if let Some(writer) = self.preprocessed_writer.as_mut() {
                    writer.write(sleep_event)?;
                    self.last_event_timestamp = sleep_event_ts;
                }
                self.write_processed_screenshot(&sleep_screenshot, false)?;
            }
        }
        Ok(())
    }

    fn has_actions_in_interval(&self, start_ts: f64, end_ts: f64) -> bool {
        self.recent_actions
            .iter()
            .any(|(action_type, ts)| *action_type != "sleep" && *ts >= start_ts && *ts <= end_ts)
    }

    pub fn flush(&mut self) -> Result<()> {
        let mut high_level_actions = Vec::new();
        high_level_actions.extend(self.mouse_move_processor.flush());
        high_level_actions.extend(self.mouse_click_processor.flush());
        high_level_actions.extend(self.keyboard_processor.flush());
        high_level_actions.extend(self.scroll_processor.flush());

        for action in high_level_actions {
            if Self::is_high_level_action(&action) {
                self.queue_action(action)?;
            }
        }
        if self.pending_action.is_some() {
            self.finalize_pending_action(f64::INFINITY)?;
        }
        if let Some(writer) = self.preprocessed_writer.as_mut() {
            writer.close()?;
        }
        if let Some(writer) = self.a11y_writer.as_mut() {
            writer.close()?;
        }
        Ok(())
    }

    pub fn flush_writers(&mut self) -> Result<()> {
        if let Some(writer) = self.preprocessed_writer.as_mut() {
            writer.flush(true)?;
        }
        if let Some(writer) = self.a11y_writer.as_mut() {
            writer.flush(true)?;
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct RealTimeEventProcessor {
    pipeline: Arc<Mutex<ProcessingPipeline>>,
}

impl std::fmt::Debug for RealTimeEventProcessor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RealTimeEventProcessor")
            .finish_non_exhaustive()
    }
}

impl RealTimeEventProcessor {
    pub fn new(
        preprocessed_writer: Option<StreamingJsonlinesWriter>,
        a11y_writer: Option<StreamingJsonlinesWriter>,
    ) -> Self {
        Self::new_with_a11y_hash_acceptor(preprocessed_writer, a11y_writer, None)
    }

    pub fn new_with_a11y_hash_acceptor(
        preprocessed_writer: Option<StreamingJsonlinesWriter>,
        a11y_writer: Option<StreamingJsonlinesWriter>,
        a11y_hash_acceptor: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> Self {
        Self {
            pipeline: Arc::new(Mutex::new(ProcessingPipeline::new_with_a11y_hash_acceptor(
                preprocessed_writer,
                a11y_writer,
                a11y_hash_acceptor,
            ))),
        }
    }

    pub fn add_event(&self, event: Event) -> Result<()> {
        self.pipeline.lock().process_event(event)
    }

    pub fn stop(&self) -> Result<()> {
        self.pipeline.lock().flush()
    }

    pub fn flush_writers(&self) -> Result<()> {
        self.pipeline.lock().flush_writers()
    }
}

/// Reprocess a raw JSONL recording into preprocessed JSONL using the same streaming
/// pipeline as live recording. Shared by the offline `kortix-process-raw` tool and by
/// abrupt-shutdown recovery, which regenerates a missing/empty preprocessed file from raw
/// so a segment killed before its writer flushed is still uploadable.
pub fn process_raw_to_preprocessed(
    input: &std::path::Path,
    output: &std::path::Path,
) -> Result<()> {
    use anyhow::Context;
    use std::{
        fs::File,
        io::{BufRead, BufReader},
    };
    let writer = StreamingJsonlinesWriter::new(output, 1000, true).open()?;
    let processor = crate::event_reorder::TimestampReorderedProcessor::new(
        RealTimeEventProcessor::new(Some(writer), None),
    );
    let raw = File::open(input).with_context(|| format!("failed to open {}", input.display()))?;
    for (idx, line) in BufReader::new(raw).lines().enumerate() {
        let line =
            line.with_context(|| format!("failed to read {}:{}", input.display(), idx + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Value>(&line)
            .with_context(|| format!("invalid JSON at {}:{}", input.display(), idx + 1))?;
        processor.add_event(event)?;
    }
    processor.stop()?;
    Ok(())
}

fn a11y_hash_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::streaming_writer::StreamingJsonlinesWriter;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn processor_groups_typing_and_attaches_screenshot() {
        let output = std::env::temp_dir().join(format!(
            "kortix_processor_test_{}_preprocessed.jsonl",
            Uuid::new_v4()
        ));
        let writer = StreamingJsonlinesWriter::new(&output, 100, true)
            .open()
            .expect("open writer");
        let processor = RealTimeEventProcessor::new(Some(writer), None);

        processor
            .add_event(json!({
                "type": "screenshot",
                "timestamp": 0.1,
                "data": { "image": "before", "width": 10, "height": 10, "encoding": "jpg" }
            }))
            .expect("first screenshot");
        processor
            .add_event(json!({ "type": "key_down", "timestamp": 0.2, "data": { "key": "h" } }))
            .expect("h down");
        processor
            .add_event(json!({ "type": "key_up", "timestamp": 0.21, "data": { "key": "h" } }))
            .expect("h up");
        processor
            .add_event(json!({ "type": "key_down", "timestamp": 0.3, "data": { "key": "i" } }))
            .expect("i down");
        processor
            .add_event(json!({ "type": "key_up", "timestamp": 0.31, "data": { "key": "i" } }))
            .expect("i up");
        processor
            .add_event(json!({
                "type": "screenshot",
                "timestamp": 0.7,
                "data": { "image": "after", "width": 10, "height": 10, "encoding": "jpg" }
            }))
            .expect("second screenshot");
        processor.stop().expect("stop processor");

        let events = StreamingJsonlinesWriter::read_jsonl(&output).expect("read output");
        let _ = std::fs::remove_file(&output);

        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], "screenshot");
        assert_eq!(events[1]["type"], "typewrite");
        assert_eq!(events[1]["args"]["text"], "hi");
        assert_eq!(events[2]["type"], "screenshot");
    }

    #[test]
    fn screenshot_manager_discards_old_buffer_and_used_entries() {
        let mut manager = ScreenshotManager::new(3);
        for idx in 0..5 {
            manager.add_screenshot(json!({
                "type": "screenshot",
                "timestamp": idx as f64,
                "data": { "image": format!("frame-{idx}") }
            }));
        }

        let buffered = manager
            .buffer
            .iter()
            .map(|event| event["timestamp"].as_f64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(buffered, vec![2.0, 3.0, 4.0]);

        for idx in 10..15 {
            manager.mark_as_used(&json!({
                "type": "screenshot",
                "timestamp": idx as f64,
                "data": { "image": format!("used-{idx}") }
            }));
        }

        assert_eq!(manager.used_screenshots.len(), 3);
        assert!(!manager.is_used(10.0));
        assert!(!manager.is_used(11.0));
        assert!(manager.is_used(12.0));
        assert!(manager.is_used(13.0));
        assert!(manager.is_used(14.0));
    }

    #[test]
    fn screenshot_manager_rejects_too_close_before_context_frames() {
        let mut manager = ScreenshotManager::new(5);
        manager.add_screenshot(json!({
            "type": "screenshot",
            "timestamp": 1.90,
            "data": { "image": "stable-before" }
        }));
        manager.add_screenshot(json!({
            "type": "screenshot",
            "timestamp": 1.995,
            "data": { "image": "too-close-before" }
        }));

        let selected = manager
            .find_closest_screenshot_before(2.0, 1.0, 0.02)
            .expect("select stable before frame");
        assert_eq!(selected["timestamp"], 1.90);
        assert_eq!(selected["data"]["image"], "stable-before");
    }

    #[test]
    fn processing_pipeline_keeps_recent_action_history_bounded() {
        let mut pipeline = ProcessingPipeline::new(None, None);

        for idx in 0..35 {
            pipeline
                .queue_action(create_press_event("enter", idx as f64, 1))
                .expect("queue action");
        }

        assert_eq!(pipeline.recent_actions.len(), 30);
        assert_eq!(pipeline.recent_actions.front().unwrap().1, 5.0);
        assert_eq!(pipeline.recent_actions.back().unwrap().1, 34.0);
    }
}
