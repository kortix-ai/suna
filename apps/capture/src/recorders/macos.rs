use super::{
    add_display_id, capture_and_encode_screenshot, lock_unpoisoned, sanitize_scale_factor,
    seconds_duration, EventCallback, NormalizedPosition, Recorder, ScreenBounds,
    ScreenshotCaptureMode,
};
use anyhow::{bail, Context, Result};
use cocoa::{
    appkit::NSEvent,
    base::{id, nil},
};
use core_foundation::{
    array::CFArray,
    base::{CFRelease, CFRetain, CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    string::{CFString, CFStringRef},
};
use core_graphics::{
    event::{CGEventFlags, CGEventType, EventField},
    geometry::{CGPoint, CGSize},
};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const AX_ERROR_SUCCESS: i32 = 0;
const AX_VALUE_TYPE_CGPOINT: u32 = 1;
const AX_VALUE_TYPE_CGSIZE: u32 = 2;

const CG_HID_EVENT_TAP: u32 = 0;
const CG_SESSION_EVENT_TAP: u32 = 1;
const CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const CG_EVENT_TAP_LISTEN_ONLY: u32 = 1;
const CG_EVENT_TYPE_SYSTEM_DEFINED: u32 = 14;
const NX_SUBTYPE_AUX_CONTROL_BUTTONS: i16 = 8;
const NX_SYSTEM_KEY_STATE_DOWN: i64 = 0x0a;
const NX_SYSTEM_KEY_STATE_UP: i64 = 0x0b;
const CG_EVENT_MASK: u64 = (1 << CGEventType::LeftMouseDown as u64)
    | (1 << CGEventType::LeftMouseUp as u64)
    | (1 << CGEventType::RightMouseDown as u64)
    | (1 << CGEventType::RightMouseUp as u64)
    | (1 << CGEventType::MouseMoved as u64)
    | (1 << CGEventType::LeftMouseDragged as u64)
    | (1 << CGEventType::RightMouseDragged as u64)
    | (1 << CGEventType::OtherMouseDown as u64)
    | (1 << CGEventType::OtherMouseUp as u64)
    | (1 << CGEventType::OtherMouseDragged as u64)
    | (1 << CGEventType::KeyDown as u64)
    | (1 << CGEventType::KeyUp as u64)
    | (1 << CGEventType::FlagsChanged as u64)
    | (1 << CGEventType::ScrollWheel as u64)
    | (1 << CG_EVENT_TYPE_SYSTEM_DEFINED as u64);

type AXUIElementRef = *mut c_void;
type AXValueRef = *mut c_void;
type CGEventRef = *mut c_void;
type CFMachPortRef = *mut c_void;
type CFRunLoopSourceRef = *mut c_void;
type CFRunLoopRef = *mut c_void;
type CFRunLoopMode = *const c_void;
type CGEventTapProxy = *mut c_void;

type EventTapCallback = unsafe extern "C" fn(
    proxy: CGEventTapProxy,
    event_type: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;

    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXValueGetValue(value: AXValueRef, value_type: u32, value_ptr: *mut c_void) -> bool;

    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: EventTapCallback,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        tap: CFMachPortRef,
        order: isize,
    ) -> CFRunLoopSourceRef;
    fn CFMachPortInvalidate(tap: CFMachPortRef);
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventCreate(source: *const c_void) -> CGEventRef;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;

    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFRunLoopMode);
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopRun();
    fn CFRunLoopStop(rl: CFRunLoopRef);
    static kCFRunLoopCommonModes: CFRunLoopMode;

    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGEventGetFlags(event: CGEventRef) -> CGEventFlags;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventKeyboardGetUnicodeString(
        event: CGEventRef,
        max_string_length: usize,
        actual_string_length: *mut usize,
        unicode_string: *mut u16,
    );
}

pub(super) struct MacosInputRecorder {
    callback: EventCallback,
    run_loop: Arc<Mutex<Option<usize>>>,
    thread: Option<JoinHandle<()>>,
}

impl MacosInputRecorder {
    pub(super) fn new(callback: EventCallback) -> Self {
        Self {
            callback,
            run_loop: Arc::new(Mutex::new(None)),
            thread: None,
        }
    }
}

impl Recorder for MacosInputRecorder {
    fn start(&mut self) -> Result<()> {
        if self.thread.is_some() {
            return Ok(());
        }

        // Check only. A background start must never show a macOS prompt: the
        // service retries every minute, and a prompting check would raise the
        // dialog each time. `kortix-capture permissions --request` (or the
        // host app's "Allow access") is the one path that asks.
        ensure_accessibility_permission(false)?;
        ensure_input_monitoring_permission(false)?;
        let bounds = ScreenBounds::detect().unwrap_or_else(|err| {
            tracing::warn!("failed to detect screen bounds for macOS input normalization: {err:#}");
            ScreenBounds::fallback()
        });
        let session = MacosInputSession::new(self.callback.clone(), bounds);
        let run_loop = self.run_loop.clone();
        let (ready_tx, ready_rx) = mpsc::channel();

        let thread = thread::Builder::new()
            .name("kortix-macos-input-listener".to_string())
            .spawn(move || run_input_tap(session, run_loop, ready_tx))
            .context("failed to spawn macOS input listener thread")?;

        match ready_rx
            .recv()
            .context("macOS input listener failed to report startup status")?
        {
            Ok(()) => {
                self.thread = Some(thread);
                Ok(())
            }
            Err(err) => {
                let _ = thread.join();
                bail!("{err}");
            }
        }
    }

    fn stop(&mut self) -> Result<()> {
        if let Some(raw_run_loop) = lock_unpoisoned(&self.run_loop).take() {
            unsafe { CFRunLoopStop(raw_run_loop as CFRunLoopRef) };
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }
}

struct MacosInputSession {
    callback: EventCallback,
    start_time: Instant,
    bounds: ScreenBounds,
    active_modifiers: BTreeSet<String>,
    key_down_times: HashMap<String, Instant>,
    pressed_buttons: HashSet<String>,
    last_position: NormalizedPosition,
}

impl MacosInputSession {
    fn new(callback: EventCallback, bounds: ScreenBounds) -> Self {
        Self {
            callback,
            start_time: Instant::now(),
            bounds,
            active_modifiers: BTreeSet::new(),
            key_down_times: HashMap::new(),
            pressed_buttons: HashSet::new(),
            last_position: NormalizedPosition::default(),
        }
    }

