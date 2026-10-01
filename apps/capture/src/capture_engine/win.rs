//! Windows implementation of the capture engine.
//!
//! * Screen: GDI `BitBlt` of the monitor holding the focused window (works in
//!   every interactive session, no consent prompt, no Graphics Capture border).
//!   Hidden apps are painted black in `mod.rs::redact` from the z-ordered
//!   window list, because a desktop grab cannot exclude windows.
//! * Foreground / process: `GetForegroundWindow`, `QueryFullProcessImageNameW`,
//!   `GetApplicationUserModelId` for packaged apps, version resource for name.
//! * URL and AX tree: UI Automation.
//! * OCR: `Windows.Media.Ocr` (needs an installed OCR language pack).
//! * Icons: `IShellItemImageFactory`. Video: Media Foundation H.264.

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Foundation::IAsyncOperation;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::Foundation::{CloseHandle, BOOL, ERROR_SUCCESS, HWND, LPARAM, RECT, SIZE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW,
    MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY, SRCCOPY,
};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_SWITCHDESKTOP};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIGDN_NORMALDISPLAY, SIIGBF_ICONONLY};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

pub fn init() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

pub fn permissions() -> Value {
    // Windows has no screen-recording or accessibility consent gate.
    permissions_json(true, true)
}

pub fn preflight() -> Option<&'static str> {
    None
}

pub fn idle_seconds() -> f64 {
    unsafe {
        let mut li = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        let _ = GetLastInputInfo(&mut li);
        GetTickCount().wrapping_sub(li.dwTime) as f64 / 1000.0
    }
}

/// The lock screen and UAC run on the secure desktop, which a normal process
/// cannot open as the input desktop.
pub fn session_locked() -> bool {
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_SWITCHDESKTOP) {
            Ok(h) => {
                let _ = CloseDesktop(h);
                false
            }
            Err(_) => true,
        }
    }
}

// ------------------------------------------------------------ process info

#[derive(Clone, Default)]
struct ProcInfo {
    bundle_id: String,
    name: String,
    version: String,
    path: String,
}

static PROC_CACHE: Mutex<Option<HashMap<u32, (Instant, ProcInfo)>>> = Mutex::new(None);

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn hwnd_id(h: HWND) -> u64 {
    h.0 as usize as u64
}

fn hwnd_from(id: u64) -> HWND {
    HWND(id as usize as *mut c_void)
}

fn exe_and_aumid(pid: u32) -> Option<(String, Option<String>)> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let path = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
            .ok()
            .map(|_| String::from_utf16_lossy(&buf[..len as usize]));
        let mut abuf = [0u16; 256];
        let mut alen = abuf.len() as u32;
        let aumid = (GetApplicationUserModelId(h, &mut alen, PWSTR(abuf.as_mut_ptr())) == ERROR_SUCCESS)
            .then(|| wide_to_string(&abuf));
        let _ = CloseHandle(h);
        path.map(|p| (p, aumid))
    }
}

