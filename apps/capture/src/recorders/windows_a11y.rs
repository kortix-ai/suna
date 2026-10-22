use super::{
    capture_desktop_capture, encode_captured_screenshot, hamming_distance, lock_unpoisoned,
    sanitize_scale_factor, screenshot_capture_dhash, seconds_duration, A11yHashHistory,
    EventCallback, Recorder, ScreenBounds, ScreenshotCaptureMode,
};
use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::HWND,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
                IUIAutomationRangeValuePattern, IUIAutomationTogglePattern,
                IUIAutomationValuePattern, ToggleState_Off, ToggleState_On, TreeScope_Children,
                UIA_ButtonControlTypeId, UIA_CalendarControlTypeId, UIA_CheckBoxControlTypeId,
                UIA_ComboBoxControlTypeId, UIA_DataGridControlTypeId, UIA_DataItemControlTypeId,
                UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
                UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId, UIA_HyperlinkControlTypeId,
                UIA_ImageControlTypeId, UIA_ListControlTypeId, UIA_ListItemControlTypeId,
                UIA_MenuBarControlTypeId, UIA_MenuControlTypeId, UIA_MenuItemControlTypeId,
                UIA_PaneControlTypeId, UIA_ProgressBarControlTypeId, UIA_RadioButtonControlTypeId,
                UIA_RangeValuePatternId, UIA_ScrollBarControlTypeId, UIA_SeparatorControlTypeId,
                UIA_SliderControlTypeId, UIA_SpinnerControlTypeId, UIA_SplitButtonControlTypeId,
                UIA_StatusBarControlTypeId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
                UIA_TableControlTypeId, UIA_TextControlTypeId, UIA_ThumbControlTypeId,
                UIA_TogglePatternId, UIA_ToolBarControlTypeId, UIA_ToolTipControlTypeId,
                UIA_TreeControlTypeId, UIA_TreeItemControlTypeId, UIA_ValuePatternId,
                UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
            },
            WindowsAndMessaging::{
                FindWindowExW, FindWindowW, GetForegroundWindow, SetForegroundWindow,
            },
        },
    },
};

const HASH_HISTORY_DISTANCE_THRESHOLD: u32 = 20;
const PRIMARY_MIN_NODE_COUNT: usize = 15;