    fn event_from(&mut self, event_type: u32, event: CGEventRef) -> Vec<EventCallbackEvent> {
        let timestamp = self.start_time.elapsed().as_secs_f64();
        let mut events = Vec::new();
        let event = unsafe {
            match event_type {
                x if x == CGEventType::KeyDown as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.key_down_event(timestamp, event)
                }
                x if x == CGEventType::KeyUp as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.key_up_event(timestamp, event)
                }
                x if x == CGEventType::FlagsChanged as u32 => {
                    return self
                        .flags_changed_events(timestamp, event)
                        .into_iter()
                        .map(|event| (self.callback.clone(), event))
                        .collect();
                }
                x if x == CG_EVENT_TYPE_SYSTEM_DEFINED => {
                    return self
                        .system_defined_events(timestamp, event)
                        .into_iter()
                        .map(|event| (self.callback.clone(), event))
                        .collect();
                }
                x if x == CGEventType::LeftMouseDown as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_button_event(timestamp, event, "left", true)
                }
                x if x == CGEventType::LeftMouseUp as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_button_event(timestamp, event, "left", false)
                }
                x if x == CGEventType::RightMouseDown as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_button_event(timestamp, event, "right", true)
                }
                x if x == CGEventType::RightMouseUp as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_button_event(timestamp, event, "right", false)
                }
                x if x == CGEventType::OtherMouseDown as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    let button = other_mouse_button_name(event);
                    self.mouse_button_event(timestamp, event, &button, true)
                }
                x if x == CGEventType::OtherMouseUp as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    let button = other_mouse_button_name(event);
                    self.mouse_button_event(timestamp, event, &button, false)
                }
                x if matches!(
                    x,
                    y if y == CGEventType::MouseMoved as u32
                        || y == CGEventType::LeftMouseDragged as u32
                        || y == CGEventType::RightMouseDragged as u32
                        || y == CGEventType::OtherMouseDragged as u32
                ) =>
                {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_move_event(
                        timestamp,
                        event,
                        event_type == CGEventType::LeftMouseDragged as u32
                            || event_type == CGEventType::RightMouseDragged as u32
                            || event_type == CGEventType::OtherMouseDragged as u32,
                    )
                }
                x if x == CGEventType::ScrollWheel as u32 => {
                    events.extend(self.sync_modifier_state(timestamp, CGEventGetFlags(event)));
                    self.mouse_scroll_event(timestamp, event)
                }
                x if x == CGEventType::TapDisabledByTimeout as u32
                    || x == CGEventType::TapDisabledByUserInput as u32 =>
                {
                    return Vec::new();
                }
                _ => return Vec::new(),
            }
        };
        events.push(event);
        events
            .into_iter()
            .map(|event| (self.callback.clone(), event))
            .collect()
    }

    unsafe fn key_down_event(&mut self, timestamp: f64, event: CGEventRef) -> Value {
        let key_code = event_keycode(event);
        let flags = CGEventGetFlags(event);
        let key_name = macos_event_key_name(
            event,
            !prefer_physical_key_name_for_modified_key_down(flags),
        );
        let is_modifier = is_modifier_key_name(&key_name);
        let unresolved = key_name.starts_with("unknown_");
        if is_modifier {
            self.active_modifiers.insert(key_name.clone());
        }
        self.key_down_times.insert(key_name.clone(), Instant::now());

        json!({
            "type": "key_down",
            "timestamp": timestamp,
            "data": {
                "key": key_name,
                "key_code": key_code,
                "fn_active": flags.contains(CGEventFlags::CGEventFlagSecondaryFn),
                "unresolved": unresolved,
                "active_modifiers": self.active_modifiers_without_current_modifier(is_modifier, &key_name),
            }
        })
    }

    unsafe fn key_up_event(&mut self, timestamp: f64, event: CGEventRef) -> Value {
        let key_code = event_keycode(event);
        let flags = CGEventGetFlags(event);
        let key_name = macos_event_key_name(event, false);
        let unresolved = key_name.starts_with("unknown_");
        if is_modifier_key_name(&key_name) {
            self.active_modifiers.remove(&key_name);
        }
        let hold_duration = self
            .key_down_times
            .remove(&key_name)
            .map(|pressed_at| pressed_at.elapsed().as_secs_f64())
            .unwrap_or(0.0);

        json!({
            "type": "key_up",
            "timestamp": timestamp,
            "data": {
                "key": key_name,
                "key_code": key_code,
                "fn_active": flags.contains(CGEventFlags::CGEventFlagSecondaryFn),
                "unresolved": unresolved,
                "hold_duration": hold_duration,
                "active_modifiers": self.active_modifiers_list(),
            }
        })
    }

    unsafe fn flags_changed_events(&mut self, timestamp: f64, event: CGEventRef) -> Vec<Value> {
        let code = event_keycode(event);
        let Some(key_name) = macos_key_name_from_code(code).map(str::to_string) else {
            return Vec::new();
        };
        if key_name == "capslock" {
            let lock_on = CGEventGetFlags(event).contains(CGEventFlags::CGEventFlagAlphaShift);
            return vec![json!({
                "type": "key_down",
                "timestamp": timestamp,
                "data": {
                    "key": key_name,
                    "lock_on": lock_on,
                    "lock_state": if lock_on { "on" } else { "off" },
                    "active_modifiers": self.active_modifiers_list(),
                }
            })];
        }
        if !is_modifier_key_name(&key_name) {
            return Vec::new();
        }

        self.sync_modifier_state(timestamp, CGEventGetFlags(event))
    }

    unsafe fn system_defined_events(&mut self, timestamp: f64, event: CGEventRef) -> Vec<Value> {
        let ns_event = <id as NSEvent>::eventWithCGEvent_(nil, event);
        if ns_event == nil || (ns_event.subtype() as i16) != NX_SUBTYPE_AUX_CONTROL_BUTTONS {
            return Vec::new();
        }

        let data1 = ns_event.data1() as i64;
        let system_key_code = (data1 >> 16) & 0xffff;
        let system_key_state = (data1 >> 8) & 0xff;
        let Some(key_name) = nx_system_key_name(system_key_code).map(str::to_string) else {
            return Vec::new();
        };

        match system_key_state {
            NX_SYSTEM_KEY_STATE_DOWN => {
                self.key_down_times.insert(key_name.clone(), Instant::now());
                vec![json!({
                    "type": "key_down",
                    "timestamp": timestamp,
                    "data": {
                        "key": key_name,
                        "system_key_code": system_key_code,
                        "system_key_state": system_key_state,
                        "system_event": true,
                        "active_modifiers": self.active_modifiers_list(),
                    }
                })]
            }
            NX_SYSTEM_KEY_STATE_UP => {
                let hold_duration = self
                    .key_down_times
                    .remove(&key_name)
                    .map(|pressed_at| pressed_at.elapsed().as_secs_f64())
                    .unwrap_or(0.0);
                vec![json!({
                    "type": "key_up",
                    "timestamp": timestamp,
                    "data": {
                        "key": key_name,
                        "system_key_code": system_key_code,
                        "system_key_state": system_key_state,
                        "system_event": true,
                        "hold_duration": hold_duration,
                        "active_modifiers": self.active_modifiers_list(),
                    }
                })]
            }
            _ => Vec::new(),
        }
    }

    fn sync_modifier_state(&mut self, timestamp: f64, flags: CGEventFlags) -> Vec<Value> {
        let mut events = Vec::new();
        for key_name in ["ctrl", "shift", "alt", "command"] {
            let pressed = modifier_flag_is_set(key_name, flags);
            let active = self.active_modifiers.contains(key_name);
            match (pressed, active) {
                (true, false) => {
                    events.push(self.modifier_event(timestamp, key_name.to_string(), true))
                }
                (false, true) => {
                    events.push(self.modifier_event(timestamp, key_name.to_string(), false))
                }
                _ => {}
            }
        }
        events
    }

    fn modifier_event(&mut self, timestamp: f64, key_name: String, pressed: bool) -> Value {
        if pressed {
            self.active_modifiers.insert(key_name.clone());
            self.key_down_times.insert(key_name.clone(), Instant::now());
            json!({
                "type": "key_down",
                "timestamp": timestamp,
                "data": {
                    "key": key_name,
                    "active_modifiers": self.active_modifiers_without_current_modifier(true, &key_name),
                }
            })
        } else {
            self.active_modifiers.remove(&key_name);
            let hold_duration = self
                .key_down_times
                .remove(&key_name)
                .map(|pressed_at| pressed_at.elapsed().as_secs_f64())
                .unwrap_or(0.0);
            json!({
                "type": "key_up",
                "timestamp": timestamp,
                "data": {
                    "key": key_name,
                    "hold_duration": hold_duration,
                    "active_modifiers": self.active_modifiers_list(),
                }
            })
        }
    }

    unsafe fn mouse_move_event(
        &mut self,
        timestamp: f64,
        event: CGEventRef,
        drag_event: bool,
    ) -> Value {
        let position = self.event_position(event);
        self.last_position = position;
        let mut data = json!({
            "x": position.x,
            "y": position.y,
            "is_dragging": drag_event || !self.pressed_buttons.is_empty(),
        });
        add_display_id(&mut data, position.display_id);

        json!({
            "type": "mouse_move",
            "timestamp": timestamp,
            "data": data,
        })
    }

    unsafe fn mouse_button_event(
        &mut self,
        timestamp: f64,
        event: CGEventRef,
        button: &str,
        pressed: bool,
    ) -> Value {
        let position = self.event_position(event);
        self.last_position = position;

        if pressed {
            self.pressed_buttons.insert(button.to_string());
        } else {
            self.pressed_buttons.remove(button);
        }

        let event_type = if pressed { "mouse_down" } else { "mouse_up" };
        let click_count =
            CGEventGetIntegerValueField(event, EventField::MOUSE_EVENT_CLICK_STATE).max(1);
        let mut data = json!({
            "x": position.x,
            "y": position.y,
            "button": button,
            "click_count": click_count,
            "active_modifiers": self.active_modifiers_list(),
        });
        add_display_id(&mut data, position.display_id);

        json!({
            "type": event_type,
            "timestamp": timestamp,
            "data": data,
        })
    }

    unsafe fn mouse_scroll_event(&mut self, timestamp: f64, event: CGEventRef) -> Value {
        let position = self.event_position(event);
        self.last_position = position;
        let delta_y = scroll_axis_delta(event, 1);
        let delta_x = scroll_axis_delta(event, 2);
        let clicks = if delta_y != 0 { delta_y } else { delta_x };

        let mut data = json!({
            "x": position.x,
            "y": position.y,
            "clicks": clicks,
            "active_modifiers": self.active_modifiers_list(),
        });
        add_display_id(&mut data, position.display_id);

        json!({
            "type": "mouse_scroll",
            "timestamp": timestamp,
            "data": data,
        })
    }

    unsafe fn event_position(&self, event: CGEventRef) -> NormalizedPosition {
        let point = CGEventGetLocation(event);
        self.bounds.normalize_position(point.x, point.y)
    }

    fn active_modifiers_without_current_modifier(
        &self,
        is_modifier: bool,
        key_name: &str,
    ) -> Vec<String> {
        self.active_modifiers
            .iter()
            .filter(|modifier| !(is_modifier && modifier.as_str() == key_name))
            .cloned()
            .collect()
    }

    fn active_modifiers_list(&self) -> Vec<String> {
        self.active_modifiers.iter().cloned().collect()
    }
}