fn version_info(path: &str) -> (String, String) {
    unsafe {
        let wpath = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&wpath, None);
        if size == 0 {
            return (String::new(), String::new());
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(&wpath, 0, size, data.as_mut_ptr() as *mut c_void).is_err() {
            return (String::new(), String::new());
        }
        let mut version = String::new();
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(data.as_ptr() as *const c_void, &HSTRING::from("\\"), &mut ptr, &mut len).as_bool()
            && !ptr.is_null()
            && len as usize >= size_of::<VS_FIXEDFILEINFO>()
        {
            let fi = &*(ptr as *const VS_FIXEDFILEINFO);
            version = format!("{}.{}.{}.{}", fi.dwFileVersionMS >> 16, fi.dwFileVersionMS & 0xffff, fi.dwFileVersionLS >> 16, fi.dwFileVersionLS & 0xffff);
        }
        let mut name = String::new();
        if VerQueryValueW(data.as_ptr() as *const c_void, &HSTRING::from("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool()
            && !ptr.is_null()
            && len >= 4
        {
            let t = std::slice::from_raw_parts(ptr as *const u16, 2);
            let key = HSTRING::from(format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", t[0], t[1]));
            if VerQueryValueW(data.as_ptr() as *const c_void, &key, &mut ptr, &mut len).as_bool() && !ptr.is_null() && len > 0 {
                let s = std::slice::from_raw_parts(ptr as *const u16, len as usize);
                name = wide_to_string(s);
            }
        }
        (name, version)
    }
}

fn proc_info(pid: u32) -> Option<ProcInfo> {
    let mut guard = PROC_CACHE.lock().ok()?;
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((at, info)) = cache.get(&pid) {
        if at.elapsed() < Duration::from_secs(30) {
            return Some(info.clone());
        }
    }
    let (path, aumid) = exe_and_aumid(pid)?;
    let file = Path::new(&path).file_name()?.to_string_lossy().to_lowercase();
    let (desc, version) = version_info(&path);
    let stem = Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let info = ProcInfo {
        bundle_id: aumid.filter(|a| !a.is_empty()).unwrap_or(file),
        name: if desc.trim().is_empty() { stem } else { desc.trim().to_string() },
        version,
        path,
    };
    cache.insert(pid, (Instant::now(), info.clone()));
    Some(info)
}

/// Windows hosts UWP windows in `ApplicationFrameHost.exe`; the app's own
/// process owns a `CoreWindow` child.
fn real_pid(hwnd: HWND, host_pid: u32) -> u32 {
    let is_frame_host = proc_info(host_pid).map(|p| p.bundle_id == "applicationframehost.exe").unwrap_or(false);
    if !is_frame_host {
        return host_pid;
    }
    struct Ctx {
        host: u32,
        found: u32,
    }
    unsafe extern "system" fn cb(child: HWND, lp: LPARAM) -> BOOL {
        let ctx = &mut *(lp.0 as *mut Ctx);
        let pid = window_pid(child);
        if pid != ctx.host && pid != 0 {
            ctx.found = pid;
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut ctx = Ctx { host: host_pid, found: 0 };
    unsafe {
        let _ = EnumChildWindows(hwnd, Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    if ctx.found != 0 {
        ctx.found
    } else {
        host_pid
    }
}

fn frame_rect(hwnd: HWND) -> Option<Rect> {
    unsafe {
        let mut r = RECT::default();
        let ok = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut c_void, size_of::<RECT>() as u32).is_ok();
        if !ok && GetWindowRect(hwnd, &mut r).is_err() {
            return None;
        }
        Some(Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
    }
}

pub fn foreground() -> Option<Foreground> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let pid = real_pid(hwnd, window_pid(hwnd));
        let info = proc_info(pid).unwrap_or_default();
        Some(Foreground {
            id: hwnd_id(hwnd),
            pid,
            bundle_id: info.bundle_id,
            name: info.name,
            version: info.version,
            title: window_text(hwnd),
            rect: frame_rect(hwnd),
        })
    }
}

pub fn windows(fg: &Foreground) -> Vec<WinInfo> {
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        (*(lp.0 as *mut Vec<HWND>)).push(hwnd);
        BOOL(1)
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    let mut out = Vec::new();
    for hwnd in all {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
            if cloaked != 0 {
                continue;
            }
            let Some(rect) = frame_rect(hwnd) else { continue };
            if rect.w < 2 || rect.h < 2 {
                continue;
            }
            let title = window_text(hwnd);
            let class = class_name(hwnd);
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let is_fg = hwnd_id(hwnd) == fg.id;
            // Titleless windows are shell chrome or invisible helpers; keep menus and the focused window.
            if title.is_empty() && class != "#32768" && !is_fg {
                continue;
            }
            if ex & WS_EX_TOOLWINDOW.0 != 0 && title.is_empty() && class != "#32768" {
                continue;
            }
            if class == "Progman" || class == "WorkerW" {
                continue;
            }
            let pid = real_pid(hwnd, window_pid(hwnd));
            let info = proc_info(pid).unwrap_or_default();
            out.push(WinInfo { id: hwnd_id(hwnd), pid, bundle_id: info.bundle_id, app_name: info.name, title, rect, focused: is_fg });
        }
    }
    out
}

// ------------------------------------------------------------------ screen

pub fn screenshot(focus: Option<Rect>) -> Result<Shot> {
    unsafe {
        let mon = match focus {
            Some(r) => MonitorFromPoint(windows::Win32::Foundation::POINT { x: r.x + r.w / 2, y: r.y + r.h / 2 }, MONITOR_DEFAULTTONEAREST),
            None => MonitorFromPoint(windows::Win32::Foundation::POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY),
        };
        let mut mi = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            bail!("no_display");
        }
        let r = mi.rcMonitor;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 {
            bail!("no_display");
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(screen);
        let bmp: HBITMAP = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let blit = BitBlt(mem, 0, 0, w, h, screen, r.left, r.top, SRCCOPY | CAPTUREBLT);
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        blit.map_err(|e| anyhow!("BitBlt: {e}"))?;
        if lines == 0 {
            bail!("GetDIBits failed");
        }
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for px in buf.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        let image = RgbImage::from_raw(w as u32, h as u32, rgb).ok_or_else(|| anyhow!("frame buffer size"))?;
        Ok(Shot { image, display: Display { id: mon.0 as i64, rect: Rect { x: r.left, y: r.top, w, h } } })
    }
}

// ------------------------------------------------------ UI Automation (AX)

thread_local! {
    static UIA: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

fn automation() -> Option<IUIAutomation> {
    UIA.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = unsafe { CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() };
        }
        slot.clone()
    })
}

fn role_name(id: UIA_CONTROLTYPE_ID) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu", "MenuBar",
        "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text",
        "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem", "Document",
        "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar",
    ];
    NAMES.get((id.0 - 50000) as usize).copied().unwrap_or("Unknown")
}