pub(super) struct WindowsA11yRecorder {
    callback: EventCallback,
    interval: Duration,
    max_depth: u32,
    max_children: usize,
    max_nodes: usize,
    scale_factor: f64,
    quality: u32,
    capture_mode: ScreenshotCaptureMode,
    accepted_hashes: Option<A11yHashHistory>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WindowsA11yRecorder {
    pub(super) fn new(
        callback: EventCallback,
        interval_seconds: f64,
        max_depth: u32,
        max_children: usize,
        max_nodes: usize,
        scale_factor: f64,
        quality: u32,
        capture_mode: ScreenshotCaptureMode,
        accepted_hashes: Option<A11yHashHistory>,
    ) -> Self {
        Self {
            callback,
            interval: seconds_duration(interval_seconds, 10.0),
            max_depth,
            max_children: max_children.max(1),
            max_nodes: max_nodes.max(1),
            scale_factor,
            quality,
            capture_mode,
            accepted_hashes,
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

impl Recorder for WindowsA11yRecorder {
    fn start(&mut self) -> Result<()> {
        if self.thread.is_some() {
            return Ok(());
        }

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let callback = self.callback.clone();
        let interval = self.interval;
        let max_depth = self.max_depth;
        let max_children = self.max_children;
        let max_nodes = self.max_nodes;
        let scale_factor = sanitize_scale_factor(self.scale_factor);
        let quality = self.quality.clamp(1, 100) as u8;
        let capture_mode = self.capture_mode;
        let accepted_hashes = self.accepted_hashes.clone();

        self.thread = Some(
            thread::Builder::new()
                .name("kortix-windows-a11y-recorder".to_string())
                .spawn(move || {
                    let start = Instant::now();
                    let collector = match WindowsA11yCollector::new() {
                        Ok(collector) => collector,
                        Err(err) => {
                            tracing::warn!("failed to initialize Windows UI Automation: {err:#}");
                            return;
                        }
                    };

                    while running.load(Ordering::SeqCst) {
                        let capture_started = Instant::now();
                        match capture_a11y_screenshot_event(
                            &collector,
                            &start,
                            max_depth,
                            max_children,
                            max_nodes,
                            scale_factor,
                            quality,
                            capture_mode,
                            accepted_hashes.as_ref(),
                        ) {
                            Ok(Some(event)) => callback(event),
                            Ok(None) => {}
                            Err(err) => tracing::warn!(
                                "failed to capture Windows accessibility snapshot: {err:#}"
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
                .context("failed to spawn Windows accessibility recorder thread")?,
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

fn capture_a11y_screenshot_event(
    collector: &WindowsA11yCollector,
    start: &Instant,
    max_depth: u32,
    max_children: usize,
    max_nodes: usize,
    scale_factor: f64,
    quality: u8,
    capture_mode: ScreenshotCaptureMode,
    accepted_hashes: Option<&A11yHashHistory>,
) -> Result<Option<Value>> {
    let raw_screenshot = capture_desktop_capture(capture_mode)
        .context("failed to capture accessibility screenshot")?;
    let trigger_hash = screenshot_capture_dhash(&raw_screenshot, scale_factor);
    if !is_screenshot_unique(trigger_hash, accepted_hashes) {
        return Ok(None);
    }

    let timestamp = start.elapsed().as_secs_f64();
    let encoded = encode_captured_screenshot(raw_screenshot, scale_factor, quality)
        .context("failed to encode accessibility screenshot")?;
    let mut a11y = collector.collect(max_depth, max_children, max_nodes)?;
    let windows_data = a11y
        .get("windows_data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if windows_data.is_empty() {
        return Ok(None);
    }

    if let Some(metadata) = a11y.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert(
            "collection_time_seconds".to_string(),
            json!(collector.last_collection_seconds()),
        );
    }

    let mut screenshot_data = encoded.data;
    if let Some(object) = screenshot_data.as_object_mut() {
        object.insert("timestamp".to_string(), json!(timestamp));
    }

    Ok(Some(json!({
        "type": "a11y+screenshot",
        "timestamp": timestamp,
        "end_timestamp": start.elapsed().as_secs_f64(),
        "event_screenshot_hash": format!("{trigger_hash:016x}"),
        "data": {
            "a11y": a11y,
            "screenshot": screenshot_data,
        }
    })))
}

struct WindowsA11yCollector {
    automation: IUIAutomation,
    true_condition: IUIAutomationCondition,
    screen_bounds: ScreenBounds,
    collection_started: std::cell::Cell<Instant>,
    last_collection: std::cell::Cell<Duration>,
}

impl WindowsA11yCollector {
    fn new() -> Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .context("failed to create IUIAutomation")?;
            let true_condition = automation
                .CreateTrueCondition()
                .context("failed to create UIA true condition")?;
            let screen_bounds = ScreenBounds::detect().unwrap_or_else(|err| {
                tracing::warn!("failed to detect screen bounds for accessibility: {err:#}");
                ScreenBounds::fallback()
            });
            Ok(Self {
                automation,
                true_condition,
                screen_bounds,
                collection_started: std::cell::Cell::new(Instant::now()),
                last_collection: std::cell::Cell::new(Duration::ZERO),
            })
        }
    }

    fn collect(&self, max_depth: u32, max_children: usize, max_nodes: usize) -> Result<Value> {
        self.collection_started.set(Instant::now());
        let mut elements = self.active_elements();
        if elements.is_empty() {
            if let Ok(focused) = unsafe { self.automation.GetFocusedElement() } {
                elements.push(focused);
            }
        }
        elements.extend(self.taskbar_elements());

        let mut node_count = 0usize;
        let mut windows_data = Vec::new();
        for element in elements {
            if node_count >= max_nodes {
                break;
            }
            if let Some(node) = self.element_to_json(
                &element,
                0,
                max_depth,
                max_children,
                max_nodes,
                &mut node_count,
            ) {
                windows_data.push(node);
            }
        }

        let windows_data = post_process_windows_data(windows_data);
        self.last_collection
            .set(self.collection_started.get().elapsed());

        Ok(json!({
            "metadata": {
                "timestamp": unix_timestamp_seconds(),
                "collection_time_seconds": self.last_collection_seconds(),
                "platform": "Windows",
                "screen_width": self.screen_bounds.width,
                "screen_height": self.screen_bounds.height,
                "max_depth": max_depth,
                "max_children": max_children,
                "max_nodes": max_nodes,
            },
            "windows_data": windows_data,
        }))
    }

    fn last_collection_seconds(&self) -> f64 {
        self.last_collection.get().as_secs_f64()
    }

    fn active_elements(&self) -> Vec<IUIAutomationElement> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return Vec::new();
        }

        unsafe {
            let _ = SetForegroundWindow(hwnd);
            self.automation
                .ElementFromHandle(hwnd)
                .ok()
                .into_iter()
                .collect()
        }
    }

    fn taskbar_elements(&self) -> Vec<IUIAutomationElement> {
        let mut elements = Vec::new();
        unsafe {
            if let Ok(primary) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) {
                if let Ok(element) = self.automation.ElementFromHandle(primary) {
                    elements.push(element);
                }
            }

            let null_hwnd = HWND(std::ptr::null_mut());
            let mut after = null_hwnd;
            loop {
                let Ok(hwnd) = FindWindowExW(
                    null_hwnd,
                    after,
                    w!("Shell_SecondaryTrayWnd"),
                    PCWSTR::null(),
                ) else {
                    break;
                };
                if hwnd.0.is_null() {
                    break;
                }
                if let Ok(element) = self.automation.ElementFromHandle(hwnd) {
                    elements.push(element);
                }
                after = hwnd;
            }
        }
        elements
    }

    fn element_to_json(
        &self,
        element: &IUIAutomationElement,
        depth: u32,
        max_depth: u32,
        max_children: usize,
        max_nodes: usize,
        node_count: &mut usize,
    ) -> Option<Value> {
        if *node_count >= max_nodes || !self.is_visible(element) {
            return None;
        }
        *node_count += 1;

        let control_type = unsafe { element.CurrentControlType().unwrap_or_default() };
        let class_name = current_string(element, |element| unsafe { element.CurrentClassName() })
            .or_else(|| Some(control_type_name(control_type).to_string()))
            .unwrap_or_default();
        let friendly_class_name = current_string(element, |element| unsafe {
            element.CurrentLocalizedControlType()
        })
        .map(|value| title_case_first(&value))
        .unwrap_or_else(|| control_type_name(control_type).to_string());
        let name = current_string(element, |element| unsafe { element.CurrentName() })
            .or_else(|| get_value(element))
            .unwrap_or_default();
        let bbox = element_bbox(element).map_or_else(|| json!([]), |bbox| json!(bbox));

        let mut object = Map::new();
        object.insert("name".to_string(), json!(name));
        object.insert("class_name".to_string(), json!(class_name));
        object.insert(
            "friendly_class_name".to_string(),
            json!(friendly_class_name),
        );
        object.insert("bbox".to_string(), bbox);
        object.insert("children".to_string(), json!([]));

        if let Some(value) = get_value(element) {
            object.insert("value".to_string(), json!(value));
        }
        if let Some(description) =
            current_string(element, |element| unsafe { element.CurrentHelpText() })
        {
            object.insert("description".to_string(), json!(description));
        }
        if let Some(identifier) =
            current_string(element, |element| unsafe { element.CurrentAutomationId() })
        {
            object.insert("identifier".to_string(), json!(identifier));
        }
        if let Ok(focused) = unsafe { element.CurrentHasKeyboardFocus() } {
            object.insert("focused".to_string(), json!(focused.as_bool()));
        }
        if let Ok(enabled) = unsafe { element.CurrentIsEnabled() } {
            object.insert("enabled".to_string(), json!(enabled.as_bool()));
        }
        if let Ok(pid) = unsafe { element.CurrentProcessId() } {
            object.insert("pid".to_string(), json!(pid));
        }

        if depth < max_depth {
            let mut children = Vec::new();
            for child in self.child_elements(element, max_children) {
                if *node_count >= max_nodes {
                    break;
                }
                if let Some(child) = self.element_to_json(
                    &child,
                    depth + 1,
                    max_depth,
                    max_children,
                    max_nodes,
                    node_count,
                ) {
                    children.push(child);
                }
            }
            object.insert("children".to_string(), json!(children));
        }

        Some(Value::Object(object))
    }

    fn child_elements(
        &self,
        element: &IUIAutomationElement,
        max_children: usize,
    ) -> Vec<IUIAutomationElement> {
        let mut children = Vec::new();
        unsafe {
            if let Ok(array) = element.FindAll(TreeScope_Children, &self.true_condition) {
                if let Ok(len) = array.Length() {
                    let len = (len as usize).min(max_children);
                    for index in 0..len {
                        if let Ok(child) = array.GetElement(index as i32) {
                            children.push(child);
                        }
                    }
                }
            }
        }
        children
    }

    fn is_visible(&self, element: &IUIAutomationElement) -> bool {
        let Ok(is_offscreen) = (unsafe { element.CurrentIsOffscreen() }) else {
            return false;
        };
        if is_offscreen.as_bool() {
            return false;
        }

        let Some(bbox) = element_bbox(element) else {
            return false;
        };
        bbox_intersects_bounds(bbox, &self.screen_bounds)
    }
}

fn current_string<F>(element: &IUIAutomationElement, getter: F) -> Option<String>
where
    F: Fn(&IUIAutomationElement) -> windows::core::Result<windows::core::BSTR>,
{
    getter(element)
        .ok()
        .map(|value| value.to_string())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn get_value(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            if let Ok(value) = pattern.CurrentValue() {
                let value = value.to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }

        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            if let Ok(state) = pattern.CurrentToggleState() {
                #[allow(non_upper_case_globals)]
                let label = match state {
                    ToggleState_On => "checked",
                    ToggleState_Off => "unchecked",
                    _ => "indeterminate",
                };
                return Some(label.to_string());
            }
        }

        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
        {
            if let Ok(value) = pattern.CurrentValue() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn element_bbox(element: &IUIAutomationElement) -> Option<[i32; 4]> {
    unsafe {
        let rect = element.CurrentBoundingRectangle().ok()?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return None;
        }
        Some([rect.left, rect.top, rect.right, rect.bottom])
    }
}

fn bbox_intersects_bounds(bbox: [i32; 4], bounds: &ScreenBounds) -> bool {
    let left = bbox[0] as f64;
    let top = bbox[1] as f64;
    let right = bbox[2] as f64;
    let bottom = bbox[3] as f64;
    let screen_right = bounds.x + bounds.width;
    let screen_bottom = bounds.y + bounds.height;
    right > bounds.x && bottom > bounds.y && left < screen_right && top < screen_bottom
}

fn post_process_windows_data(windows_data: Vec<Value>) -> Vec<Value> {
    let Some(primary_window) = windows_data.iter().find(|window| !is_taskbar_node(window)) else {
        return windows_data;
    };

    if count_valid_nodes(primary_window) < PRIMARY_MIN_NODE_COUNT {
        Vec::new()
    } else {
        windows_data
    }
}

fn is_taskbar_node(node: &Value) -> bool {
    let class_name = node
        .get("class_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let friendly_class_name = node
        .get("friendly_class_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = node.get("name").and_then(Value::as_str).unwrap_or_default();
    class_name == "Shell_TrayWnd" || friendly_class_name == "Tray" || name == "Taskbar"
}

fn count_valid_nodes(node: &Value) -> usize {
    let self_count = usize::from(
        node.get("name")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
            || node
                .get("class_name")
                .and_then(Value::as_str)
                .map(|value| !value.is_empty())
                .unwrap_or(false),
    );
    let children = node
        .get("children")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    self_count + children.iter().map(count_valid_nodes).sum::<usize>()
}

fn is_screenshot_unique(hash: u64, accepted_hashes: Option<&A11yHashHistory>) -> bool {
    let Some(accepted_hashes) = accepted_hashes else {
        return true;
    };
    let hashes = lock_unpoisoned(accepted_hashes);
    hashes
        .iter()
        .all(|existing| hamming_distance(hash, *existing) >= HASH_HISTORY_DISTANCE_THRESHOLD)
}

fn unix_timestamp_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}

fn title_case_first(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
}

#[allow(non_upper_case_globals)]
fn control_type_name(control_type: UIA_CONTROLTYPE_ID) -> &'static str {
    match control_type {
        UIA_ButtonControlTypeId => "Button",
        UIA_CalendarControlTypeId => "Calendar",
        UIA_CheckBoxControlTypeId => "CheckBox",
        UIA_ComboBoxControlTypeId => "ComboBox",
        UIA_EditControlTypeId => "Edit",
        UIA_HyperlinkControlTypeId => "Hyperlink",
        UIA_ImageControlTypeId => "Image",
        UIA_ListItemControlTypeId => "ListItem",
        UIA_ListControlTypeId => "List",
        UIA_MenuControlTypeId => "Menu",
        UIA_MenuBarControlTypeId => "MenuBar",
        UIA_MenuItemControlTypeId => "MenuItem",
        UIA_ProgressBarControlTypeId => "ProgressBar",
        UIA_RadioButtonControlTypeId => "RadioButton",
        UIA_ScrollBarControlTypeId => "ScrollBar",
        UIA_SliderControlTypeId => "Slider",
        UIA_SpinnerControlTypeId => "Spinner",
        UIA_StatusBarControlTypeId => "StatusBar",
        UIA_TabControlTypeId => "Tab",
        UIA_TabItemControlTypeId => "TabItem",
        UIA_TextControlTypeId => "Text",
        UIA_ToolBarControlTypeId => "ToolBar",
        UIA_ToolTipControlTypeId => "ToolTip",
        UIA_TreeControlTypeId => "Tree",
        UIA_TreeItemControlTypeId => "TreeItem",
        UIA_GroupControlTypeId => "Group",
        UIA_ThumbControlTypeId => "Thumb",
        UIA_DataGridControlTypeId => "DataGrid",
        UIA_DataItemControlTypeId => "DataItem",
        UIA_DocumentControlTypeId => "Document",
        UIA_SplitButtonControlTypeId => "SplitButton",
        UIA_WindowControlTypeId => "Window",
        UIA_PaneControlTypeId => "Pane",
        UIA_HeaderControlTypeId => "Header",
        UIA_HeaderItemControlTypeId => "HeaderItem",
        UIA_TableControlTypeId => "Table",
        UIA_SeparatorControlTypeId => "Separator",
        _ => "Unknown",
    }
}