type EventCallbackEvent = (EventCallback, Value);

struct InputTapState {
    session: Mutex<MacosInputSession>,
    tap: AtomicUsize,
}

unsafe extern "C" fn input_tap_callback(
    _proxy: CGEventTapProxy,
    event_type: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef {
    if user_info.is_null() || event.is_null() {
        return event;
    }

    let state = &*(user_info as *const InputTapState);
    if event_type == CGEventType::TapDisabledByTimeout as u32
        || event_type == CGEventType::TapDisabledByUserInput as u32
    {
        let tap = state.tap.load(Ordering::SeqCst);
        if tap != 0 {
            CGEventTapEnable(tap as CFMachPortRef, true);
        }
        return event;
    }

    let pending_events = {
        let mut session = lock_unpoisoned(&state.session);
        session.event_from(event_type, event)
    };
    for (callback, event) in pending_events {
        callback(event);
    }
    event
}

fn run_input_tap(
    session: MacosInputSession,
    run_loop: Arc<Mutex<Option<usize>>>,
    ready_tx: mpsc::Sender<Result<(), String>>,
) {
    unsafe {
        let state = Box::new(InputTapState {
            session: Mutex::new(session),
            tap: AtomicUsize::new(0),
        });
        let user_info = Box::into_raw(state) as *mut c_void;
        let mut tap_location = CG_HID_EVENT_TAP;
        let mut tap = CGEventTapCreate(
            tap_location,
            CG_HEAD_INSERT_EVENT_TAP,
            CG_EVENT_TAP_LISTEN_ONLY,
            CG_EVENT_MASK,
            input_tap_callback,
            user_info,
        );
        if tap.is_null() {
            tracing::info!("macOS HID input event tap unavailable; falling back to session tap");
            tap_location = CG_SESSION_EVENT_TAP;
            tap = CGEventTapCreate(
                tap_location,
                CG_HEAD_INSERT_EVENT_TAP,
                CG_EVENT_TAP_LISTEN_ONLY,
                CG_EVENT_MASK,
                input_tap_callback,
                user_info,
            );
        }
        if tap.is_null() {
            drop(Box::from_raw(user_info as *mut InputTapState));
            let _ = ready_tx.send(Err(
                "macOS input event tap could not be created; grant Accessibility and Input Monitoring permissions to the Kortix binary or launching terminal, then retry".to_string(),
            ));
            return;
        }
        (*(user_info as *const InputTapState))
            .tap
            .store(tap as usize, Ordering::SeqCst);

        let source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
        if source.is_null() {
            CFMachPortInvalidate(tap);
            CFRelease(tap as CFTypeRef);
            drop(Box::from_raw(user_info as *mut InputTapState));
            let _ = ready_tx.send(Err(
                "macOS input event tap run-loop source could not be created".to_string(),
            ));
            return;
        }

        let current_loop = CFRunLoopGetCurrent();
        *lock_unpoisoned(&run_loop) = Some(current_loop as usize);
        CFRunLoopAddSource(current_loop, source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        tracing::info!(tap_location, "started macOS input event tap");
        let _ = ready_tx.send(Ok(()));
        CFRunLoopRun();

        *lock_unpoisoned(&run_loop) = None;
        CFMachPortInvalidate(tap);
        CFRelease(source as CFTypeRef);
        CFRelease(tap as CFTypeRef);
        drop(Box::from_raw(user_info as *mut InputTapState));
    }
}

pub(super) struct MacosA11yRecorder {
    callback: EventCallback,
    interval: Duration,
    max_depth: u32,
    max_children: usize,
    scale_factor: f64,
    quality: u32,
    capture_mode: ScreenshotCaptureMode,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MacosA11yRecorder {
    pub(super) fn new(
        callback: EventCallback,
        interval_seconds: f64,
        max_depth: u32,
        max_children: usize,
        scale_factor: f64,
        quality: u32,
        capture_mode: ScreenshotCaptureMode,
    ) -> Self {
        Self {
            callback,
            interval: seconds_duration(interval_seconds, 10.0),
            max_depth,
            max_children,
            scale_factor,
            quality,
            capture_mode,
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

impl Recorder for MacosA11yRecorder {
    fn start(&mut self) -> Result<()> {
        if self.thread.is_some() {
            return Ok(());
        }

        ensure_accessibility_permission(false)?;
        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let callback = self.callback.clone();
        let interval = self.interval;
        let max_depth = self.max_depth;
        let max_children = self.max_children;
        let scale_factor = sanitize_scale_factor(self.scale_factor);
        let quality = self.quality.clamp(1, 100) as u8;
        let capture_mode = self.capture_mode;

        self.thread = Some(
            thread::Builder::new()
                .name("kortix-macos-a11y-recorder".to_string())
                .spawn(move || {
                    let start = Instant::now();
                    while running.load(Ordering::SeqCst) {
                        let capture_started = Instant::now();
                        let ts = start.elapsed().as_secs_f64();
                        match capture_a11y_screenshot_event(
                            ts,
                            &start,
                            max_depth,
                            max_children,
                            scale_factor,
                            quality,
                            capture_mode,
                        ) {
                            Ok(Some(event)) => callback(event),
                            Ok(None) => {}
                            Err(err) => tracing::warn!(
                                "failed to capture macOS accessibility snapshot: {err:#}"
                            ),
                        }

                        while running.load(Ordering::SeqCst) {
                            let elapsed = capture_started.elapsed();
                            if elapsed >= interval {
                                break;
                            }
                            thread::sleep((interval - elapsed).min(Duration::from_millis(100)));
                        }
                    }
                })
                .context("failed to spawn macOS accessibility recorder thread")?,
        );

        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }
}

pub(super) fn pointer_location() -> Option<(f64, f64)> {
    unsafe {
        let event = CGEventCreate(ptr::null());
        if event.is_null() {
            return None;
        }

        let point = CGEventGetLocation(event);
        release_cf(event);
        Some((point.x, point.y))
    }
}

pub(super) fn focused_window_center() -> Option<(f64, f64)> {
    if !accessibility_trusted(false) {
        return None;
    }

    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }

        let result = focused_window_center_from_system(system);
        release_cf(system);
        result
    }
}

unsafe fn focused_window_center_from_system(system: AXUIElementRef) -> Option<(f64, f64)> {
    let focused = get_element_attribute(system, "AXFocusedUIElement")?;
    let mut result = None;

    if let Some(pid) = get_pid(focused) {
        let app = AXUIElementCreateApplication(pid as i32);
        if !app.is_null() {
            if let Some(window) = get_element_attribute(app, "AXFocusedWindow") {
                result = element_center(window);
                release_cf(window);
            }
            release_cf(app);
        }
    }

    if result.is_none() {
        result = element_center(focused);
    }

    release_cf(focused);
    result
}

unsafe fn element_center(element: AXUIElementRef) -> Option<(f64, f64)> {
    let position = point_attribute(element, "AXPosition")?;
    let size = size_attribute(element, "AXSize")?;
    if size.width <= 0.0 || size.height <= 0.0 {
        return None;
    }

    Some((
        position.x + (size.width / 2.0),
        position.y + (size.height / 2.0),
    ))
}

fn capture_a11y_screenshot_event(
    timestamp: f64,
    start: &Instant,
    max_depth: u32,
    max_children: usize,
    scale_factor: f64,
    quality: u8,
    capture_mode: ScreenshotCaptureMode,
) -> Result<Option<Value>> {
    let screenshot = capture_and_encode_screenshot(capture_mode, scale_factor, quality)
        .context("failed to capture accessibility screenshot")?;
    let a11y = collect_accessibility_snapshot(max_depth, max_children)?;
    let has_windows = a11y
        .get("windows_data")
        .and_then(Value::as_array)
        .map(|windows| !windows.is_empty())
        .unwrap_or(false);
    if !has_windows {
        return Ok(None);
    }

    let mut screenshot_data = screenshot.data;
    if let Some(object) = screenshot_data.as_object_mut() {
        object.insert("timestamp".to_string(), json!(timestamp));
    }

    Ok(Some(json!({
        "type": "a11y+screenshot",
        "timestamp": timestamp,
        "end_timestamp": start.elapsed().as_secs_f64(),
        "data": {
            "a11y": a11y,
            "screenshot": screenshot_data,
        }
    })))
}

fn collect_accessibility_snapshot(max_depth: u32, max_children: usize) -> Result<Value> {
    let bounds = ScreenBounds::detect().unwrap_or_else(|_| ScreenBounds::fallback());
    let mut windows_data = Vec::new();
    let mut focused_pid = None;

    unsafe {
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            bail!("failed to create system-wide accessibility element");
        }

        let focused = get_element_attribute(system, "AXFocusedUIElement");
        if let Some(focused_element) = focused {
            focused_pid = get_pid(focused_element);
            if let Some(pid) = focused_pid {
                let app = AXUIElementCreateApplication(pid as i32);
                if !app.is_null() {
                    if let Some(window) = get_element_attribute(app, "AXFocusedWindow") {
                        windows_data.push(element_to_json(window, 0, max_depth, max_children));
                        release_cf(window);
                    } else {
                        windows_data.push(element_to_json(
                            focused_element,
                            0,
                            max_depth,
                            max_children,
                        ));
                    }
                    release_cf(app);
                } else {
                    windows_data.push(element_to_json(focused_element, 0, max_depth, max_children));
                }
            } else {
                windows_data.push(element_to_json(focused_element, 0, max_depth, max_children));
            }
            release_cf(focused_element);
        }
        release_cf(system);
    }

    Ok(json!({
        "metadata": {
            "timestamp": unix_timestamp_seconds(),
            "platform": "macos",
            "screen_width": bounds.width,
            "screen_height": bounds.height,
            "focused_pid": focused_pid,
            "max_depth": max_depth,
        },
        "windows_data": windows_data,
    }))
}

unsafe fn element_to_json(
    element: AXUIElementRef,
    depth: u32,
    max_depth: u32,
    max_children: usize,
) -> Value {
    let role = string_attribute(element, "AXRole").unwrap_or_else(|| "AXUnknown".to_string());
    let title = string_attribute(element, "AXTitle");
    let description =
        string_attribute(element, "AXDescription").or_else(|| string_attribute(element, "AXHelp"));
    let value = string_attribute(element, "AXValue");
    let identifier = string_attribute(element, "AXIdentifier");
    let position = point_attribute(element, "AXPosition");
    let size = size_attribute(element, "AXSize");
    let bbox = match (position, size) {
        (Some(pos), Some(size)) => {
            json!([pos.x, pos.y, pos.x + size.width, pos.y + size.height])
        }
        _ => json!([]),
    };

    let mut object = Map::new();
    object.insert(
        "name".to_string(),
        json!(title
            .clone()
            .or_else(|| description.clone())
            .or_else(|| value.clone())
            .unwrap_or_default()),
    );
    object.insert("class_name".to_string(), json!(role));
    object.insert(
        "friendly_class_name".to_string(),
        json!(role.strip_prefix("AX").unwrap_or(&role)),
    );
    object.insert("bbox".to_string(), bbox);
    object.insert("children".to_string(), json!([]));

    if let Some(value) = value {
        object.insert("value".to_string(), json!(value));
    }
    if let Some(description) = description {
        object.insert("description".to_string(), json!(description));
    }
    if let Some(identifier) = identifier {
        object.insert("identifier".to_string(), json!(identifier));
    }
    if let Some(focused) = bool_attribute(element, "AXFocused") {
        object.insert("focused".to_string(), json!(focused));
    }
    if let Some(enabled) = bool_attribute(element, "AXEnabled") {
        object.insert("enabled".to_string(), json!(enabled));
    }
    if let Some(pid) = get_pid(element) {
        object.insert("pid".to_string(), json!(pid));
    }

    if depth < max_depth {
        let mut children_json = Vec::new();
        for child in child_elements(element, max_children) {
            children_json.push(element_to_json(child, depth + 1, max_depth, max_children));
            release_cf(child);
        }
        let children = children_json;
        object.insert("children".to_string(), json!(children));
    }

    Value::Object(object)
}

fn ensure_accessibility_permission(prompt: bool) -> Result<()> {
    if accessibility_trusted(prompt) {
        return Ok(());
    }
    bail!(
        "macOS Accessibility permission is not granted. Add the Kortix binary or the launching terminal under System Settings > Privacy & Security > Accessibility, then retry."
    )
}

fn ensure_input_monitoring_permission(prompt: bool) -> Result<()> {
    if input_monitoring_trusted(prompt) {
        return Ok(());
    }
    bail!(
        "macOS Input Monitoring permission is not granted. Add the Kortix binary or the launching terminal under System Settings > Privacy & Security > Input Monitoring, then retry."
    )
}

fn accessibility_trusted(prompt: bool) -> bool {
    if !prompt {
        return unsafe { AXIsProcessTrusted() };
    }

    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = CFBoolean::true_value();
        let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

fn input_monitoring_trusted(prompt: bool) -> bool {
    unsafe {
        if prompt {
            CGRequestListenEventAccess()
        } else {
            CGPreflightListenEventAccess()
        }
    }
}

unsafe fn get_element_attribute(
    element: AXUIElementRef,
    attribute: &str,
) -> Option<AXUIElementRef> {
    copy_attribute(element, attribute).map(|value| value as AXUIElementRef)
}

unsafe fn string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let value = copy_attribute(element, attribute)?;
    let cf_type = CFType::wrap_under_create_rule(value);
    if cf_type.type_of() == CFString::type_id() {
        let cf_string = CFString::wrap_under_get_rule(value as CFStringRef);
        let string = cf_string.to_string();
        if string.is_empty() {
            None
        } else {
            Some(string)
        }
    } else {
        None
    }
}

unsafe fn bool_attribute(element: AXUIElementRef, attribute: &str) -> Option<bool> {
    let value = copy_attribute(element, attribute)?;
    let cf_type = CFType::wrap_under_create_rule(value);
    if cf_type.type_of() == CFBoolean::type_id() {
        Some(value == CFBoolean::true_value().as_CFTypeRef())
    } else {
        None
    }
}

unsafe fn point_attribute(element: AXUIElementRef, attribute: &str) -> Option<CGPoint> {
    let value = copy_attribute(element, attribute)?;
    let cf_type = CFType::wrap_under_create_rule(value);
    let mut point = CGPoint::new(0.0, 0.0);
    if AXValueGetValue(
        cf_type.as_CFTypeRef() as AXValueRef,
        AX_VALUE_TYPE_CGPOINT,
        &mut point as *mut _ as *mut c_void,
    ) {
        Some(point)
    } else {
        None
    }
}

unsafe fn size_attribute(element: AXUIElementRef, attribute: &str) -> Option<CGSize> {
    let value = copy_attribute(element, attribute)?;
    let cf_type = CFType::wrap_under_create_rule(value);
    let mut size = CGSize::new(0.0, 0.0);
    if AXValueGetValue(
        cf_type.as_CFTypeRef() as AXValueRef,
        AX_VALUE_TYPE_CGSIZE,
        &mut size as *mut _ as *mut c_void,
    ) {
        Some(size)
    } else {
        None
    }
}

unsafe fn child_elements(element: AXUIElementRef, max_children: usize) -> Vec<AXUIElementRef> {
    let Some(value) = copy_attribute(element, "AXChildren") else {
        return Vec::new();
    };
    let cf_type = CFType::wrap_under_create_rule(value);
    if cf_type.type_of() != CFArray::<CFType>::type_id() {
        return Vec::new();
    }

    let array = CFArray::<CFType>::wrap_under_get_rule(
        cf_type.as_CFTypeRef() as core_foundation::array::CFArrayRef
    );
    let count = array.len().min(max_children as _);
    let mut children = Vec::with_capacity(count as usize);
    for index in 0..count {
        if let Some(child) = array.get(index) {
            let child_ref = child.as_CFTypeRef() as AXUIElementRef;
            if !child_ref.is_null() {
                CFRetain(child_ref as CFTypeRef);
                children.push(child_ref);
            }
        }
    }
    children
}

unsafe fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFTypeRef> {
    if element.is_null() {
        return None;
    }
    let attr = CFString::new(attribute);
    let mut value: CFTypeRef = ptr::null_mut();
    let result = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if result == AX_ERROR_SUCCESS && !value.is_null() {
        Some(value)
    } else {
        None
    }
}

unsafe fn get_pid(element: AXUIElementRef) -> Option<u32> {
    if element.is_null() {
        return None;
    }
    let mut pid = 0;
    let result = AXUIElementGetPid(element, &mut pid);
    if result == AX_ERROR_SUCCESS && pid > 0 {
        Some(pid as u32)
    } else {
        None
    }
}

unsafe fn release_cf(value: *mut c_void) {
    if !value.is_null() {
        CFRelease(value as CFTypeRef);
    }
}

unsafe fn event_keycode(event: CGEventRef) -> u16 {
    CGEventGetIntegerValueField(event, EventField::KEYBOARD_EVENT_KEYCODE) as u16
}

unsafe fn macos_event_key_name(event: CGEventRef, prefer_unicode: bool) -> String {
    let code = event_keycode(event);
    if let Some(name) = macos_non_text_key_name_from_code(code) {
        return name.to_string();
    }
    if prefer_unicode {
        if let Some(name) = keyboard_unicode_name(event) {
            return name;
        }
    }
    macos_key_name_from_code(code)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("unknown_{code}"))
}

unsafe fn keyboard_unicode_name(event: CGEventRef) -> Option<String> {
    let mut buffer = [0u16; 8];
    let mut length = 0usize;
    CGEventKeyboardGetUnicodeString(event, buffer.len(), &mut length, buffer.as_mut_ptr());
    if length == 0 || length > buffer.len() {
        return None;
    }
    let value = String::from_utf16_lossy(&buffer[..length]);
    normalized_key_text(&value)
}

fn normalized_key_text(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    Some(match value {
        " " => "space".to_string(),
        "\n" | "\r" => "enter".to_string(),
        "\t" => "tab".to_string(),
        other => other.to_string(),
    })
}

unsafe fn scroll_axis_delta(event: CGEventRef, axis: u8) -> i64 {
    let (point_field, fixed_field, line_field) = match axis {
        1 => (
            EventField::SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_1,
            EventField::SCROLL_WHEEL_EVENT_FIXED_POINT_DELTA_AXIS_1,
            EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_1,
        ),
        2 => (
            EventField::SCROLL_WHEEL_EVENT_POINT_DELTA_AXIS_2,
            EventField::SCROLL_WHEEL_EVENT_FIXED_POINT_DELTA_AXIS_2,
            EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_2,
        ),
        _ => return 0,
    };
    let point_delta = CGEventGetIntegerValueField(event, point_field);
    if point_delta != 0 {
        return point_delta;
    }
    let line_delta = CGEventGetIntegerValueField(event, line_field);
    if line_delta != 0 {
        return line_delta;
    }
    let fixed_delta = CGEventGetIntegerValueField(event, fixed_field);
    fixed_point_scroll_delta_to_clicks(fixed_delta)
}

fn fixed_point_scroll_delta_to_clicks(delta: i64) -> i64 {
    if delta == 0 {
        return 0;
    }
    let clicks = (delta as f64 / 65536.0).round() as i64;
    if clicks == 0 {
        delta.signum()
    } else {
        clicks
    }
}

fn other_mouse_button_name(event: CGEventRef) -> String {
    let button =
        unsafe { CGEventGetIntegerValueField(event, EventField::MOUSE_EVENT_BUTTON_NUMBER) };
    match button {
        2 => "middle".to_string(),
        other => format!("unknown_{other}"),
    }
}

fn modifier_flag_is_set(key_name: &str, flags: CGEventFlags) -> bool {
    match key_name {
        "shift" => flags.contains(CGEventFlags::CGEventFlagShift),
        "ctrl" => flags.contains(CGEventFlags::CGEventFlagControl),
        "alt" => flags.contains(CGEventFlags::CGEventFlagAlternate),
        "command" => flags.contains(CGEventFlags::CGEventFlagCommand),
        _ => false,
    }
}

fn prefer_physical_key_name_for_modified_key_down(flags: CGEventFlags) -> bool {
    flags.contains(CGEventFlags::CGEventFlagControl)
        || flags.contains(CGEventFlags::CGEventFlagAlternate)
        || flags.contains(CGEventFlags::CGEventFlagCommand)
}

fn is_modifier_key_name(key: &str) -> bool {
    matches!(key, "ctrl" | "shift" | "alt" | "command")
}

fn nx_system_key_name(code: i64) -> Option<&'static str> {
    Some(match code {
        0 => "volume_up",
        1 => "volume_down",
        2 => "brightness_up",
        3 => "brightness_down",
        // Caps Lock also arrives as a flagsChanged event. Keeping it here
        // double-counts each physical press as both NX_SYSDEFINED and modifier
        // state, so let flagsChanged be the single source for Caps Lock.
        4 => return None,
        5 => "help",
        7 => "volume_mute",
        16 => "play_pause",
        17 => "play_next",
        18 => "play_previous",
        19 => "fast_forward",
        20 => "rewind",
        21 => "keyboard_brightness_up",
        22 => "keyboard_brightness_down",
        23 => "keyboard_brightness_toggle",
        _ => return None,
    })
}

fn macos_non_text_key_name_from_code(code: u16) -> Option<&'static str> {
    Some(match code {
        0x24 => "enter",
        0x30 => "tab",
        0x33 => "backspace",
        0x35 => "esc",
        0x36 | 0x37 => "command",
        0x38 | 0x3c => "shift",
        0x39 => "capslock",
        0x3a | 0x3d => "alt",
        0x3b | 0x3e => "ctrl",
        0x3f => "function",
        0x40 => "f17",
        0x48 => "volume_up",
        0x49 => "volume_down",
        0x4a => "volume_mute",
        0x4f => "f18",
        0x50 => "f19",
        0x5a => "f20",
        0x60 => "f5",
        0x61 => "f6",
        0x62 => "f7",
        0x63 => "f3",
        0x64 => "f8",
        0x65 => "f9",
        0x67 => "f11",
        0x69 => "f13",
        0x6a => "f16",
        0x6b => "f14",
        0x6d => "f10",
        0x6f => "f12",
        0x71 => "f15",
        0x72 => "insert",
        0x73 => "home",
        0x74 => "pageup",
        0x75 => "delete",
        0x76 => "f4",
        0x77 => "end",
        0x78 => "f2",
        0x79 => "pagedown",
        0x7a => "f1",
        0x7b => "left",
        0x7c => "right",
        0x7d => "down",
        0x7e => "up",
        // Apple top-row and Fn functions that arrive as normal keyboard events
        // instead of NX_SYSDEFINED media events on recent Mac keyboards.
        0x83 => "launchpad",
        0xa0 => "mission_control",
        0xb0 => "dictation",
        0xb1 => "spotlight",
        0xb2 => "do_not_disturb",
        0xb3 => "function",
        _ => return None,
    })
}