fn element_value(el: &IUIAutomationElement) -> Option<String> {
    let pattern = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok()?;
    let v = unsafe { pattern.CurrentValue() }.ok()?.to_string();
    (!v.is_empty()).then_some(v)
}

fn ax_node(auto: &IUIAutomation, walker: &IUIAutomationTreeWalker, el: &IUIAutomationElement, depth: usize, max_depth: usize, budget: &mut usize) -> Option<Value> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let mut node = Map::new();
    let ct = unsafe { el.CurrentControlType() }.unwrap_or_default();
    node.insert("role".into(), json!(format!("UIA{}", role_name(ct))));
    if let Ok(n) = unsafe { el.CurrentName() } {
        if !n.is_empty() {
            node.insert("title".into(), json!(n.to_string()));
        }
    }
    if let Ok(n) = unsafe { el.CurrentHelpText() } {
        if !n.is_empty() {
            node.insert("description".into(), json!(n.to_string()));
        }
    }
    let valued = [UIA_EditControlTypeId, UIA_DocumentControlTypeId, UIA_ComboBoxControlTypeId, UIA_TextControlTypeId, UIA_SpinnerControlTypeId, UIA_SliderControlTypeId, UIA_HyperlinkControlTypeId];
    if valued.contains(&ct) {
        if let Some(v) = element_value(el) {
            node.insert("value".into(), json!(v.chars().take(4000).collect::<String>()));
        }
    }
    if let Ok(r) = unsafe { el.CurrentBoundingRectangle() } {
        node.insert("x".into(), json!(r.left));
        node.insert("y".into(), json!(r.top));
        node.insert("w".into(), json!(r.right - r.left));
        node.insert("h".into(), json!(r.bottom - r.top));
    }
    if unsafe { el.CurrentIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false) {
        node.insert("hidden".into(), json!(true));
    }
    if !unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true) {
        node.insert("disabled".into(), json!(true));
    }
    let first = unsafe { walker.GetFirstChildElement(el) }.ok();
    if depth < max_depth {
        let mut kids = Vec::new();
        let mut child = first;
        while let Some(c) = child {
            let Some(k) = ax_node(auto, walker, &c, depth + 1, max_depth, budget) else { break };
            kids.push(k);
            child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
        }
        if !kids.is_empty() {
            node.insert("children".into(), Value::Array(kids));
        }
    } else if first.is_some() {
        node.insert("truncated".into(), json!(true));
    }
    Some(Value::Object(node))
}

pub fn ax_tree(fg: &Foreground, max_depth: usize, max_nodes: usize) -> Option<AxResult> {
    let auto = automation()?;
    let root = unsafe { auto.ElementFromHandle(hwnd_from(fg.id)) }.ok()?;
    let walker = unsafe { auto.ControlViewWalker() }.ok()?;
    let mut budget = max_nodes;
    let tree = ax_node(&auto, &walker, &root, 0, max_depth, &mut budget)?;
    Some(AxResult { tree, node_count: max_nodes - budget, partial: budget == 0 })
}

const BROWSERS: &[&str] = &["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe", "firefox.exe", "arc.exe", "chromium.exe", "librewolf.exe", "zen.exe"];

fn looks_like_url(v: &str) -> bool {
    let v = v.trim();
    !v.contains(' ') && (v.contains("://") || v.contains('.') || v.starts_with("localhost"))
}

/// Address-bar text of a browser window: first Edit control (breadth first,
/// so the toolbar wins over page content) whose value looks like a URL.
pub fn browser_url(fg: &Foreground) -> Option<String> {
    if !BROWSERS.contains(&fg.bundle_id.to_lowercase().as_str()) {
        return None;
    }
    let auto = automation()?;
    let root = unsafe { auto.ElementFromHandle(hwnd_from(fg.id)) }.ok()?;
    let walker = unsafe { auto.ControlViewWalker() }.ok()?;
    let mut queue = std::collections::VecDeque::from([root]);
    let mut visited = 0;
    while let Some(el) = queue.pop_front() {
        visited += 1;
        if visited > 900 {
            break;
        }
        if unsafe { el.CurrentControlType() }.map(|c| c == UIA_EditControlTypeId).unwrap_or(false) {
            if let Some(v) = element_value(&el) {
                if looks_like_url(&v) {
                    let v = v.trim().to_string();
                    return Some(if v.contains("://") { v } else { format!("https://{v}") });
                }
            }
        }
        let mut child = unsafe { walker.GetFirstChildElement(&el) }.ok();
        while let Some(c) = child {
            child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
            queue.push_back(c);
        }
    }
    None
}

// --------------------------------------------------------------------- OCR

thread_local! {
    static OCR_ENGINE: RefCell<HashMap<String, OcrEngine>> = RefCell::new(HashMap::new());
}

fn ocr_engine(langs: &[String]) -> Result<OcrEngine> {
    let key = langs.join(",");
    if let Some(e) = OCR_ENGINE.with(|m| m.borrow().get(&key).cloned()) {
        return Ok(e);
    }
    let mut engine = None;
    for tag in langs {
        if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(tag.as_str())) {
            if let Ok(e) = OcrEngine::TryCreateFromLanguage(&lang) {
                engine = Some(e);
                break;
            }
        }
    }
    let engine = match engine {
        Some(e) => e,
        None => OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| anyhow!("ocr_unavailable: no Windows OCR language pack installed (Settings > Time & language > Language)"))?,
    };
    OCR_ENGINE.with(|m| m.borrow_mut().insert(key, engine.clone()));
    Ok(engine)
}

fn block<T: windows::core::RuntimeType + 'static>(op: IAsyncOperation<T>) -> Result<T> {
    op.get().map_err(|e| anyhow!("{e}"))
}

pub fn ocr(_path: &str, img: &RgbaImage, _level: &str, langs: &[String]) -> Result<Vec<Word>> {
    let engine = ocr_engine(langs)?;
    let max = OcrEngine::MaxImageDimension().unwrap_or(10000);
    let (mut w, mut h) = (img.width(), img.height());
    let scaled;
    let mut src = img;
    let mut factor = 1.0f64;
    if w.max(h) > max {
        factor = max as f64 / w.max(h) as f64;
        w = (w as f64 * factor) as u32;
        h = (h as f64 * factor) as u32;
        scaled = image::imageops::resize(img, w, h, FilterType::Triangle);
        src = &scaled;
    }
    let mut bgra = Vec::with_capacity(src.as_raw().len());
    for p in src.pixels() {
        bgra.extend_from_slice(&[p.0[2], p.0[1], p.0[0], 255]);
    }
    let writer = DataWriter::new()?;
    writer.WriteBytes(&bgra)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w as i32, h as i32, BitmapAlphaMode::Ignore)?;
    let result = block(engine.RecognizeAsync(&bitmap)?)?;
    let mut words = Vec::new();
    for line in result.Lines()? {
        for word in line.Words()? {
            let r = word.BoundingRect()?;
            words.push(Word {
                rect: Rect {
                    x: (r.X as f64 / factor) as i32,
                    y: (r.Y as f64 / factor) as i32,
                    w: ((r.Width as f64 / factor) as i32).max(1),
                    h: ((r.Height as f64 / factor) as i32).max(1),
                },
                text: word.Text()?.to_string(),
                // Windows.Media.Ocr reports no confidence.
                confidence: 1.0,
            });
        }
    }
    Ok(words)
}