fn macos_key_name_from_code(code: u16) -> Option<&'static str> {
    Some(match code {
        0x00 => "a",
        0x01 => "s",
        0x02 => "d",
        0x03 => "f",
        0x04 => "h",
        0x05 => "g",
        0x06 => "z",
        0x07 => "x",
        0x08 => "c",
        0x09 => "v",
        0x0b => "b",
        0x0c => "q",
        0x0d => "w",
        0x0e => "e",
        0x0f => "r",
        0x10 => "y",
        0x11 => "t",
        0x12 => "1",
        0x13 => "2",
        0x14 => "3",
        0x15 => "4",
        0x16 => "6",
        0x17 => "5",
        0x18 => "=",
        0x19 => "9",
        0x1a => "7",
        0x1b => "-",
        0x1c => "8",
        0x1d => "0",
        0x1e => "]",
        0x1f => "o",
        0x20 => "u",
        0x21 => "[",
        0x22 => "i",
        0x23 => "p",
        0x24 => "enter",
        0x25 => "l",
        0x26 => "j",
        0x27 => "'",
        0x28 => "k",
        0x29 => ";",
        0x2a => "\\",
        0x2b => ",",
        0x2c => "/",
        0x2d => "n",
        0x2e => "m",
        0x2f => ".",
        0x30 => "tab",
        0x31 => "space",
        0x32 => "`",
        0x33 => "backspace",
        0x35 => "esc",
        0x36 | 0x37 => "command",
        0x38 | 0x3c => "shift",
        0x39 => "capslock",
        0x3a | 0x3d => "alt",
        0x3b | 0x3e => "ctrl",
        0x3f => "function",
        0x40 => "f17",
        0x48 => "volume_up",
        0x49 => "volume_down",
        0x4a => "volume_mute",
        0x4f => "f18",
        0x50 => "f19",
        0x52 => "0",
        0x53 => "1",
        0x54 => "2",
        0x55 => "3",
        0x56 => "4",
        0x57 => "5",
        0x58 => "6",
        0x59 => "7",
        0x5a => "f20",
        0x5b => "8",
        0x5c => "9",
        0x60 => "f5",
        0x61 => "f6",
        0x62 => "f7",
        0x63 => "f3",
        0x64 => "f8",
        0x65 => "f9",
        0x67 => "f11",
        0x69 => "f13",
        0x6a => "f16",
        0x6b => "f14",
        0x6d => "f10",
        0x6f => "f12",
        0x71 => "f15",
        0x72 => "insert",
        0x73 => "home",
        0x74 => "pageup",
        0x75 => "delete",
        0x76 => "f4",
        0x77 => "end",
        0x78 => "f2",
        0x79 => "pagedown",
        0x7a => "f1",
        0x7b => "left",
        0x7c => "right",
        0x7d => "down",
        0x7e => "up",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn session() -> MacosInputSession {
        MacosInputSession::new(Arc::new(|_| {}), ScreenBounds::fallback())
    }

    #[test]
    fn sync_modifier_state_synthesizes_missing_command_edges() {
        let mut session = session();

        let down = session.sync_modifier_state(1.0, CGEventFlags::CGEventFlagCommand);
        assert_eq!(down.len(), 1);
        assert_eq!(down[0]["type"], "key_down");
        assert_eq!(down[0]["data"]["key"], "command");
        assert_eq!(session.active_modifiers_list(), vec!["command"]);

        let unchanged = session.sync_modifier_state(1.1, CGEventFlags::CGEventFlagCommand);
        assert!(unchanged.is_empty());

        let up = session.sync_modifier_state(1.2, CGEventFlags::empty());
        assert_eq!(up.len(), 1);
        assert_eq!(up[0]["type"], "key_up");
        assert_eq!(up[0]["data"]["key"], "command");
        assert!(session.active_modifiers_list().is_empty());
    }

    #[test]
    fn normalized_key_text_preserves_control_bytes_for_processor() {
        assert_eq!(normalized_key_text("\u{8}").as_deref(), Some("\u{8}"));
        assert_eq!(normalized_key_text("\u{7f}").as_deref(), Some("\u{7f}"));
        assert_eq!(normalized_key_text("\u{1b}").as_deref(), Some("\u{1b}"));
    }

    #[test]
    fn non_text_keycodes_override_unicode_text() {
        assert_eq!(macos_non_text_key_name_from_code(0x33), Some("backspace"));
        assert_eq!(macos_non_text_key_name_from_code(0x75), Some("delete"));
        assert_eq!(macos_non_text_key_name_from_code(0x7b), Some("left"));
        assert_eq!(macos_non_text_key_name_from_code(0x48), Some("volume_up"));
        assert_eq!(macos_non_text_key_name_from_code(0x49), Some("volume_down"));
        assert_eq!(macos_non_text_key_name_from_code(0x4a), Some("volume_mute"));
        assert_eq!(macos_non_text_key_name_from_code(0x72), Some("insert"));
        assert_eq!(macos_non_text_key_name_from_code(0x83), Some("launchpad"));
        assert_eq!(
            macos_non_text_key_name_from_code(0xa0),
            Some("mission_control")
        );
        assert_eq!(macos_non_text_key_name_from_code(0xb0), Some("dictation"));
        assert_eq!(macos_non_text_key_name_from_code(0xb1), Some("spotlight"));
        assert_eq!(
            macos_non_text_key_name_from_code(0xb2),
            Some("do_not_disturb")
        );
        assert_eq!(macos_non_text_key_name_from_code(0xb3), Some("function"));
        assert_eq!(macos_non_text_key_name_from_code(0x95), None);
        assert_eq!(macos_non_text_key_name_from_code(0x00), None);
    }

    #[test]
    fn nx_system_keycodes_map_to_canonical_media_names() {
        assert_eq!(nx_system_key_name(0), Some("volume_up"));
        assert_eq!(nx_system_key_name(1), Some("volume_down"));
        assert_eq!(nx_system_key_name(2), Some("brightness_up"));
        assert_eq!(nx_system_key_name(3), Some("brightness_down"));
        assert_eq!(nx_system_key_name(4), None);
        assert_eq!(nx_system_key_name(5), Some("help"));
        assert_eq!(nx_system_key_name(7), Some("volume_mute"));
        assert_eq!(nx_system_key_name(16), Some("play_pause"));
        assert_eq!(nx_system_key_name(99), None);
    }

    #[test]
    fn fixed_point_scroll_delta_falls_back_to_sign_when_sub_line() {
        assert_eq!(fixed_point_scroll_delta_to_clicks(0), 0);
        assert_eq!(fixed_point_scroll_delta_to_clicks(65536), 1);
        assert_eq!(fixed_point_scroll_delta_to_clicks(-65536), -1);
        assert_eq!(fixed_point_scroll_delta_to_clicks(2000), 1);
        assert_eq!(fixed_point_scroll_delta_to_clicks(-2000), -1);
    }

    #[test]
    fn keypad_digit_keycodes_map_to_digits() {
        assert_eq!(macos_key_name_from_code(0x53), Some("1"));
        assert_eq!(macos_key_name_from_code(0x5c), Some("9"));
    }

    #[test]
    fn modified_key_down_prefers_physical_key_name_except_shift() {
        assert!(!prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::empty()
        ));
        assert!(!prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::CGEventFlagShift
        ));
        assert!(prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::CGEventFlagAlternate
        ));
        assert!(prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::CGEventFlagControl
        ));
        assert!(prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::CGEventFlagCommand
        ));
        assert!(prefer_physical_key_name_for_modified_key_down(
            CGEventFlags::CGEventFlagShift | CGEventFlags::CGEventFlagAlternate
        ));
    }
}

fn unix_timestamp_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}