// ------------------------------------------------------------------- icons

fn exe_path_for(bundle_id: &str) -> Option<String> {
    if let Ok(g) = PROC_CACHE.lock() {
        if let Some(c) = g.as_ref() {
            if let Some((_, i)) = c.values().find(|(_, i)| i.bundle_id.eq_ignore_ascii_case(bundle_id)) {
                return Some(i.path.clone());
            }
        }
    }
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                if wide_to_string(&entry.szExeFile).eq_ignore_ascii_case(bundle_id) {
                    found = exe_and_aumid(entry.th32ProcessID).map(|(p, _)| p);
                    if found.is_some() {
                        break;
                    }
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

pub fn icon(bundle_id: &str, size: u32) -> Result<IconResult> {
    let target = if bundle_id.contains('!') {
        format!("shell:AppsFolder\\{bundle_id}")
    } else {
        exe_path_for(bundle_id).ok_or_else(|| anyhow!("app_not_found"))?
    };
    unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(target.as_str()), None).map_err(|_| anyhow!("app_not_found"))?;
        let factory: IShellItemImageFactory = item.cast()?;
        let hbm = factory.GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF_ICONONLY).map_err(|_| anyhow!("icon_render"))?;
        let (w, h) = (size as i32, size as i32);
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(screen);
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(mem, hbm, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines == 0 {
            bail!("icon_render");
        }
        let mut rgba = Vec::with_capacity(buf.len());
        for p in buf.chunks_exact(4) {
            rgba.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
        let image = RgbaImage::from_raw(size, size, rgba).ok_or_else(|| anyhow!("icon_render"))?;
        let display_name = if bundle_id.contains('!') {
            item.GetDisplayName(SIGDN_NORMALDISPLAY).ok().map(|p| {
                let s = p.to_string().unwrap_or_default();
                windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const c_void));
                s
            })
        } else {
            let d = version_info(&target).0;
            (!d.trim().is_empty()).then(|| d.trim().to_string())
        }
        .unwrap_or_else(|| bundle_id.trim_end_matches(".exe").to_string());
        Ok(IconResult { image, display_name })
    }
}

// ------------------------------------------------------- Media Foundation

fn mf_startup() -> Result<()> {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let mut result = Ok(());
    ONCE.call_once(|| {
        result = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|e| anyhow!("MFStartup: {e}"));
    });
    result
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

/// Planar Y plus interleaved UV, BT.601 limited range.
fn rgb_to_nv12(img: &RgbImage) -> Vec<u8> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut out = vec![0u8; w * h * 3 / 2];
    let raw = img.as_raw();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 3;
            let (r, g, b) = (raw[i] as i32, raw[i + 1] as i32, raw[i + 2] as i32);
            out[y * w + x] = (16 + ((66 * r + 129 * g + 25 * b + 128) >> 8)).clamp(0, 255) as u8;
        }
    }
    let uv = &mut out[w * h..];
    for y in (0..h).step_by(2) {
        for x in (0..w).step_by(2) {
            let (mut r, mut g, mut b) = (0, 0, 0);
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let i = ((y + dy).min(h - 1) * w + (x + dx).min(w - 1)) * 3;
                r += raw[i] as i32;
                g += raw[i + 1] as i32;
                b += raw[i + 2] as i32;
            }
            let (r, g, b) = (r / 4, g / 4, b / 4);
            let o = (y / 2) * w + x;
            uv[o] = (128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8)).clamp(0, 255) as u8;
            uv[o + 1] = (128 + ((112 * r - 94 * g - 18 * b + 128) >> 8)).clamp(0, 255) as u8;
        }
    }
    out
}

pub fn encode(inputs: &[String], out: &str, w: u32, h: u32, quality: f64) -> Result<usize> {
    mf_startup()?;
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 2)?;
        let attrs = attrs.ok_or_else(|| anyhow!("MFCreateAttributes"))?;
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 0)?;
        let writer = MFCreateSinkWriterFromURL(&HSTRING::from(out), None, &attrs)?;

        // 1 fps screen content: ~0.05-0.35 bits per pixel per frame.
        let bitrate = ((w as f64 * h as f64) * (0.05 + 0.3 * quality.clamp(0.0, 1.0))).max(50_000.0) as u32;
        let out_type = MFCreateMediaType()?;
        out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
        out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(1, 1))?;
        out_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, 77)?; // eAVEncH264VProfile_Main
        out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, 30)?;
        let stream = writer.AddStream(&out_type)?;

        let in_type = MFCreateMediaType()?;
        in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(1, 1))?;
        in_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        in_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, w)?;
        writer.SetInputMediaType(stream, &in_type, None)?;
        writer.BeginWriting()?;

        let mut written = 0usize;
        for (i, path) in inputs.iter().enumerate() {
            let Ok(img) = load_rgb_fit(path, w, h) else { continue };
            let nv12 = rgb_to_nv12(&img);
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut ptr: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(i as i64 * 10_000_000)?;
            sample.SetSampleDuration(10_000_000)?;
            writer.WriteSample(stream, &sample)?;
            written += 1;
        }
        writer.Finalize()?;
        Ok(written)
    }
}

struct VideoReader {
    reader: IMFSourceReader,
    w: usize,
    h: usize,
    stride: i32,
}

const FIRST_VIDEO_STREAM: u32 = 0xFFFF_FFFC;
const ALL_STREAMS: u32 = 0xFFFF_FFFE;

fn open_reader(path: &str) -> Result<VideoReader> {
    mf_startup()?;
    unsafe {
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 2)?;
        let attrs = attrs.ok_or_else(|| anyhow!("MFCreateAttributes"))?;
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path), &attrs)?;
        reader.SetStreamSelection(ALL_STREAMS, false)?;
        reader.SetStreamSelection(FIRST_VIDEO_STREAM, true)?;
        let mt = MFCreateMediaType()?;
        mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        reader.SetCurrentMediaType(FIRST_VIDEO_STREAM, None, &mt)?;
        let cur = reader.GetCurrentMediaType(FIRST_VIDEO_STREAM)?;
        let size = cur.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let (w, h) = ((size >> 32) as usize, (size & 0xffff_ffff) as usize);
        let stride = cur.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or((w * 4) as i32);
        Ok(VideoReader { reader, w, h, stride })
    }
}

impl VideoReader {
    /// Next decoded frame and its timestamp (100 ns units).
    fn next(&self) -> Result<Option<(i64, RgbImage)>> {
        unsafe {
            loop {
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                self.reader.ReadSample(FIRST_VIDEO_STREAM, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Ok(None);
                }
                let Some(sample) = sample else { continue };
                let buffer = sample.ConvertToContiguousBuffer()?;
                let mut ptr: *mut u8 = std::ptr::null_mut();
                let mut len = 0u32;
                buffer.Lock(&mut ptr, None, Some(&mut len))?;
                let data = std::slice::from_raw_parts(ptr, len as usize);
                let row = self.stride.unsigned_abs() as usize;
                let mut rgb = Vec::with_capacity(self.w * self.h * 3);
                for y in 0..self.h {
                    // Negative stride: the buffer holds the bottom row first.
                    let src_row = if self.stride < 0 { self.h - 1 - y } else { y };
                    let line = data.get(src_row * row..src_row * row + self.w * 4);
                    let Some(line) = line else { break };
                    for px in line.chunks_exact(4) {
                        rgb.extend_from_slice(&[px[2], px[1], px[0]]);
                    }
                }
                buffer.Unlock()?;
                let img = RgbImage::from_raw(self.w as u32, self.h as u32, rgb).ok_or_else(|| anyhow!("decoded frame size"))?;
                return Ok(Some((ts, img)));
            }
        }
    }
}

/// Frame `index` of a 1 fps chunk (frame i at t = i s).
pub fn extract_frame(video: &str, index: usize) -> Result<RgbImage> {
    let r = open_reader(video)?;
    let target = index as i64 * 10_000_000;
    while let Some((ts, img)) = r.next()? {
        if ts >= target - 5_000_000 {
            return Ok(img);
        }
    }
    bail!("frame {index} not in {video}")
}

pub fn extract_all(video: &str, frames: usize, dir: &Path) -> Result<Vec<PathBuf>> {
    let r = open_reader(video)?;
    let mut paths = Vec::new();
    while paths.len() < frames {
        let Some((_, img)) = r.next()? else { break };
        let p = dir.join(format!("{:05}.jpg", paths.len()));
        write_jpeg(&DynamicImage::ImageRgb8(img), &p.to_string_lossy(), 0.9)?;
        paths.push(p);
    }
    Ok(paths)
}
