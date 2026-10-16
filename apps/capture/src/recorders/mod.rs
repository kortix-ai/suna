use crate::{config::Config, utils::Event};
use anyhow::Result;
#[cfg(feature = "native-recorders")]
use anyhow::{bail, Context};
#[cfg(feature = "native-recorders")]
use base64::{engine::general_purpose, Engine as _};
#[cfg(feature = "native-recorders")]
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, RgbaImage};
use serde_json::{json, Value};
#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
use std::collections::{BTreeSet, HashMap, HashSet};
#[cfg(feature = "native-recorders")]
use std::sync::Condvar;
#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
use std::sync::OnceLock;
#[cfg(all(feature = "native-recorders", target_os = "windows"))]
use std::sync::{
    atomic::{AtomicU64, AtomicUsize},
    mpsc::{self, Receiver, SyncSender, TrySendError},
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(all(feature = "native-recorders", target_os = "macos"))]
mod macos;
#[cfg(all(feature = "native-recorders", target_os = "windows"))]
mod windows_a11y;

pub type EventCallback = Arc<dyn Fn(Event) + Send + Sync + 'static>;
pub(crate) type A11yHashHistory = Arc<Mutex<std::collections::VecDeque<u64>>>;

pub trait Recorder: Send {
    fn start(&mut self) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
}

#[derive(Clone)]
struct ActivityTracker {
    last_activity: Arc<Mutex<Instant>>,
}

impl ActivityTracker {
    fn new() -> Self {
        Self {
            last_activity: Arc::new(Mutex::new(Instant::now())),
        }
    }

    fn mark(&self) {
        *lock_unpoisoned(&self.last_activity) = Instant::now();
    }

    fn elapsed(&self) -> Duration {
        lock_unpoisoned(&self.last_activity).elapsed()
    }
}

pub struct RecorderBundle {
    recorders: Vec<Box<dyn Recorder>>,
}

pub fn audio_supported() -> bool {
    false
}

impl RecorderBundle {
    pub fn new(
        callback: EventCallback,
        config: &Config,
        enable_audio: bool,
        audio_path: Option<PathBuf>,
        a11y_hash_history: Option<A11yHashHistory>,
    ) -> Self {
        let mut recorders: Vec<Box<dyn Recorder>> = Vec::new();
        let activity = ActivityTracker::new();
        #[cfg(feature = "native-recorders")]
        let screenshot_capture_mode =
            ScreenshotCaptureMode::from_config(config.get_string("screen_recorder.capture_mode"));

        let input_callback: EventCallback = {
            let callback = callback.clone();
            let activity = activity.clone();
            Arc::new(move |event| {
                if event_marks_screenshot_activity(&event) {
                    activity.mark();
                }
                callback(event);
            })
        };

        recorders.push(Box::new(InputRecorderImpl::new(input_callback)));
        recorders.push(Box::new(ScreenRecorderImpl::new(
            callback.clone(),
            config.get_u32("screen_recorder.fps", 10),
            config.get_u32("screen_recorder.burst_fps", 15),
            config.get_f64("screen_recorder.burst_after_seconds", 1.0),
            config.get_f64("screen_recorder.idle_after_seconds", 3.0),
            config.get_f64("screen_recorder.idle_interval_seconds", 15.0),
            config.get_u32("screen_recorder.idle_dedupe_distance", 3),
            config.get_f64("screen_recorder.idle_heartbeat_seconds", 300.0),
            config.get_f64("screen_recorder.scale_factor", 0.5),
            config.get_u32("screen_recorder.quality", 60),
            configured_screen_frame_queue_capacity(config),
            activity,
            #[cfg(feature = "native-recorders")]
            screenshot_capture_mode,
        )));

        #[cfg(all(
            feature = "native-recorders",
            any(target_os = "macos", target_os = "windows")
        ))]
        let a11y_enabled = config.get_bool("a11y_recorder.enabled", false);

        #[cfg(all(feature = "native-recorders", target_os = "macos"))]
        if a11y_enabled {
            recorders.push(Box::new(macos::MacosA11yRecorder::new(
                callback,
                config.get_f64("a11y_recorder.interval_seconds", 10.0),
                config.get_u32("a11y_recorder.max_depth", 12),
                config.get_usize("a11y_recorder.max_children", 200),
                config.get_f64("screen_recorder.scale_factor", 0.5),
                config.get_u32("screen_recorder.quality", 60),
                screenshot_capture_mode,
            )));
        }

        #[cfg(all(feature = "native-recorders", target_os = "windows"))]
        if a11y_enabled {
            recorders.push(Box::new(windows_a11y::WindowsA11yRecorder::new(
                callback.clone(),
                config.get_f64("a11y_recorder.interval_seconds", 10.0),
                config.get_u32("a11y_recorder.max_depth", 12),
                config.get_usize("a11y_recorder.max_children", 200),
                config.get_usize("a11y_recorder.max_nodes", 3000),
                config.get_f64("screen_recorder.scale_factor", 0.5),
                config.get_u32("screen_recorder.quality", 60),
                screenshot_capture_mode,
                a11y_hash_history.clone(),
            )));
        }

        let _ = &a11y_hash_history;

        if enable_audio && !audio_supported() {
            if let Some(audio_path) = audio_path {
                tracing::warn!(
                    "audio recording unavailable in Rust recorder; no audio file will be created at {}",
                    audio_path.display()
                );
            }
        }

        Self { recorders }
    }

    pub fn start(&mut self) -> Result<()> {
        for index in 0..self.recorders.len() {
            if let Err(err) = self.recorders[index].start() {
                for recorder in self.recorders[..index].iter_mut().rev() {
                    if let Err(stop_err) = recorder.stop() {
                        tracing::warn!("failed to stop recorder after startup error: {stop_err:#}");
                    }
                }
                return Err(err);
            }
        }
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        for recorder in &mut self.recorders {
            recorder.stop()?;
        }
        Ok(())
    }
}

fn event_marks_screenshot_activity(event: &Event) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("mouse_move") => event
            .get("data")
            .and_then(Value::as_object)
            .and_then(|data| data.get("is_dragging"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        Some(_) => true,
        None => false,
    }
}

#[cfg(all(feature = "native-recorders", target_os = "macos"))]
type InputRecorderImpl = macos::MacosInputRecorder;
#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
type InputRecorderImpl = NativeInputRecorder;
#[cfg(not(feature = "native-recorders"))]
type InputRecorderImpl = InputRecorderPlaceholder;

#[cfg(feature = "native-recorders")]
type ScreenRecorderImpl = NativeScreenRecorder;
#[cfg(not(feature = "native-recorders"))]
type ScreenRecorderImpl = ScreenRecorderPlaceholder;

#[cfg(target_os = "windows")]
const DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY: usize = 8;
#[cfg(not(target_os = "windows"))]
const DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY: usize = 50;
#[cfg(feature = "native-recorders")]
const MAX_SCREEN_FRAME_QUEUE_CAPACITY: usize = 120;

fn configured_screen_frame_queue_capacity(config: &Config) -> usize {
    let default = config.get_usize(
        "screen_recorder.frame_queue_capacity",
        DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY,
    );
    #[cfg(target_os = "windows")]
    {
        config.get_usize("screen_recorder.windows_frame_queue_capacity", default)
    }
    #[cfg(not(target_os = "windows"))]
    {
        default
    }
}

#[cfg(feature = "native-recorders")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ScreenshotCaptureMode {
    Stitched,
    AllDisplays,
}

#[cfg(feature = "native-recorders")]
impl ScreenshotCaptureMode {
    fn from_config(value: Option<String>) -> Self {
        let normalized = value
            .as_deref()
            .unwrap_or("all_displays")
            .trim()
            .to_ascii_lowercase();
        match normalized.as_str() {
            "" | "all_displays" | "all-displays" | "all" => Self::AllDisplays,
            "stitched" | "stitch" => Self::Stitched,
            _ => Self::Stitched,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Stitched => "stitched",
            Self::AllDisplays => "all_displays",
        }
    }
}

#[cfg(feature = "native-recorders")]
struct RawScreenshotFrame {
    frame_id: u64,
    timestamp: f64,
    capture_started_timestamp: f64,
    target_interval: Duration,
    capture_duration: Duration,
    capture: CapturedDesktop,
    enqueued_at: Instant,
    raw_queue_depth: usize,
    dropped_raw_frames: u64,
}

#[cfg(feature = "native-recorders")]
struct ScreenshotFrameQueue {
    capacity: usize,
    inner: Mutex<ScreenshotFrameQueueState>,
    available: Condvar,
}

#[cfg(feature = "native-recorders")]
struct ScreenshotFrameQueueState {
    frames: std::collections::VecDeque<RawScreenshotFrame>,
    closed: bool,
    dropped_raw_frames: u64,
}

#[cfg(feature = "native-recorders")]
impl ScreenshotFrameQueue {
    fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            capacity,
            inner: Mutex::new(ScreenshotFrameQueueState {
                frames: std::collections::VecDeque::with_capacity(capacity),
                closed: false,
                dropped_raw_frames: 0,
            }),
            available: Condvar::new(),
        }
    }

    fn push_drop_oldest(&self, mut frame: RawScreenshotFrame) -> bool {
        let mut state = lock_unpoisoned(&self.inner);
        if state.closed {
            return false;
        }
        if state.frames.len() == self.capacity {
            state.frames.pop_front();
            state.dropped_raw_frames = state.dropped_raw_frames.saturating_add(1);
        }
        frame.raw_queue_depth = state.frames.len() + 1;
        frame.dropped_raw_frames = state.dropped_raw_frames;
        state.frames.push_back(frame);
        self.available.notify_one();
        true
    }

    fn pop(&self) -> Option<RawScreenshotFrame> {
        let mut state = lock_unpoisoned(&self.inner);
        loop {
            if let Some(frame) = state.frames.pop_front() {
                return Some(frame);
            }
            if state.closed {
                return None;
            }
            state = self
                .available
                .wait(state)
                .unwrap_or_else(|err| err.into_inner());
        }
    }

    fn close(&self) {
        let mut state = lock_unpoisoned(&self.inner);
        state.closed = true;
        self.available.notify_all();
    }
}

#[cfg(feature = "native-recorders")]
struct NativeScreenRecorder {
    callback: EventCallback,
    fps: u32,
    burst_fps: u32,
    burst_after: Duration,
    idle_after: Duration,
    idle_interval: Duration,
    idle_dedupe_distance: u32,
    idle_heartbeat: Duration,
    scale_factor: f64,
    quality: u32,
    frame_queue_capacity: usize,
    activity: ActivityTracker,
    capture_mode: ScreenshotCaptureMode,
    running: Arc<AtomicBool>,
    frame_queue: Option<Arc<ScreenshotFrameQueue>>,
    capture_thread: Option<JoinHandle<()>>,
    encode_thread: Option<JoinHandle<()>>,
}

#[cfg(feature = "native-recorders")]
impl NativeScreenRecorder {
    #[allow(clippy::too_many_arguments)]
    fn new(
        callback: EventCallback,
        fps: u32,
        burst_fps: u32,
        burst_after_seconds: f64,
        idle_after_seconds: f64,
        idle_interval_seconds: f64,
        idle_dedupe_distance: u32,
        idle_heartbeat_seconds: f64,
        scale_factor: f64,
        quality: u32,
        frame_queue_capacity: usize,
        activity: ActivityTracker,
        capture_mode: ScreenshotCaptureMode,
    ) -> Self {
        Self {
            callback,
            fps,
            burst_fps,
            burst_after: seconds_duration(burst_after_seconds, 1.0),
            idle_after: seconds_duration(idle_after_seconds, 3.0),
            idle_interval: seconds_duration(idle_interval_seconds, 15.0),
            idle_dedupe_distance,
            idle_heartbeat: seconds_duration(idle_heartbeat_seconds, 300.0),
            scale_factor,
            quality,
            frame_queue_capacity: sanitize_screen_frame_queue_capacity(frame_queue_capacity),
            activity,
            capture_mode,
            running: Arc::new(AtomicBool::new(false)),
            frame_queue: None,
            capture_thread: None,
            encode_thread: None,
        }
    }
}

#[cfg(feature = "native-recorders")]
impl Recorder for NativeScreenRecorder {
    fn start(&mut self) -> Result<()> {
        if self.capture_thread.is_some() || self.encode_thread.is_some() {
            return Ok(());
        }

        // Probe once so recording startup reports permission/display issues instead of
        // silently starting a worker that can never capture a frame.
        let probe = capture_desktop_capture(self.capture_mode)
            .context("failed to capture initial screenshot")?;
        drop(probe);

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let fps = self.fps.max(1);
        let burst_fps = self.burst_fps.max(fps);
        let burst_after = self.burst_after;
        let idle_after = self.idle_after;
        let idle_interval = self.idle_interval;
        let idle_dedupe_distance = self.idle_dedupe_distance;
        let idle_heartbeat = self.idle_heartbeat;
        let activity = self.activity.clone();
        let scale_factor = sanitize_scale_factor(self.scale_factor);
        let quality = self.quality.clamp(1, 100) as u8;
        let capture_mode = self.capture_mode;
        let frame_queue = Arc::new(ScreenshotFrameQueue::new(self.frame_queue_capacity));
        let encode_queue = frame_queue.clone();
        let callback = self.callback.clone();

        let encode_thread = thread::Builder::new()
            .name("kortix-screen-encoder".to_string())
            .spawn(move || {
                encode_screenshot_frames(encode_queue, callback, scale_factor, quality);
            })
            .context("failed to spawn native screen encoder thread")?;

        let capture_queue = frame_queue.clone();
        let capture_thread = match thread::Builder::new()
            .name("kortix-screen-recorder".to_string())
            .spawn(move || {
                capture_screenshot_frames(
                    running,
                    capture_queue,
                    activity,
                    capture_mode,
                    fps,
                    burst_fps,
                    idle_interval,
                    idle_dedupe_distance,
                    idle_heartbeat,
                    burst_after,
                    idle_after,
                    scale_factor,
                );
            }) {
            Ok(thread) => thread,
            Err(err) => {
                self.running.store(false, Ordering::SeqCst);
                frame_queue.close();
                let _ = encode_thread.join();
                return Err(err).context("failed to spawn native screen recorder thread");
            }
        };

        self.frame_queue = Some(frame_queue);
        self.capture_thread = Some(capture_thread);
        self.encode_thread = Some(encode_thread);
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }
        if let Some(queue) = self.frame_queue.take() {
            queue.close();
        }
        if let Some(thread) = self.encode_thread.take() {
            let _ = thread.join();
        }
        Ok(())
    }
}

#[cfg(not(feature = "native-recorders"))]
struct ScreenRecorderPlaceholder {
    callback: EventCallback,
    fps: u32,
    burst_fps: u32,
    burst_after: Duration,
    idle_interval: Duration,
    idle_after: Duration,
    scale_factor: f64,
    quality: u32,
    _frame_queue_capacity: usize,
    activity: ActivityTracker,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(not(feature = "native-recorders"))]
impl ScreenRecorderPlaceholder {
    fn new(
        callback: EventCallback,
        fps: u32,
        burst_fps: u32,
        burst_after_seconds: f64,
        idle_after_seconds: f64,
        idle_interval_seconds: f64,
        _idle_dedupe_distance: u32,
        _idle_heartbeat_seconds: f64,
        scale_factor: f64,
        quality: u32,
        frame_queue_capacity: usize,
        activity: ActivityTracker,
    ) -> Self {
        Self {
            callback,
            fps,
            burst_fps,
            burst_after: seconds_duration(burst_after_seconds, 1.0),
            idle_interval: seconds_duration(idle_interval_seconds, 15.0),
            idle_after: seconds_duration(idle_after_seconds, 3.0),
            scale_factor,
            quality,
            _frame_queue_capacity: frame_queue_capacity,
            activity,
            running: Arc::new(AtomicBool::new(false)),
            thread: None,
        }
    }
}

#[cfg(not(feature = "native-recorders"))]
impl Recorder for ScreenRecorderPlaceholder {
    fn start(&mut self) -> Result<()> {
        if self.thread.is_some() {
            return Ok(());
        }

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let callback = self.callback.clone();
        let fps = self.fps.max(1);
        let burst_fps = self.burst_fps.max(fps);
        let idle_interval = self.idle_interval;
        let burst_after = self.burst_after;
        let idle_after = self.idle_after;
        let activity = self.activity.clone();
        let scale_factor = self.scale_factor;
        let quality = self.quality;

        tracing::warn!(
            "native screenshot capture is not enabled in this Rust build; compile with feature `native-recorders`"
        );

        self.thread = Some(thread::spawn(move || {
            let start = Instant::now();
            let active_interval = Duration::from_secs_f64(1.0 / fps as f64);
            let burst_interval = Duration::from_secs_f64(1.0 / burst_fps as f64);
            while running.load(Ordering::SeqCst) {
                let frame_started = Instant::now();
                let ts = start.elapsed().as_secs_f64();
                callback(json!({
                    "type": "screenshot",
                    "timestamp": ts,
                    "data": {
                        "image": "",
                        "width": 0,
                        "height": 0,
                        "encoding": "jpg",
                        "capture_unavailable": true,
                        "scale_factor": scale_factor,
                        "quality": quality,
                    }
                }));
                sleep_until_next_frame(
                    &running,
                    &activity,
                    burst_after,
                    idle_after,
                    burst_interval,
                    frame_started,
                    active_interval,
                    idle_interval,
                );
            }
        }));
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

fn seconds_duration(value: f64, default: f64) -> Duration {
    let seconds = if value.is_finite() && value > 0.0 {
        value
    } else {
        default
    };
    Duration::from_secs_f64(seconds.max(0.001))
}

#[cfg(feature = "native-recorders")]
fn sanitize_screen_frame_queue_capacity(capacity: usize) -> usize {
    capacity.max(1).min(MAX_SCREEN_FRAME_QUEUE_CAPACITY)
}

#[cfg(feature = "native-recorders")]
fn screenshot_capture_dhash(capture: &CapturedDesktop, scale_factor: f64) -> u64 {
    let mut hash = screenshot_dhash(&capture.image, scale_factor);
    for display in &capture.displays {
        hash = hash.rotate_left(7) ^ screenshot_dhash(&display.image, scale_factor);
    }
    hash
}

#[cfg(feature = "native-recorders")]
fn screenshot_dhash(image: &RgbaImage, scale_factor: f64) -> u64 {
    let target_width = scaled_dimension(image.width(), scale_factor);
    let target_height = scaled_dimension(image.height(), scale_factor);
    let resized = image::imageops::resize(image, target_width, target_height, FilterType::Triangle);
    let gray = DynamicImage::ImageRgba8(resized).to_luma8();
    let hash_image = image::imageops::resize(&gray, 9, 8, FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            if hash_image.get_pixel(x, y)[0] > hash_image.get_pixel(x + 1, y)[0] {
                hash |= 1;
            }
        }
    }
    hash
}

#[cfg(feature = "native-recorders")]
fn hamming_distance(left: u64, right: u64) -> u32 {
    (left ^ right).count_ones()
}

fn selected_frame_interval(
    activity: &ActivityTracker,
    burst_after: Duration,
    idle_after: Duration,
    burst_interval: Duration,
    active_interval: Duration,
    idle_interval: Duration,
) -> Duration {
    let time_since_activity = activity.elapsed();
    if time_since_activity <= burst_after {
        burst_interval
    } else if time_since_activity >= idle_after {
        idle_interval
    } else {
        active_interval
    }
}

fn sleep_until_next_frame(
    running: &AtomicBool,
    activity: &ActivityTracker,
    burst_after: Duration,
    idle_after: Duration,
    burst_interval: Duration,
    frame_started: Instant,
    active_interval: Duration,
    idle_interval: Duration,
) {
    while running.load(Ordering::SeqCst) {
        let target_interval = selected_frame_interval(
            activity,
            burst_after,
            idle_after,
            burst_interval,
            active_interval,
            idle_interval,
        );
        let elapsed = frame_started.elapsed();
        if elapsed >= target_interval {
            break;
        }
        thread::sleep((target_interval - elapsed).min(Duration::from_millis(50)));
    }
}

#[cfg(feature = "native-recorders")]
struct EncodedScreenshot {
    image: String,
    width: u32,
    height: u32,
    data: Value,
}

/// The last encoded frame per display slot. While active the recorder captures at
/// `screen_recorder.fps` (5); an unchanged screen yields byte-identical captures, and
/// re-encoding them costs a resize plus a JPEG encode each (~20% of a core on a 2-vCPU
/// Linux box). A byte-identical capture reuses the cached JPEG: the output is the same
/// bytes a fresh encode makes, so the event stream does not change.
#[cfg(feature = "native-recorders")]
#[derive(Default)]
struct ScreenshotEncodeCache {
    slots: Vec<Option<(RgbaImage, String, u32, u32)>>,
    encodes: u64,
}

#[cfg(feature = "native-recorders")]
impl ScreenshotEncodeCache {
    fn encode(
        &mut self,
        slot: usize,
        image: &RgbaImage,
        scale_factor: f64,
        quality: u8,
    ) -> Result<EncodedScreenshot> {
        if self.slots.len() <= slot {
            self.slots.resize_with(slot + 1, || None);
        }
        if let Some((previous, jpeg, width, height)) = &self.slots[slot] {
            if previous.dimensions() == image.dimensions() && previous.as_raw() == image.as_raw() {
                return Ok(EncodedScreenshot {
                    image: jpeg.clone(),
                    width: *width,
                    height: *height,
                    data: Value::Null,
                });
            }
        }
        let encoded = encode_screenshot_image(image, scale_factor, quality)?;
        self.encodes += 1;
        self.slots[slot] = Some((
            image.clone(),
            encoded.image.clone(),
            encoded.width,
            encoded.height,
        ));
        Ok(encoded)
    }
}

#[cfg(feature = "native-recorders")]
struct CapturedDesktop {
    mode: ScreenshotCaptureMode,
    image: RgbaImage,
    bounds: ScreenBounds,
    displays: Vec<CapturedDisplay>,
}

#[cfg(feature = "native-recorders")]
struct CapturedDisplay {
    id: u32,
    is_primary: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    image: RgbaImage,
}

#[cfg(feature = "native-recorders")]
#[allow(clippy::too_many_arguments)]
fn capture_screenshot_frames(
    running: Arc<AtomicBool>,
    queue: Arc<ScreenshotFrameQueue>,
    activity: ActivityTracker,
    capture_mode: ScreenshotCaptureMode,
    fps: u32,
    burst_fps: u32,
    idle_interval: Duration,
    idle_dedupe_distance: u32,
    idle_heartbeat: Duration,
    burst_after: Duration,
    idle_after: Duration,
    scale_factor: f64,
) {
    let start = Instant::now();
    let active_interval = Duration::from_secs_f64(1.0 / fps as f64);
    let burst_interval = Duration::from_secs_f64(1.0 / burst_fps as f64);
    let mut frame_id = 0_u64;
    let mut last_emitted_hash: Option<u64> = None;
    let mut last_emit_at: Option<Instant> = None;

    while running.load(Ordering::SeqCst) {
        let frame_started = Instant::now();
        let capture_started_timestamp = start.elapsed().as_secs_f64();
        let is_idle = activity.elapsed() >= idle_after;
        let target_interval = selected_frame_interval(
            &activity,
            burst_after,
            idle_after,
            burst_interval,
            active_interval,
            idle_interval,
        );

        match capture_desktop_capture(capture_mode) {
            Ok(capture) => {
                let capture_duration = frame_started.elapsed();

                // While idle, suppress near-identical frames so an unattended
                // screen does not generate multi-GB sessions. A periodic
                // heartbeat frame keeps the timeline continuous and guarantees
                // downstream consumers still observe screenshots.
                let mut emit = true;
                if is_idle {
                    let hash = screenshot_capture_dhash(&capture, scale_factor);
                    let since_last_emit = last_emit_at.map(|at| at.elapsed());
                    emit = should_emit_idle_frame(
                        hash,
                        last_emitted_hash,
                        idle_dedupe_distance,
                        since_last_emit,
                        idle_heartbeat,
                    );
                    if emit {
                        last_emitted_hash = Some(hash);
                    }
                } else {
                    // Active/burst frames reset the idle baseline so the first
                    // idle frame after activity is always emitted.
                    last_emitted_hash = None;
                }

                if emit {
                    let frame = RawScreenshotFrame {
                        frame_id,
                        timestamp: start.elapsed().as_secs_f64(),
                        capture_started_timestamp,
                        target_interval,
                        capture_duration,
                        capture,
                        enqueued_at: Instant::now(),
                        raw_queue_depth: 0,
                        dropped_raw_frames: 0,
                    };
                    frame_id = frame_id.wrapping_add(1);
                    last_emit_at = Some(Instant::now());
                    if !queue.push_drop_oldest(frame) {
                        break;
                    }
                }
            }
            Err(err) => tracing::warn!("failed to capture screenshot: {err:#}"),
        }

        sleep_until_next_frame(
            &running,
            &activity,
            burst_after,
            idle_after,
            burst_interval,
            frame_started,
            active_interval,
            idle_interval,
        );
    }

    queue.close();
}

// Decides whether an idle-state screenshot should be emitted. The first idle
// frame (no prior emission) and heartbeat frames always emit; otherwise the
// frame is dropped when it is perceptually within `dedupe_distance` of the last
// emitted frame.
#[cfg(feature = "native-recorders")]
fn should_emit_idle_frame(
    current_hash: u64,
    last_emitted_hash: Option<u64>,
    dedupe_distance: u32,
    since_last_emit: Option<Duration>,
    heartbeat: Duration,
) -> bool {
    let Some(previous) = last_emitted_hash else {
        return true;
    };
    if since_last_emit
        .map(|elapsed| elapsed >= heartbeat)
        .unwrap_or(true)
    {
        return true;
    }
    hamming_distance(current_hash, previous) >= dedupe_distance
}

#[cfg(feature = "native-recorders")]
fn encode_screenshot_frames(
    queue: Arc<ScreenshotFrameQueue>,
    callback: EventCallback,
    scale_factor: f64,
    quality: u8,
) {
    let mut cache = ScreenshotEncodeCache::default();
    while let Some(frame) = queue.pop() {
        let encode_started = Instant::now();
        let queue_wait = encode_started.saturating_duration_since(frame.enqueued_at);
        let frame_id = frame.frame_id;
        let capture_started_timestamp = frame.capture_started_timestamp;
        let capture_duration = frame.capture_duration;
        let target_interval = frame.target_interval;
        let raw_queue_depth = frame.raw_queue_depth;
        let dropped_raw_frames = frame.dropped_raw_frames;
        match encode_captured_screenshot_with(&mut cache, frame.capture, scale_factor, quality) {
            Ok(mut encoded) => {
                let encode_duration = encode_started.elapsed();
                add_screenshot_pipeline_diagnostics(
                    &mut encoded.data,
                    frame_id,
                    capture_started_timestamp,
                    capture_duration,
                    target_interval,
                    raw_queue_depth,
                    dropped_raw_frames,
                    queue_wait,
                    encode_duration,
                );
                let event = json!({
                    "type": "screenshot",
                    "timestamp": frame.timestamp,
                    "data": encoded.data,
                });
                let callback_started = Instant::now();
                callback(event);
                let callback_duration = callback_started.elapsed();
                if callback_duration >= target_interval {
                    tracing::debug!(
                        frame_id = frame_id,
                        callback_duration_ms = duration_millis(callback_duration),
                        target_interval_ms = duration_millis(target_interval),
                        "screenshot callback exceeded target interval"
                    );
                }
            }
            Err(err) => tracing::warn!("failed to encode screenshot: {err:#}"),
        }
    }
}

#[cfg(feature = "native-recorders")]
fn add_screenshot_pipeline_diagnostics(
    data: &mut Value,
    frame_id: u64,
    capture_started_timestamp: f64,
    capture_duration: Duration,
    target_interval: Duration,
    raw_queue_depth: usize,
    dropped_raw_frames: u64,
    queue_wait: Duration,
    encode_duration: Duration,
) {
    data["frame_id"] = json!(frame_id);
    data["capture_started_timestamp"] = json!(round4(capture_started_timestamp));
    data["capture_duration_ms"] = json!(duration_millis(capture_duration));
    data["target_interval_ms"] = json!(duration_millis(target_interval));
    data["capture_limited"] = json!(capture_duration >= target_interval);
    data["queue_wait_ms"] = json!(duration_millis(queue_wait));
    data["encode_duration_ms"] = json!(duration_millis(encode_duration));
    data["raw_queue_depth"] = json!(raw_queue_depth);
    data["dropped_raw_frames"] = json!(dropped_raw_frames);
}

#[cfg(feature = "native-recorders")]
fn capture_and_encode_screenshot(
    mode: ScreenshotCaptureMode,
    scale_factor: f64,
    quality: u8,
) -> Result<EncodedScreenshot> {
    let capture = capture_desktop_capture(mode)?;
    encode_captured_screenshot(capture, scale_factor, quality)
}

#[cfg(feature = "native-recorders")]
fn active_display_id(
    focused_display_id: Option<u32>,
    pointer_display_id: Option<u32>,
) -> Option<u32> {
    focused_display_id.or(pointer_display_id)
}

/// An action screenshot keeps the image of the display under the pointer and
/// the display of the focused window; the other displays keep their layout only.
/// With neither known, every display keeps its image.
#[cfg(feature = "native-recorders")]
fn keeps_display_image(id: u32, pointer: Option<u32>, focused: Option<u32>) -> bool {
    (pointer.is_none() && focused.is_none()) || pointer == Some(id) || focused == Some(id)
}

#[cfg(feature = "native-recorders")]
fn encode_captured_screenshot(
    capture: CapturedDesktop,
    scale_factor: f64,
    quality: u8,
) -> Result<EncodedScreenshot> {
    encode_captured_screenshot_with(
        &mut ScreenshotEncodeCache::default(),
        capture,
        scale_factor,
        quality,
    )
}

#[cfg(feature = "native-recorders")]
fn encode_captured_screenshot_with(
    cache: &mut ScreenshotEncodeCache,
    capture: CapturedDesktop,
    scale_factor: f64,
    quality: u8,
) -> Result<EncodedScreenshot> {
    let pointer_display_id = current_pointer_display_id(&capture.displays);
    let focused_display_id = current_focus_display_id(&capture.displays);
    let active_display_id = active_display_id(focused_display_id, pointer_display_id);
    match capture.mode {
        ScreenshotCaptureMode::Stitched => {
            let mut encoded = cache.encode(0, &capture.image, scale_factor, quality)?;
            encoded.data = screenshot_payload(
                &encoded,
                capture.mode,
                None,
                Some(desktop_bounds_payload(&capture.bounds)),
                active_display_id,
                active_display_id,
                pointer_display_id,
                focused_display_id,
            );
            Ok(encoded)
        }
        ScreenshotCaptureMode::AllDisplays => {
            let mut encoded_displays = Vec::with_capacity(capture.displays.len());
            // (rank, image): the active display's image is the main one, then the primary's.
            let mut fallback: Option<(u8, EncodedScreenshot)> = None;

            for (index, display) in capture.displays.into_iter().enumerate() {
                if !keeps_display_image(display.id, pointer_display_id, focused_display_id) {
                    // The screen recorder's video already holds this display; an
                    // action needs only the display the person works on.
                    let mut value = display_screenshot_payload(
                        &display,
                        &EncodedScreenshot {
                            image: String::new(),
                            width: 0,
                            height: 0,
                            data: Value::Null,
                        },
                        &capture.bounds,
                    );
                    value["image"] = Value::Null;
                    value["width"] = Value::Null;
                    value["height"] = Value::Null;
                    encoded_displays.push(value);
                    continue;
                }
                let encoded = cache.encode(1 + index, &display.image, scale_factor, quality)?;
                let value = display_screenshot_payload(&display, &encoded, &capture.bounds);
                let rank = if Some(display.id) == active_display_id {
                    0
                } else if display.is_primary {
                    1
                } else {
                    2
                };
                if fallback.as_ref().is_none_or(|(best, _)| rank < *best) {
                    fallback = Some((
                        rank,
                        EncodedScreenshot {
                            image: encoded.image.clone(),
                            width: encoded.width,
                            height: encoded.height,
                            data: Value::Null,
                        },
                    ));
                }
                encoded_displays.push(value);
            }

            let mut encoded = fallback
                .map(|(_, e)| e)
                .context("no display screenshots were captured")?;
            encoded.data = screenshot_payload(
                &encoded,
                ScreenshotCaptureMode::AllDisplays,
                Some(encoded_displays),
                Some(desktop_bounds_payload(&capture.bounds)),
                active_display_id,
                active_display_id,
                pointer_display_id,
                focused_display_id,
            );
            Ok(encoded)
        }
    }
}

#[cfg(feature = "native-recorders")]
fn encode_screenshot_image(
    image: &RgbaImage,
    scale_factor: f64,
    quality: u8,
) -> Result<EncodedScreenshot> {
    let target_width = scaled_dimension(image.width(), scale_factor);
    let target_height = scaled_dimension(image.height(), scale_factor);
    let resized = image::imageops::resize(image, target_width, target_height, FilterType::Triangle);
    let rgb = DynamicImage::ImageRgba8(resized).to_rgb8();

    let mut encoded = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut encoded, quality);
    encoder
        .encode_image(&rgb)
        .context("failed to encode screenshot as JPEG")?;

    Ok(EncodedScreenshot {
        image: general_purpose::STANDARD.encode(encoded),
        width: target_width,
        height: target_height,
        data: Value::Null,
    })
}

#[cfg(feature = "native-recorders")]
fn screenshot_payload(
    encoded: &EncodedScreenshot,
    mode: ScreenshotCaptureMode,
    encoded_displays: Option<Vec<Value>>,
    desktop_bounds: Option<Value>,
    active_display_id: Option<u32>,
    current_display_id: Option<u32>,
    pointer_display_id: Option<u32>,
    focused_display_id: Option<u32>,
) -> Value {
    let mut payload = json!({
        "image": encoded.image.clone(),
        "width": encoded.width,
        "height": encoded.height,
        "encoding": "jpg",
        "capture_mode": mode.as_str(),
    });

    if let Some(displays) = encoded_displays {
        payload["displays"] = Value::Array(displays);
    }

    if let Some(bounds) = desktop_bounds {
        payload["desktop_bounds"] = bounds;
    }

    if let Some(display_id) = active_display_id {
        payload["active_display_id"] = json!(display_id);
    }

    if let Some(display_id) = current_display_id {
        payload["current_display_id"] = json!(display_id);
    }

    if let Some(display_id) = pointer_display_id {
        payload["pointer_display_id"] = json!(display_id);
    }

    if let Some(display_id) = focused_display_id {
        payload["focused_display_id"] = json!(display_id);
    }

    payload
}

#[cfg(feature = "native-recorders")]
fn display_screenshot_payload(
    display: &CapturedDisplay,
    encoded: &EncodedScreenshot,
    desktop_bounds: &ScreenBounds,
) -> Value {
    json!({
        "display_id": display.id,
        "is_primary": display.is_primary,
        "image": encoded.image.clone(),
        "width": encoded.width,
        "height": encoded.height,
        "encoding": "jpg",
        "bounds": {
            "x": display.x,
            "y": display.y,
            "width": display.width,
            "height": display.height,
        },
        "normalized_bounds": normalized_display_bounds_payload(display, desktop_bounds),
    })
}

#[cfg(feature = "native-recorders")]
fn desktop_bounds_payload(bounds: &ScreenBounds) -> Value {
    json!({
        "x": bounds.x,
        "y": bounds.y,
        "width": bounds.width,
        "height": bounds.height,
    })
}

#[cfg(feature = "native-recorders")]
fn normalized_display_bounds_payload(
    display: &CapturedDisplay,
    desktop_bounds: &ScreenBounds,
) -> Value {
    json!({
        "x": round4((display.x - desktop_bounds.x) / desktop_bounds.width),
        "y": round4((display.y - desktop_bounds.y) / desktop_bounds.height),
        "width": round4(display.width / desktop_bounds.width),
        "height": round4(display.height / desktop_bounds.height),
    })
}

#[cfg(all(feature = "native-recorders", target_os = "macos"))]
fn current_pointer_display_id(displays: &[CapturedDisplay]) -> Option<u32> {
    let (x, y) = macos::pointer_location()?;
    display_id_for_point(displays, x, y)
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn current_pointer_display_id(displays: &[CapturedDisplay]) -> Option<u32> {
    let (x, y) = sample_cursor_position()?;
    display_id_for_point(displays, x, y)
}

#[cfg(all(feature = "native-recorders", target_os = "macos"))]
fn current_focus_display_id(displays: &[CapturedDisplay]) -> Option<u32> {
    let (x, y) = macos::focused_window_center()?;
    display_id_for_point(displays, x, y)
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn current_focus_display_id(_displays: &[CapturedDisplay]) -> Option<u32> {
    None
}

#[cfg(feature = "native-recorders")]
fn display_id_for_point(displays: &[CapturedDisplay], x: f64, y: f64) -> Option<u32> {
    displays
        .iter()
        .find(|display| {
            x >= display.x
                && x < display.x + display.width
                && y >= display.y
                && y < display.y + display.height
        })
        .map(|display| display.id)
}

#[cfg(feature = "native-recorders")]
fn capture_desktop_capture(mode: ScreenshotCaptureMode) -> Result<CapturedDesktop> {
    let screens = screenshots::Screen::all().context("failed to enumerate screens")?;
    if screens.is_empty() {
        bail!("no screens available for screenshot capture");
    }

    let bounds = ScreenBounds::from_screens(&screens)
        .context("failed to calculate virtual screen bounds")?;
    let mut displays = Vec::with_capacity(screens.len());

    for screen in &screens {
        let image = screen
            .capture()
            .with_context(|| format!("failed to capture screen {}", screen.display_info.id))?;
        displays.push(CapturedDisplay {
            id: screen.display_info.id,
            is_primary: screen.display_info.is_primary,
            x: screen.display_info.x as f64,
            y: screen.display_info.y as f64,
            width: screen.display_info.width as f64,
            height: screen.display_info.height as f64,
            image,
        });
    }

    let image = match mode {
        ScreenshotCaptureMode::AllDisplays => displays
            .iter()
            .find(|display| display.is_primary)
            .or_else(|| displays.first())
            .map(|display| display.image.clone())
            .context("no display screenshots were captured")?,
        ScreenshotCaptureMode::Stitched => stitch_logical_desktop(&bounds, &displays)?,
    };

    Ok(CapturedDesktop {
        mode,
        image,
        bounds,
        displays,
    })
}

#[cfg(feature = "native-recorders")]
fn stitch_logical_desktop(
    bounds: &ScreenBounds,
    displays: &[CapturedDisplay],
) -> Result<RgbaImage> {
    let mut desktop = RgbaImage::new(bounds.width.round() as u32, bounds.height.round() as u32);

    for display in displays {
        let logical_width = display.width.round().max(1.0) as u32;
        let logical_height = display.height.round().max(1.0) as u32;
        let image =
            if display.image.width() == logical_width && display.image.height() == logical_height {
                display.image.clone()
            } else {
                image::imageops::resize(
                    &display.image,
                    logical_width,
                    logical_height,
                    FilterType::Triangle,
                )
            };
        let x = (display.x - bounds.x).round() as i64;
        let y = (display.y - bounds.y).round() as i64;
        image::imageops::overlay(&mut desktop, &image, x, y);
    }

    Ok(desktop)
}

#[cfg(feature = "native-recorders")]
fn sanitize_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

#[cfg(feature = "native-recorders")]
fn scaled_dimension(value: u32, scale_factor: f64) -> u32 {
    ((value as f64 * scale_factor).round().max(1.0)) as u32
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
struct NativeInputRecorder {
    callback: EventCallback,
    hub: Option<Arc<InputHub>>,
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
impl NativeInputRecorder {
    fn new(callback: EventCallback) -> Self {
        Self {
            callback,
            hub: None,
        }
    }
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
impl Recorder for NativeInputRecorder {
    fn start(&mut self) -> Result<()> {
        let hub = input_hub()?;
        if let Some(error) = hub.listener_error() {
            bail!("native input listener is unavailable: {error}");
        }

        let bounds = ScreenBounds::detect().unwrap_or_else(|err| {
            tracing::warn!("failed to detect screen bounds for input normalization: {err:#}");
            ScreenBounds::fallback()
        });

        hub.set_session(InputSession::new(self.callback.clone(), bounds));
        self.hub = Some(hub.clone());

        thread::sleep(Duration::from_millis(25));
        if let Some(error) = hub.listener_error() {
            hub.clear_session();
            self.hub = None;
            bail!("native input listener is unavailable: {error}");
        }

        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        if let Some(hub) = self.hub.take() {
            hub.clear_session();
        }
        Ok(())
    }
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
struct InputHub {
    session: Mutex<Option<InputSession>>,
    listener_error: Mutex<Option<String>>,
    #[cfg(target_os = "windows")]
    windows_input_listener_active: AtomicBool,
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
impl InputHub {
    #[cfg(not(target_os = "windows"))]
    fn handle_event(&self, event: rdev::Event) {
        self.dispatch_event(event);
    }

    #[cfg(not(target_os = "windows"))]
    fn dispatch_event(&self, event: rdev::Event) {
        let pending = {
            let mut session = lock_unpoisoned(&self.session);
            session
                .as_mut()
                .and_then(|session| session.event_from(event))
        };

        if let Some((callback, event)) = pending {
            callback(event);
        }
    }

    #[cfg(target_os = "windows")]
    fn dispatch_windows_event(&self, event: WindowsInputEvent) {
        let pending = {
            let mut session = lock_unpoisoned(&self.session);
            session
                .as_mut()
                .and_then(|session| session.event_from_windows(event))
        };

        if let Some((callback, event)) = pending {
            callback(event);
        }
    }

    fn set_session(&self, session: InputSession) {
        *lock_unpoisoned(&self.session) = Some(session);
    }

    fn clear_session(&self) {
        *lock_unpoisoned(&self.session) = None;
    }

    fn listener_error(&self) -> Option<String> {
        lock_unpoisoned(&self.listener_error).clone()
    }

    fn set_listener_error(&self, error: String) {
        *lock_unpoisoned(&self.listener_error) = Some(error);
    }

    #[cfg(target_os = "windows")]
    fn set_windows_input_listener_active(&self, active: bool) {
        self.windows_input_listener_active
            .store(active, Ordering::SeqCst);
    }
}

#[cfg(all(
    feature = "native-recorders",
    not(any(target_os = "windows", target_os = "macos"))
))]
fn input_hub() -> Result<Arc<InputHub>> {
    static INPUT_HUB: OnceLock<Arc<InputHub>> = OnceLock::new();

    if let Some(hub) = INPUT_HUB.get() {
        return Ok(hub.clone());
    }

    let hub = Arc::new(InputHub {
        session: Mutex::new(None),
        listener_error: Mutex::new(None),
    });

    let listener_hub = hub.clone();
    thread::Builder::new()
        .name("kortix-rdev-input-listener".to_string())
        .spawn(move || {
            let callback_hub = listener_hub.clone();
            let result = rdev::listen(move |event| callback_hub.handle_event(event));
            if let Err(err) = result {
                let error = format!("{err:?}");
                tracing::error!("native input listener failed: {error}");
                listener_hub.set_listener_error(error);
            }
        })
        .context("failed to spawn native input listener thread")?;

    let _ = INPUT_HUB.set(hub);
    INPUT_HUB
        .get()
        .cloned()
        .context("native input listener failed to initialize")
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn input_hub() -> Result<Arc<InputHub>> {
    static INPUT_HUB: OnceLock<Arc<InputHub>> = OnceLock::new();

    if let Some(hub) = INPUT_HUB.get() {
        return Ok(hub.clone());
    }

    let (sender, receiver) = mpsc::sync_channel(DEFAULT_WINDOWS_INPUT_QUEUE_CAPACITY);
    if WINDOWS_INPUT_SENDER.set(sender).is_err() {
        bail!("native Windows input listener was initialized twice");
    }
    WINDOWS_INPUT_QUEUE_DEPTH.store(0, Ordering::SeqCst);
    WINDOWS_INPUT_DROPPED_EVENTS.store(0, Ordering::SeqCst);

    let hub = Arc::new(InputHub {
        session: Mutex::new(None),
        listener_error: Mutex::new(None),
        windows_input_listener_active: AtomicBool::new(false),
    });

    let worker_hub = hub.clone();
    thread::Builder::new()
        .name("kortix-windows-input-worker".to_string())
        .spawn(move || run_windows_input_worker(worker_hub, receiver))
        .context("failed to spawn native Windows input worker thread")?;

    let listener_hub = hub.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::Builder::new()
        .name("kortix-windows-input-hook-listener".to_string())
        .spawn(move || run_windows_input_hook_listener(listener_hub, ready_tx))
        .context("failed to spawn native Windows input hook listener thread")?;

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => bail!("native Windows input listener is unavailable: {error}"),
        Err(err) => bail!("native Windows input listener did not initialize: {err}"),
    }

    let _ = INPUT_HUB.set(hub);
    INPUT_HUB
        .get()
        .cloned()
        .context("native Windows input listener failed to initialize")
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
const DEFAULT_WINDOWS_INPUT_QUEUE_CAPACITY: usize = 4096;

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
const WINDOWS_VK_PACKET: u32 = 0xE7;

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
static WINDOWS_INPUT_SENDER: OnceLock<SyncSender<WindowsInputEvent>> = OnceLock::new();

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
static WINDOWS_INPUT_QUEUE_DEPTH: AtomicUsize = AtomicUsize::new(0);

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
static WINDOWS_INPUT_DROPPED_EVENTS: AtomicU64 = AtomicU64::new(0);

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
#[derive(Clone, Copy, Debug)]
struct WindowsInputEvent {
    kind: WindowsInputEventKind,
    observed_at: Instant,
    queued_at: Instant,
    queue_depth: usize,
    dropped_events: u64,
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
#[derive(Clone, Copy, Debug)]
enum WindowsInputEventKind {
    Key {
        pressed: bool,
        vk_code: u32,
        scan_code: u32,
    },
    Button {
        pressed: bool,
        button: WindowsMouseButton,
        x: f64,
        y: f64,
    },
    MouseMove {
        x: f64,
        y: f64,
    },
    Wheel {
        delta_x: i64,
        delta_y: i64,
    },
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
#[derive(Clone, Copy, Debug)]
enum WindowsMouseButton {
    Left,
    Right,
    Middle,
    Unknown(u16),
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn run_windows_input_worker(hub: Arc<InputHub>, receiver: Receiver<WindowsInputEvent>) {
    while let Ok(event) = receiver.recv() {
        WINDOWS_INPUT_QUEUE_DEPTH.fetch_sub(1, Ordering::SeqCst);
        hub.dispatch_windows_event(event);
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn run_windows_input_hook_listener(
    hub: Arc<InputHub>,
    ready: mpsc::Sender<std::result::Result<(), String>>,
) {
    use std::{mem::zeroed, ptr::null_mut};
    use winapi::shared::windef::HHOOK;
    use winapi::um::errhandlingapi::GetLastError;
    use winapi::um::winuser::{
        GetMessageA, SetWindowsHookExA, UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL,
    };

    unsafe {
        let keyboard_hook = SetWindowsHookExA(
            WH_KEYBOARD_LL,
            Some(windows_keyboard_hook_callback),
            null_mut(),
            0,
        );
        if keyboard_hook.is_null() {
            let error = GetLastError();
            let message = format!("Windows keyboard hook failed: {error}");
            tracing::error!("{message}");
            hub.set_listener_error(message.clone());
            let _ = ready.send(Err(message));
            return;
        }

        let mouse_hook = SetWindowsHookExA(
            WH_MOUSE_LL,
            Some(windows_mouse_hook_callback),
            null_mut(),
            0,
        );
        if mouse_hook.is_null() {
            let error = GetLastError();
            let message = format!("Windows mouse hook failed: {error}");
            tracing::error!("{message}");
            hub.set_listener_error(message.clone());
            let _ = UnhookWindowsHookEx(keyboard_hook);
            let _ = ready.send(Err(message));
            return;
        }

        hub.set_windows_input_listener_active(true);
        let _ = ready.send(Ok(()));
        let mut message: MSG = zeroed();
        while GetMessageA(&mut message, null_mut(), 0, 0) > 0 {}
        hub.set_windows_input_listener_active(false);
        let _ = UnhookWindowsHookEx(keyboard_hook as HHOOK);
        let _ = UnhookWindowsHookEx(mouse_hook as HHOOK);
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
unsafe extern "system" fn windows_keyboard_hook_callback(
    code: std::os::raw::c_int,
    param: winapi::shared::minwindef::WPARAM,
    lpdata: winapi::shared::minwindef::LPARAM,
) -> winapi::shared::minwindef::LRESULT {
    use winapi::shared::windef::HHOOK;
    use winapi::um::winuser::{
        CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP,
    };

    if code == HC_ACTION {
        let message = param as u32;
        let pressed = match message {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
            WM_KEYUP | WM_SYSKEYUP => Some(false),
            _ => None,
        };

        if let Some(pressed) = pressed {
            let keyboard = *(lpdata as *const KBDLLHOOKSTRUCT);
            enqueue_windows_input_event(WindowsInputEventKind::Key {
                pressed,
                vk_code: keyboard.vkCode,
                scan_code: keyboard.scanCode,
            });
        }
    }

    CallNextHookEx(std::ptr::null_mut::<HHOOK>() as HHOOK, code, param, lpdata)
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
unsafe extern "system" fn windows_mouse_hook_callback(
    code: std::os::raw::c_int,
    param: winapi::shared::minwindef::WPARAM,
    lpdata: winapi::shared::minwindef::LPARAM,
) -> winapi::shared::minwindef::LRESULT {
    use winapi::shared::windef::HHOOK;
    use winapi::um::winuser::{
        CallNextHookEx, HC_ACTION, MSLLHOOKSTRUCT, WHEEL_DELTA, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
        WM_RBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    if code == HC_ACTION {
        let mouse = *(lpdata as *const MSLLHOOKSTRUCT);
        let message = param as u32;
        match message {
            WM_MOUSEMOVE => enqueue_windows_input_event(WindowsInputEventKind::MouseMove {
                x: mouse.pt.x as f64,
                y: mouse.pt.y as f64,
            }),
            WM_LBUTTONDOWN | WM_LBUTTONUP => {
                enqueue_windows_input_event(WindowsInputEventKind::Button {
                    pressed: message == WM_LBUTTONDOWN,
                    button: WindowsMouseButton::Left,
                    x: mouse.pt.x as f64,
                    y: mouse.pt.y as f64,
                })
            }
            WM_RBUTTONDOWN | WM_RBUTTONUP => {
                enqueue_windows_input_event(WindowsInputEventKind::Button {
                    pressed: message == WM_RBUTTONDOWN,
                    button: WindowsMouseButton::Right,
                    x: mouse.pt.x as f64,
                    y: mouse.pt.y as f64,
                })
            }
            WM_MBUTTONDOWN | WM_MBUTTONUP => {
                enqueue_windows_input_event(WindowsInputEventKind::Button {
                    pressed: message == WM_MBUTTONDOWN,
                    button: WindowsMouseButton::Middle,
                    x: mouse.pt.x as f64,
                    y: mouse.pt.y as f64,
                })
            }
            WM_XBUTTONDOWN | WM_XBUTTONUP => {
                enqueue_windows_input_event(WindowsInputEventKind::Button {
                    pressed: message == WM_XBUTTONDOWN,
                    button: WindowsMouseButton::Unknown(windows_high_word(mouse.mouseData)),
                    x: mouse.pt.x as f64,
                    y: mouse.pt.y as f64,
                })
            }
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                let clicks =
                    (windows_high_word(mouse.mouseData) as i16 / WHEEL_DELTA as i16) as i64;
                enqueue_windows_input_event(WindowsInputEventKind::Wheel {
                    delta_x: if message == WM_MOUSEHWHEEL { clicks } else { 0 },
                    delta_y: if message == WM_MOUSEWHEEL { clicks } else { 0 },
                });
            }
            _ => {}
        }
    }

    CallNextHookEx(std::ptr::null_mut::<HHOOK>() as HHOOK, code, param, lpdata)
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn enqueue_windows_input_event(kind: WindowsInputEventKind) {
    let Some(sender) = WINDOWS_INPUT_SENDER.get() else {
        return;
    };
    let now = Instant::now();
    let queue_depth = WINDOWS_INPUT_QUEUE_DEPTH.fetch_add(1, Ordering::SeqCst) + 1;
    let event = WindowsInputEvent {
        kind,
        observed_at: now,
        queued_at: now,
        queue_depth,
        dropped_events: WINDOWS_INPUT_DROPPED_EVENTS.load(Ordering::SeqCst),
    };

    match sender.try_send(event) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            WINDOWS_INPUT_QUEUE_DEPTH.fetch_sub(1, Ordering::SeqCst);
            WINDOWS_INPUT_DROPPED_EVENTS.fetch_add(1, Ordering::SeqCst);
        }
        Err(TrySendError::Disconnected(_)) => {
            WINDOWS_INPUT_QUEUE_DEPTH.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_high_word(value: u32) -> u16 {
    ((value >> 16) & 0xffff) as u16
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_packet_name_from_scan_code(scan_code: u32) -> Option<String> {
    if scan_code == 0 {
        return None;
    }

    char::from_u32(scan_code).map(|character| character.to_string())
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
struct InputSession {
    callback: EventCallback,
    start_time: Instant,
    bounds: ScreenBounds,
    active_modifiers: BTreeSet<String>,
    key_down_times: HashMap<String, Instant>,
    pressed_buttons: HashSet<String>,
    last_position: NormalizedPosition,
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
impl InputSession {
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

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    fn event_from(&mut self, event: rdev::Event) -> Option<(EventCallback, Event)> {
        let timestamp = self.start_time.elapsed().as_secs_f64();

        let event = match event.event_type {
            rdev::EventType::KeyPress(key) => {
                self.key_down_event(timestamp, key, event.name.as_deref())
            }
            rdev::EventType::KeyRelease(key) => {
                self.key_up_event(timestamp, key, event.name.as_deref())
            }
            rdev::EventType::ButtonPress(button) => {
                self.mouse_button_event(timestamp, button, true)
            }
            rdev::EventType::ButtonRelease(button) => {
                self.mouse_button_event(timestamp, button, false)
            }
            rdev::EventType::MouseMove { x, y } => self.mouse_move_event(timestamp, x, y),
            rdev::EventType::Wheel { delta_x, delta_y } => {
                self.mouse_scroll_event(timestamp, delta_x, delta_y)
            }
        };

        Some((self.callback.clone(), event))
    }

    #[cfg(target_os = "windows")]
    fn event_from_windows(&mut self, input: WindowsInputEvent) -> Option<(EventCallback, Event)> {
        let timestamp = input
            .observed_at
            .saturating_duration_since(self.start_time)
            .as_secs_f64();
        let mut event = match input.kind {
            WindowsInputEventKind::Key {
                pressed,
                vk_code,
                scan_code,
            } => {
                let key = windows_key_name(pressed, vk_code, scan_code);
                if pressed {
                    self.key_down_event_from_name(timestamp, key.name, key.unresolved_code)
                } else {
                    self.key_up_event_from_name(timestamp, key.name, key.unresolved_code)
                }
            }
            WindowsInputEventKind::Button {
                pressed,
                button,
                x,
                y,
            } => self.mouse_button_event_from_name(
                timestamp,
                normalize_windows_button(button),
                pressed,
                Some((x, y)),
            ),
            WindowsInputEventKind::MouseMove { x, y } => self.mouse_move_event(timestamp, x, y),
            WindowsInputEventKind::Wheel { delta_x, delta_y } => {
                self.mouse_scroll_event(timestamp, delta_x, delta_y)
            }
        };
        self.annotate_windows_input_diagnostics(&mut event, &input);
        Some((self.callback.clone(), event))
    }

    #[cfg(target_os = "windows")]
    fn annotate_windows_input_diagnostics(&self, event: &mut Event, input: &WindowsInputEvent) {
        let Some(data) = event.get_mut("data").and_then(Value::as_object_mut) else {
            return;
        };
        data.insert(
            "input_queue_wait_ms".to_string(),
            json!(duration_millis(input.queued_at.elapsed())),
        );
        data.insert("input_queue_depth".to_string(), json!(input.queue_depth));
        data.insert(
            "input_dropped_events".to_string(),
            json!(input.dropped_events),
        );
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    fn key_down_event(&mut self, timestamp: f64, key: rdev::Key, name: Option<&str>) -> Event {
        let key_name = normalize_key(key, name);
        let unresolved_code = unresolved_native_key_code(key);
        self.key_down_event_from_name(timestamp, key_name, unresolved_code)
    }

    fn key_down_event_from_name(
        &mut self,
        timestamp: f64,
        key_name: String,
        unresolved_code: Option<u32>,
    ) -> Event {
        let is_modifier = is_modifier_key_name(&key_name);
        if is_modifier {
            self.active_modifiers.insert(key_name.clone());
        }
        self.key_down_times.insert(key_name.clone(), Instant::now());

        let mut data = json!({
            "key": key_name,
            "active_modifiers": self.active_modifiers_without_current_modifier(is_modifier, &key_name),
        });
        annotate_unresolved_key_code(&mut data, unresolved_code);
        annotate_lock_key_state(&mut data, &key_name);

        json!({
            "type": "key_down",
            "timestamp": timestamp,
            "data": data,
        })
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    fn key_up_event(&mut self, timestamp: f64, key: rdev::Key, name: Option<&str>) -> Event {
        let key_name = normalize_key(key, name);
        let unresolved_code = unresolved_native_key_code(key);
        self.key_up_event_from_name(timestamp, key_name, unresolved_code)
    }

    fn key_up_event_from_name(
        &mut self,
        timestamp: f64,
        key_name: String,
        unresolved_code: Option<u32>,
    ) -> Event {
        if is_modifier_key_name(&key_name) {
            self.active_modifiers.remove(&key_name);
        }
        let hold_duration = self
            .key_down_times
            .remove(&key_name)
            .map(|pressed_at| pressed_at.elapsed().as_secs_f64())
            .unwrap_or(0.0);

        let mut data = json!({
            "key": key_name,
            "hold_duration": hold_duration,
            "active_modifiers": self.active_modifiers_list(),
        });
        annotate_unresolved_key_code(&mut data, unresolved_code);

        json!({
            "type": "key_up",
            "timestamp": timestamp,
            "data": data,
        })
    }

    fn mouse_move_event(&mut self, timestamp: f64, x: f64, y: f64) -> Event {
        let position = self.bounds.normalize_position(x, y);
        self.last_position = position;

        let mut data = json!({
            "x": position.x,
            "y": position.y,
            "is_dragging": !self.pressed_buttons.is_empty(),
        });
        add_display_id(&mut data, position.display_id);

        json!({
            "type": "mouse_move",
            "timestamp": timestamp,
            "data": data,
        })
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    fn mouse_button_event(&mut self, timestamp: f64, button: rdev::Button, pressed: bool) -> Event {
        let button_name = normalize_button(button);
        self.mouse_button_event_from_name(timestamp, button_name, pressed, sample_cursor_position())
    }

    fn mouse_button_event_from_name(
        &mut self,
        timestamp: f64,
        button_name: String,
        pressed: bool,
        sampled_position: Option<(f64, f64)>,
    ) -> Event {
        let position = mouse_event_position(self.last_position, sampled_position, &self.bounds);
        self.last_position = position;

        if pressed {
            self.pressed_buttons.insert(button_name.clone());
        } else {
            self.pressed_buttons.remove(&button_name);
        }

        let event_type = if pressed { "mouse_down" } else { "mouse_up" };
        let mut data = json!({
            "x": position.x,
            "y": position.y,
            "button": button_name,
            "click_count": 1,
            "active_modifiers": self.active_modifiers_list(),
        });
        add_display_id(&mut data, position.display_id);

        json!({ "type": event_type, "timestamp": timestamp, "data": data })
    }

    fn mouse_scroll_event(&mut self, timestamp: f64, delta_x: i64, delta_y: i64) -> Event {
        let clicks = if delta_y != 0 { delta_y } else { delta_x };

        let mut data = json!({
            "x": self.last_position.x,
            "y": self.last_position.y,
            "clicks": clicks,
            "active_modifiers": self.active_modifiers_list(),
        });
        add_display_id(&mut data, self.last_position.display_id);

        json!({ "type": "mouse_scroll", "timestamp": timestamp, "data": data })
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

#[cfg(feature = "native-recorders")]
#[derive(Clone)]
struct ScreenBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    displays: Vec<ScreenDisplayBounds>,
}

#[cfg(feature = "native-recorders")]
#[derive(Clone)]
struct ScreenDisplayBounds {
    id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(feature = "native-recorders")]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct NormalizedPosition {
    x: f64,
    y: f64,
    display_id: Option<u32>,
}

#[cfg(feature = "native-recorders")]
impl ScreenBounds {
    fn detect() -> Result<Self> {
        let screens = screenshots::Screen::all().context("failed to enumerate screens")?;
        Self::from_screens(&screens).context("no usable screens found")
    }

    fn from_screens(screens: &[screenshots::Screen]) -> Option<Self> {
        let min_x = screens.iter().map(|screen| screen.display_info.x).min()? as f64;
        let min_y = screens.iter().map(|screen| screen.display_info.y).min()? as f64;
        let max_x = screens
            .iter()
            .map(|screen| screen.display_info.x + screen.display_info.width as i32)
            .max()? as f64;
        let max_y = screens
            .iter()
            .map(|screen| screen.display_info.y + screen.display_info.height as i32)
            .max()? as f64;
        let width = max_x - min_x;
        let height = max_y - min_y;

        if width <= 0.0 || height <= 0.0 {
            None
        } else {
            let displays = screens
                .iter()
                .map(|screen| ScreenDisplayBounds {
                    id: screen.display_info.id,
                    x: screen.display_info.x as f64,
                    y: screen.display_info.y as f64,
                    width: screen.display_info.width as f64,
                    height: screen.display_info.height as f64,
                })
                .collect();
            Some(Self {
                x: min_x,
                y: min_y,
                width,
                height,
                displays,
            })
        }
    }

    fn fallback() -> Self {
        match rdev::display_size() {
            Ok((width, height)) if width > 0 && height > 0 => Self {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
                displays: Vec::new(),
            },
            _ => Self {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
                displays: Vec::new(),
            },
        }
    }

    fn normalize(&self, x: f64, y: f64) -> (f64, f64) {
        (
            round4(((x - self.x) / self.width).clamp(0.0, 1.0)),
            round4(((y - self.y) / self.height).clamp(0.0, 1.0)),
        )
    }

    fn normalize_position(&self, x: f64, y: f64) -> NormalizedPosition {
        let (normalized_x, normalized_y) = self.normalize(x, y);
        NormalizedPosition {
            x: normalized_x,
            y: normalized_y,
            display_id: self.display_id_at(x, y),
        }
    }

    fn display_id_at(&self, x: f64, y: f64) -> Option<u32> {
        self.displays
            .iter()
            .find(|display| {
                x >= display.x
                    && x < display.x + display.width
                    && y >= display.y
                    && y < display.y + display.height
            })
            .map(|display| display.id)
    }
}

#[cfg(feature = "native-recorders")]
fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(feature = "native-recorders")]
fn duration_millis(duration: Duration) -> f64 {
    round4(duration.as_secs_f64() * 1000.0)
}

#[cfg(feature = "native-recorders")]
fn add_display_id(data: &mut Value, display_id: Option<u32>) {
    if let Some(display_id) = display_id {
        data["display_id"] = json!(display_id);
    }
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn mouse_event_position(
    last_position: NormalizedPosition,
    sampled_position: Option<(f64, f64)>,
    bounds: &ScreenBounds,
) -> NormalizedPosition {
    sampled_position
        .map(|(x, y)| bounds.normalize_position(x, y))
        .unwrap_or(last_position)
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn sample_cursor_position() -> Option<(f64, f64)> {
    use std::mem::zeroed;
    use winapi::shared::windef::POINT;
    use winapi::um::winuser::GetCursorPos;

    unsafe {
        let mut point: POINT = zeroed();
        if GetCursorPos(&mut point) == 0 {
            None
        } else {
            Some((point.x as f64, point.y as f64))
        }
    }
}

#[cfg(all(feature = "native-recorders", target_os = "linux"))]
fn sample_cursor_position() -> Option<(f64, f64)> {
    use std::ptr::null;
    use x11::xlib;

    unsafe {
        let display = xlib::XOpenDisplay(null());
        if display.is_null() {
            return None;
        }

        let root_window = xlib::XRootWindow(display, 0);
        let mut root_x = 0;
        let mut root_y = 0;
        let mut window_x = 0;
        let mut window_y = 0;
        let mut root = 0;
        let mut child = 0;
        let mut mask = 0;
        let found = xlib::XQueryPointer(
            display,
            root_window,
            &mut root,
            &mut child,
            &mut root_x,
            &mut root_y,
            &mut window_x,
            &mut window_y,
            &mut mask,
        );
        xlib::XCloseDisplay(display);

        if found == 0 {
            None
        } else {
            Some((root_x as f64, root_y as f64))
        }
    }
}

#[cfg(all(
    feature = "native-recorders",
    not(any(target_os = "windows", target_os = "macos", target_os = "linux"))
))]
fn sample_cursor_position() -> Option<(f64, f64)> {
    None
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn normalize_button(button: rdev::Button) -> String {
    match button {
        rdev::Button::Left => "left".to_string(),
        rdev::Button::Right => "right".to_string(),
        rdev::Button::Middle => "middle".to_string(),
        rdev::Button::Unknown(code) => format!("unknown_{code}"),
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn normalize_windows_button(button: WindowsMouseButton) -> String {
    match button {
        WindowsMouseButton::Left => "left".to_string(),
        WindowsMouseButton::Right => "right".to_string(),
        WindowsMouseButton::Middle => "middle".to_string(),
        WindowsMouseButton::Unknown(code) => format!("unknown_{code}"),
    }
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn is_modifier_key_name(key: &str) -> bool {
    matches!(
        key,
        "ctrl" | "shift" | "alt" | "command" | "win" | "windows"
    )
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn annotate_unresolved_key_code(data: &mut serde_json::Value, code: Option<u32>) {
    let Some(code) = code else {
        return;
    };

    data["key_code"] = json!(code);
    data["unresolved"] = json!(true);

    #[cfg(target_os = "windows")]
    if let Some(name) = windows_virtual_key_name(code) {
        data["windows_virtual_key"] = json!(name);
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_virtual_key_name(code: u32) -> Option<String> {
    let name = match code {
        0xA6 => "VK_BROWSER_BACK",
        0xA7 => "VK_BROWSER_FORWARD",
        0xA8 => "VK_BROWSER_REFRESH",
        0xA9 => "VK_BROWSER_STOP",
        0xAA => "VK_BROWSER_SEARCH",
        0xAB => "VK_BROWSER_FAVORITES",
        0xAC => "VK_BROWSER_HOME",
        0xAD => "VK_VOLUME_MUTE",
        0xAE => "VK_VOLUME_DOWN",
        0xAF => "VK_VOLUME_UP",
        0xB0 => "VK_MEDIA_NEXT_TRACK",
        0xB1 => "VK_MEDIA_PREV_TRACK",
        0xB2 => "VK_MEDIA_STOP",
        0xB3 => "VK_MEDIA_PLAY_PAUSE",
        0xB4 => "VK_LAUNCH_MAIL",
        0xB5 => "VK_LAUNCH_MEDIA_SELECT",
        0xB6 => "VK_LAUNCH_APP1",
        0xB7 => "VK_LAUNCH_APP2",
        0xBA => "VK_OEM_1",
        0xBB => "VK_OEM_PLUS",
        0xBC => "VK_OEM_COMMA",
        0xBD => "VK_OEM_MINUS",
        0xBE => "VK_OEM_PERIOD",
        0xBF => "VK_OEM_2",
        0xC0 => "VK_OEM_3",
        0xDB => "VK_OEM_4",
        0xDC => "VK_OEM_5",
        0xDD => "VK_OEM_6",
        0xDE => "VK_OEM_7",
        0xDF => "VK_OEM_8",
        0xE2 => "VK_OEM_102",
        0xE5 => "VK_PROCESSKEY",
        0xE7 => "VK_PACKET",
        0xF6 => "VK_ATTN",
        0xF7 => "VK_CRSEL",
        0xF8 => "VK_EXSEL",
        0xF9 => "VK_EREOF",
        0xFA => "VK_PLAY",
        0xFB => "VK_ZOOM",
        0xFC => "VK_NONAME",
        0xFD => "VK_PA1",
        0xFE => "VK_OEM_CLEAR",
        _ if matches!(code, 0x0A..=0x0B | 0x3A..=0x40 | 0x88..=0x8F | 0x97..=0x9F | 0xB8..=0xB9 | 0xC1..=0xDA | 0xE0 | 0xE8) =>
        {
            return Some(format!("VK_RESERVED_0x{code:02X}"));
        }
        _ => return None,
    };
    Some(name.to_string())
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn annotate_lock_key_state(data: &mut serde_json::Value, key_name: &str) {
    if key_name != "capslock" {
        return;
    }

    let Some(lock_on) = current_capslock_state() else {
        return;
    };

    data["lock_on"] = json!(lock_on);
    data["lock_state"] = json!(if lock_on { "on" } else { "off" });
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn current_capslock_state() -> Option<bool> {
    use winapi::um::winuser::{GetKeyState, VK_CAPITAL};

    Some(unsafe { (GetKeyState(VK_CAPITAL) & 0x0001) != 0 })
}

#[cfg(all(
    feature = "native-recorders",
    not(any(target_os = "windows", target_os = "macos"))
))]
fn current_capslock_state() -> Option<bool> {
    None
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn unresolved_native_key_code(key: rdev::Key) -> Option<u32> {
    match key {
        rdev::Key::Unknown(code) => Some(code),
        _ => None,
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
#[allow(dead_code)]
fn meta_key_name() -> &'static str {
    "windows"
}

#[cfg(all(
    feature = "native-recorders",
    not(any(target_os = "windows", target_os = "macos"))
))]
fn meta_key_name() -> &'static str {
    "command"
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
struct WindowsKeyName {
    name: String,
    unresolved_code: Option<u32>,
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_key_name(pressed: bool, vk_code: u32, scan_code: u32) -> WindowsKeyName {
    if vk_code == WINDOWS_VK_PACKET {
        if let Some(name) = windows_packet_name_from_scan_code(scan_code)
            .and_then(|value| normalized_event_name(&value))
        {
            return WindowsKeyName {
                name,
                unresolved_code: None,
            };
        }
        return windows_unknown_key_name(vk_code);
    }

    if pressed {
        if let Some(name) = windows_printable_key_name(vk_code, scan_code)
            .and_then(|value| normalized_event_name(&value))
        {
            return WindowsKeyName {
                name,
                unresolved_code: None,
            };
        }
    }

    if let Some(name) = windows_virtual_key_normalized_name(vk_code) {
        return WindowsKeyName {
            name: name.to_string(),
            unresolved_code: None,
        };
    }

    windows_unknown_key_name(vk_code)
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_unknown_key_name(vk_code: u32) -> WindowsKeyName {
    WindowsKeyName {
        name: format!("unknown_{vk_code}"),
        unresolved_code: Some(vk_code),
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_printable_key_name(vk_code: u32, scan_code: u32) -> Option<String> {
    use std::ptr::null_mut;
    use winapi::um::processthreadsapi::GetCurrentThreadId;
    use winapi::um::winuser::{
        AttachThreadInput, GetForegroundWindow, GetKeyboardLayout, GetKeyboardState,
        GetWindowThreadProcessId, ToUnicodeEx,
    };

    unsafe {
        let mut state = [0_u8; 256];
        let foreground_thread_id = GetWindowThreadProcessId(GetForegroundWindow(), null_mut());
        let current_thread_id = GetCurrentThreadId();
        let status = if foreground_thread_id != 0
            && AttachThreadInput(current_thread_id, foreground_thread_id, 1) == 1
        {
            let status = GetKeyboardState(state.as_mut_ptr());
            AttachThreadInput(current_thread_id, foreground_thread_id, 0);
            status
        } else {
            GetKeyboardState(state.as_mut_ptr())
        };
        if status != 1 {
            return None;
        }

        let layout = GetKeyboardLayout(foreground_thread_id);
        let mut buffer = [0_u16; 8];
        let len = ToUnicodeEx(
            vk_code,
            scan_code,
            state.as_mut_ptr(),
            buffer.as_mut_ptr(),
            buffer.len() as i32 - 1,
            0,
            layout,
        );
        if len <= 0 {
            return None;
        }
        String::from_utf16(&buffer[..len as usize]).ok()
    }
}

#[cfg(all(feature = "native-recorders", target_os = "windows"))]
fn windows_virtual_key_normalized_name(vk_code: u32) -> Option<&'static str> {
    let name = match vk_code {
        0x08 => "backspace",
        0x09 => "tab",
        0x0D => "enter",
        0x10 | 0xA0 | 0xA1 => "shift",
        0x11 | 0xA2 | 0xA3 => "ctrl",
        0x12 | 0xA4 | 0xA5 => "alt",
        0x14 => "capslock",
        0x1B => "esc",
        0x20 => "space",
        0x21 => "pageup",
        0x22 => "pagedown",
        0x23 => "end",
        0x24 => "home",
        0x25 => "left",
        0x26 => "up",
        0x27 => "right",
        0x28 => "down",
        0x2C => "printscreen",
        0x2D => "insert",
        0x2E => "delete",
        0x5B | 0x5C => "windows",
        0x6A => "*",
        0x6B => "+",
        0x6D => "-",
        0x6E => ".",
        0x6F => "/",
        0x70 => "f1",
        0x71 => "f2",
        0x72 => "f3",
        0x73 => "f4",
        0x74 => "f5",
        0x75 => "f6",
        0x76 => "f7",
        0x77 => "f8",
        0x78 => "f9",
        0x79 => "f10",
        0x7A => "f11",
        0x7B => "f12",
        0x90 => "numlock",
        0x91 => "scrolllock",
        0xBA => ";",
        0xBB => "=",
        0xBC => ",",
        0xBD => "-",
        0xBE => ".",
        0xBF => "/",
        0xC0 => "`",
        0xDB => "[",
        0xDC => "\\",
        0xDD => "]",
        0xDE => "'",
        0xE2 => "\\",
        0x30 => "0",
        0x31 => "1",
        0x32 => "2",
        0x33 => "3",
        0x34 => "4",
        0x35 => "5",
        0x36 => "6",
        0x37 => "7",
        0x38 => "8",
        0x39 => "9",
        0x41 => "a",
        0x42 => "b",
        0x43 => "c",
        0x44 => "d",
        0x45 => "e",
        0x46 => "f",
        0x47 => "g",
        0x48 => "h",
        0x49 => "i",
        0x4A => "j",
        0x4B => "k",
        0x4C => "l",
        0x4D => "m",
        0x4E => "n",
        0x4F => "o",
        0x50 => "p",
        0x51 => "q",
        0x52 => "r",
        0x53 => "s",
        0x54 => "t",
        0x55 => "u",
        0x56 => "v",
        0x57 => "w",
        0x58 => "x",
        0x59 => "y",
        0x5A => "z",
        0x60 => "0",
        0x61 => "1",
        0x62 => "2",
        0x63 => "3",
        0x64 => "4",
        0x65 => "5",
        0x66 => "6",
        0x67 => "7",
        0x68 => "8",
        0x69 => "9",
        _ => return None,
    };
    Some(name)
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn normalize_key(key: rdev::Key, name: Option<&str>) -> String {
    if let Some(name) = name.and_then(normalized_event_name) {
        return name;
    }

    match key {
        rdev::Key::Alt | rdev::Key::AltGr => "alt",
        rdev::Key::Backspace => "backspace",
        rdev::Key::CapsLock => "capslock",
        rdev::Key::ControlLeft | rdev::Key::ControlRight => "ctrl",
        rdev::Key::Delete => "delete",
        rdev::Key::DownArrow => "down",
        rdev::Key::End => "end",
        rdev::Key::Escape => "esc",
        rdev::Key::F1 => "f1",
        rdev::Key::F2 => "f2",
        rdev::Key::F3 => "f3",
        rdev::Key::F4 => "f4",
        rdev::Key::F5 => "f5",
        rdev::Key::F6 => "f6",
        rdev::Key::F7 => "f7",
        rdev::Key::F8 => "f8",
        rdev::Key::F9 => "f9",
        rdev::Key::F10 => "f10",
        rdev::Key::F11 => "f11",
        rdev::Key::F12 => "f12",
        rdev::Key::Home => "home",
        rdev::Key::LeftArrow => "left",
        rdev::Key::MetaLeft | rdev::Key::MetaRight => meta_key_name(),
        rdev::Key::PageDown => "pagedown",
        rdev::Key::PageUp => "pageup",
        rdev::Key::Return | rdev::Key::KpReturn => "enter",
        rdev::Key::RightArrow => "right",
        rdev::Key::ShiftLeft | rdev::Key::ShiftRight => "shift",
        rdev::Key::Space => "space",
        rdev::Key::Tab => "tab",
        rdev::Key::UpArrow => "up",
        rdev::Key::PrintScreen => "printscreen",
        rdev::Key::ScrollLock => "scrolllock",
        rdev::Key::Pause => "pause",
        rdev::Key::NumLock => "numlock",
        rdev::Key::BackQuote => "`",
        rdev::Key::Num1 | rdev::Key::Kp1 => "1",
        rdev::Key::Num2 | rdev::Key::Kp2 => "2",
        rdev::Key::Num3 | rdev::Key::Kp3 => "3",
        rdev::Key::Num4 | rdev::Key::Kp4 => "4",
        rdev::Key::Num5 | rdev::Key::Kp5 => "5",
        rdev::Key::Num6 | rdev::Key::Kp6 => "6",
        rdev::Key::Num7 | rdev::Key::Kp7 => "7",
        rdev::Key::Num8 | rdev::Key::Kp8 => "8",
        rdev::Key::Num9 | rdev::Key::Kp9 => "9",
        rdev::Key::Num0 | rdev::Key::Kp0 => "0",
        rdev::Key::Minus | rdev::Key::KpMinus => "-",
        rdev::Key::Equal => "=",
        rdev::Key::KeyQ => "q",
        rdev::Key::KeyW => "w",
        rdev::Key::KeyE => "e",
        rdev::Key::KeyR => "r",
        rdev::Key::KeyT => "t",
        rdev::Key::KeyY => "y",
        rdev::Key::KeyU => "u",
        rdev::Key::KeyI => "i",
        rdev::Key::KeyO => "o",
        rdev::Key::KeyP => "p",
        rdev::Key::LeftBracket => "[",
        rdev::Key::RightBracket => "]",
        rdev::Key::KeyA => "a",
        rdev::Key::KeyS => "s",
        rdev::Key::KeyD => "d",
        rdev::Key::KeyF => "f",
        rdev::Key::KeyG => "g",
        rdev::Key::KeyH => "h",
        rdev::Key::KeyJ => "j",
        rdev::Key::KeyK => "k",
        rdev::Key::KeyL => "l",
        rdev::Key::SemiColon => ";",
        rdev::Key::Quote => "'",
        rdev::Key::BackSlash | rdev::Key::IntlBackslash => "\\",
        rdev::Key::KeyZ => "z",
        rdev::Key::KeyX => "x",
        rdev::Key::KeyC => "c",
        rdev::Key::KeyV => "v",
        rdev::Key::KeyB => "b",
        rdev::Key::KeyN => "n",
        rdev::Key::KeyM => "m",
        rdev::Key::Comma => ",",
        rdev::Key::Dot | rdev::Key::KpDelete => ".",
        rdev::Key::Slash | rdev::Key::KpDivide => "/",
        rdev::Key::Insert => "insert",
        rdev::Key::KpPlus => "+",
        rdev::Key::KpMultiply => "*",
        rdev::Key::Function => "function",
        rdev::Key::Unknown(code) => return format!("unknown_{code}"),
    }
    .to_string()
}

#[cfg(all(feature = "native-recorders", not(target_os = "macos")))]
fn normalized_event_name(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }

    Some(match name {
        " " => "space".to_string(),
        "\n" | "\r" => "enter".to_string(),
        "\t" => "tab".to_string(),
        other => other.to_string(),
    })
}

#[cfg(all(test, feature = "native-recorders", not(target_os = "macos")))]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_unknown_keys_include_virtual_key_diagnostics() {
        let callback: EventCallback = Arc::new(|_| {});
        let bounds = ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            displays: Vec::new(),
        };
        let mut session = InputSession::new(callback, bounds);

        let event = session.key_down_event(0.1, rdev::Key::Unknown(0xB9), None);

        assert_eq!(event["data"]["key"], "unknown_185");
        assert_eq!(event["data"]["key_code"], 185);
        assert_eq!(event["data"]["unresolved"], true);
        assert_eq!(event["data"]["windows_virtual_key"], "VK_RESERVED_0xB9");
    }

    #[test]
    fn mouse_event_position_prefers_normalized_sampled_position() {
        let bounds = ScreenBounds {
            x: 100.0,
            y: 50.0,
            width: 200.0,
            height: 100.0,
            displays: vec![ScreenDisplayBounds {
                id: 42,
                x: 100.0,
                y: 50.0,
                width: 200.0,
                height: 100.0,
            }],
        };

        assert_eq!(
            mouse_event_position(
                NormalizedPosition {
                    x: 0.1,
                    y: 0.2,
                    display_id: None,
                },
                Some((150.0, 75.0)),
                &bounds
            ),
            NormalizedPosition {
                x: 0.25,
                y: 0.25,
                display_id: Some(42),
            }
        );
    }

    #[test]
    fn mouse_event_position_falls_back_to_last_position() {
        let bounds = ScreenBounds {
            x: 100.0,
            y: 50.0,
            width: 200.0,
            height: 100.0,
            displays: Vec::new(),
        };

        let last_position = NormalizedPosition {
            x: 0.1,
            y: 0.2,
            display_id: Some(7),
        };
        assert_eq!(
            mouse_event_position(last_position, None, &bounds),
            last_position
        );
    }

    #[test]
    fn unresolved_native_key_events_keep_raw_key_code_metadata() {
        let callback: EventCallback = Arc::new(|_| {});
        let bounds = ScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            displays: Vec::new(),
        };
        let mut session = InputSession::new(callback, bounds);

        let down = session.key_down_event(0.1, rdev::Key::Unknown(231), None);
        assert_eq!(down["data"]["key"], "unknown_231");
        assert_eq!(down["data"]["key_code"], 231);
        assert_eq!(down["data"]["unresolved"], true);

        let up = session.key_up_event(0.2, rdev::Key::Unknown(231), None);
        assert_eq!(up["data"]["key"], "unknown_231");
        assert_eq!(up["data"]["key_code"], 231);
        assert_eq!(up["data"]["unresolved"], true);

        #[cfg(target_os = "windows")]
        {
            assert_eq!(down["data"]["windows_virtual_key"], "VK_PACKET");
            assert_eq!(up["data"]["windows_virtual_key"], "VK_PACKET");
        }
    }
}

#[cfg(all(test, feature = "native-recorders"))]
mod screenshot_capture_tests {
    use super::*;

    #[test]
    fn plain_mouse_moves_do_not_hold_screenshot_burst_mode() {
        assert!(!event_marks_screenshot_activity(&json!({
            "type": "mouse_move",
            "data": { "x": 0.4, "y": 0.5, "is_dragging": false }
        })));
        assert!(event_marks_screenshot_activity(&json!({
            "type": "mouse_move",
            "data": { "x": 0.4, "y": 0.5, "is_dragging": true }
        })));
        assert!(event_marks_screenshot_activity(&json!({
            "type": "mouse_down",
            "data": { "x": 0.4, "y": 0.5 }
        })));
    }

    fn test_raw_frame(frame_id: u64) -> RawScreenshotFrame {
        RawScreenshotFrame {
            frame_id,
            timestamp: frame_id as f64,
            capture_started_timestamp: frame_id as f64 - 0.01,
            target_interval: Duration::from_millis(100),
            capture_duration: Duration::from_millis(25),
            capture: CapturedDesktop {
                mode: ScreenshotCaptureMode::AllDisplays,
                image: RgbaImage::new(1, 1),
                bounds: ScreenBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                    displays: Vec::new(),
                },
                displays: Vec::new(),
            },
            enqueued_at: Instant::now(),
            raw_queue_depth: 0,
            dropped_raw_frames: 0,
        }
    }

    #[test]
    fn screenshot_frame_queue_drops_oldest_when_full() {
        let queue = ScreenshotFrameQueue::new(2);

        assert!(queue.push_drop_oldest(test_raw_frame(1)));
        assert!(queue.push_drop_oldest(test_raw_frame(2)));
        assert!(queue.push_drop_oldest(test_raw_frame(3)));

        let first = queue.pop().expect("first retained frame");
        let second = queue.pop().expect("second retained frame");
        queue.close();

        assert_eq!(first.frame_id, 2);
        assert_eq!(second.frame_id, 3);
        assert_eq!(second.raw_queue_depth, 2);
        assert_eq!(second.dropped_raw_frames, 1);
        assert!(queue.pop().is_none());
    }

    #[test]
    fn screen_frame_queue_default_capacity_drops_oldest() {
        let queue = ScreenshotFrameQueue::new(DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY);

        for frame_id in 1..=DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY as u64 {
            assert!(queue.push_drop_oldest(test_raw_frame(frame_id)));
        }
        assert!(queue.push_drop_oldest(test_raw_frame(
            DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY as u64 + 1,
        )));

        queue.close();
        let mut retained = Vec::new();
        while let Some(frame) = queue.pop() {
            retained.push(frame);
        }

        assert_eq!(retained.len(), DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY);
        assert_eq!(retained.first().map(|frame| frame.frame_id), Some(2));
        let last = retained.last().expect("last retained frame");
        assert_eq!(
            last.frame_id,
            DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY as u64 + 1
        );
        assert_eq!(last.raw_queue_depth, DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY);
        assert_eq!(last.dropped_raw_frames, 1);
    }

    #[test]
    fn screen_frame_queue_capacity_is_sanitized() {
        assert_eq!(sanitize_screen_frame_queue_capacity(0), 1);
        assert_eq!(
            sanitize_screen_frame_queue_capacity(DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY),
            DEFAULT_SCREEN_FRAME_QUEUE_CAPACITY
        );
        assert_eq!(
            sanitize_screen_frame_queue_capacity(MAX_SCREEN_FRAME_QUEUE_CAPACITY + 1),
            MAX_SCREEN_FRAME_QUEUE_CAPACITY
        );
    }

    #[test]
    fn screen_frame_queue_capacity_reads_global_config() {
        let config = Config::from_value(json!({
            "screen_recorder": { "frame_queue_capacity": 12 }
        }));

        assert_eq!(configured_screen_frame_queue_capacity(&config), 12);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn screen_frame_queue_capacity_prefers_windows_override() {
        let config = Config::from_value(json!({
            "screen_recorder": {
                "frame_queue_capacity": 50,
                "windows_frame_queue_capacity": 8
            }
        }));

        assert_eq!(configured_screen_frame_queue_capacity(&config), 8);
    }

    #[test]
    fn screenshot_pipeline_diagnostics_record_frame_timings() {
        let mut frame = test_raw_frame(42);
        frame.raw_queue_depth = 2;
        frame.dropped_raw_frames = 3;
        let mut data = json!({});

        add_screenshot_pipeline_diagnostics(
            &mut data,
            frame.frame_id,
            frame.capture_started_timestamp,
            frame.capture_duration,
            frame.target_interval,
            frame.raw_queue_depth,
            frame.dropped_raw_frames,
            Duration::from_millis(12),
            Duration::from_millis(34),
        );

        assert_eq!(data["frame_id"], 42);
        assert_eq!(data["capture_duration_ms"], 25.0);
        assert_eq!(data["target_interval_ms"], 100.0);
        assert_eq!(data["capture_limited"], false);
        assert_eq!(data["queue_wait_ms"], 12.0);
        assert_eq!(data["encode_duration_ms"], 34.0);
        assert_eq!(data["raw_queue_depth"], 2);
        assert_eq!(data["dropped_raw_frames"], 3);
    }

    #[test]
    fn screenshot_capture_mode_accepts_all_display_aliases() {
        for value in ["all_displays", "all-displays", "all"] {
            assert_eq!(
                ScreenshotCaptureMode::from_config(Some(value.to_string())),
                ScreenshotCaptureMode::AllDisplays
            );
        }
    }

    #[test]
    fn screenshot_capture_mode_defaults_to_all_displays() {
        assert_eq!(
            ScreenshotCaptureMode::from_config(None),
            ScreenshotCaptureMode::AllDisplays
        );
        assert_eq!(
            ScreenshotCaptureMode::from_config(Some("".to_string())),
            ScreenshotCaptureMode::AllDisplays
        );
        assert_eq!(
            ScreenshotCaptureMode::from_config(Some("unknown".to_string())),
            ScreenshotCaptureMode::Stitched
        );
    }

    #[test]
    fn screenshot_payload_records_current_display_ids() {
        let encoded = EncodedScreenshot {
            image: "abc".to_string(),
            width: 10,
            height: 20,
            data: Value::Null,
        };

        let payload = screenshot_payload(
            &encoded,
            ScreenshotCaptureMode::AllDisplays,
            Some(vec![json!({
                "display_id": 7,
                "image": "display-image",
            })]),
            Some(json!({
                "x": 0.0,
                "y": 0.0,
                "width": 10.0,
                "height": 20.0,
            })),
            Some(7),
            Some(7),
            Some(7),
            Some(7),
        );

        assert_eq!(payload["capture_mode"], "all_displays");
        assert_eq!(payload["active_display_id"], 7);
        assert_eq!(payload["current_display_id"], 7);
        assert_eq!(payload["pointer_display_id"], 7);
        assert_eq!(payload["focused_display_id"], 7);
        assert_eq!(payload["displays"][0]["display_id"], 7);
        assert_eq!(payload["desktop_bounds"]["width"], 10.0);
    }

    #[test]
    fn action_screenshots_keep_only_the_displays_the_person_works_on() {
        // Pointer and focus on display 4 of {1, 4}: only 4 keeps its image.
        assert!(keeps_display_image(4, Some(4), Some(4)));
        assert!(!keeps_display_image(1, Some(4), Some(4)));
        // Pointer on one display, focused window on another: both keep theirs.
        assert!(
            keeps_display_image(1, Some(1), Some(4)) && keeps_display_image(4, Some(1), Some(4))
        );
        // Windows reports no focused display: the pointer's display decides.
        assert!(keeps_display_image(2, Some(2), None) && !keeps_display_image(1, Some(2), None));
        // Nothing known: every display keeps its image.
        assert!(keeps_display_image(1, None, None) && keeps_display_image(4, None, None));
    }

    #[test]
    fn active_display_prefers_focused_display_before_pointer() {
        assert_eq!(active_display_id(Some(3), Some(1)), Some(3));
        assert_eq!(active_display_id(None, Some(1)), Some(1));
        assert_eq!(active_display_id(None, None), None);
    }

    #[test]
    fn display_screenshot_payload_records_logical_and_normalized_bounds() {
        let display = CapturedDisplay {
            id: 3,
            is_primary: false,
            x: 100.0,
            y: -100.0,
            width: 200.0,
            height: 200.0,
            image: RgbaImage::new(1, 1),
        };
        let encoded = EncodedScreenshot {
            image: "display-image".to_string(),
            width: 20,
            height: 20,
            data: Value::Null,
        };
        let desktop_bounds = ScreenBounds {
            x: 0.0,
            y: -100.0,
            width: 300.0,
            height: 200.0,
            displays: Vec::new(),
        };

        let payload = display_screenshot_payload(&display, &encoded, &desktop_bounds);

        assert_eq!(payload["display_id"], 3);
        assert_eq!(payload["bounds"]["x"], 100.0);
        assert_eq!(payload["bounds"]["y"], -100.0);
        assert_eq!(payload["normalized_bounds"]["x"], 0.3333);
        assert_eq!(payload["normalized_bounds"]["y"], 0.0);
        assert_eq!(payload["normalized_bounds"]["width"], 0.6667);
        assert_eq!(payload["normalized_bounds"]["height"], 1.0);
    }

    #[test]
    fn display_id_for_point_uses_display_bounds() {
        let displays = vec![
            CapturedDisplay {
                id: 1,
                is_primary: true,
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
                image: RgbaImage::new(1, 1),
            },
            CapturedDisplay {
                id: 2,
                is_primary: false,
                x: 1512.0,
                y: -464.0,
                width: 1920.0,
                height: 1080.0,
                image: RgbaImage::new(1, 1),
            },
        ];

        assert_eq!(display_id_for_point(&displays, 756.0, 491.0), Some(1));
        assert_eq!(display_id_for_point(&displays, 2472.0, 76.0), Some(2));
        assert_eq!(display_id_for_point(&displays, -1.0, -1.0), None);
    }

    fn solid_capture(luma: u8) -> CapturedDesktop {
        let mut image = RgbaImage::new(16, 16);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgba([luma, luma, luma, 255]);
        }
        CapturedDesktop {
            mode: ScreenshotCaptureMode::AllDisplays,
            image,
            bounds: ScreenBounds {
                x: 0.0,
                y: 0.0,
                width: 16.0,
                height: 16.0,
                displays: Vec::new(),
            },
            displays: Vec::new(),
        }
    }

    #[test]
    fn selected_frame_interval_uses_idle_interval_after_idle_after() {
        let activity = ActivityTracker::new();
        // last_activity is "now"; force it into the past so the recorder is idle.
        *lock_unpoisoned(&activity.last_activity) = Instant::now() - Duration::from_secs(60);

        let interval = selected_frame_interval(
            &activity,
            Duration::from_secs(1),
            Duration::from_secs(3),
            Duration::from_millis(66),
            Duration::from_millis(200),
            Duration::from_secs(15),
        );

        assert_eq!(interval, Duration::from_secs(15));
    }

    #[test]
    fn first_idle_frame_always_emits() {
        assert!(should_emit_idle_frame(
            42,
            None,
            3,
            None,
            Duration::from_secs(300),
        ));
    }

    #[test]
    fn near_identical_idle_frame_is_suppressed() {
        // Same hash, well within the heartbeat window: should be dropped.
        assert!(!should_emit_idle_frame(
            42,
            Some(42),
            3,
            Some(Duration::from_secs(1)),
            Duration::from_secs(300),
        ));
    }

    #[test]
    fn changed_idle_frame_emits() {
        // Hamming distance between 0b0000 and 0b1111 is 4, above the threshold.
        assert!(should_emit_idle_frame(
            0b1111,
            Some(0b0000),
            3,
            Some(Duration::from_secs(1)),
            Duration::from_secs(300),
        ));
    }

    #[test]
    fn heartbeat_emits_unchanged_idle_frame() {
        // Identical hash but heartbeat window elapsed: emit to keep the timeline alive.
        assert!(should_emit_idle_frame(
            42,
            Some(42),
            3,
            Some(Duration::from_secs(301)),
            Duration::from_secs(300),
        ));
    }

    #[test]
    fn unchanged_frames_reuse_their_jpeg_without_encoding_again() {
        let mut cache = ScreenshotEncodeCache::default();
        let first = cache
            .encode(0, &solid_capture(10).image, 0.5, 60)
            .expect("encode");
        let same = cache
            .encode(0, &solid_capture(10).image, 0.5, 60)
            .expect("cached");
        assert_eq!(
            cache.encodes, 1,
            "a byte-identical frame is not encoded again"
        );
        assert_eq!(same.image, first.image);
        assert_eq!((same.width, same.height), (first.width, first.height));
        let changed = cache
            .encode(0, &solid_capture(200).image, 0.5, 60)
            .expect("changed");
        assert_eq!(cache.encodes, 2);
        assert_ne!(changed.image, first.image);
        // Slots are independent: another display's frame never matches display 0.
        cache
            .encode(1, &solid_capture(200).image, 0.5, 60)
            .expect("second display");
        assert_eq!(cache.encodes, 3);
        // The cached bytes are what a fresh encode produces.
        let fresh = encode_screenshot_image(&solid_capture(200).image, 0.5, 60).expect("fresh");
        assert_eq!(fresh.image, changed.image);
    }

    #[test]
    fn identical_captures_share_a_dhash() {
        let a = screenshot_capture_dhash(&solid_capture(10), 0.5);
        let b = screenshot_capture_dhash(&solid_capture(10), 0.5);
        assert_eq!(a, b);
        assert_eq!(hamming_distance(a, b), 0);
    }
}

#[cfg(not(feature = "native-recorders"))]
struct InputRecorderPlaceholder {
    _callback: EventCallback,
}

#[cfg(not(feature = "native-recorders"))]
impl InputRecorderPlaceholder {
    fn new(callback: EventCallback) -> Self {
        Self {
            _callback: callback,
        }
    }
}

#[cfg(not(feature = "native-recorders"))]
impl Recorder for InputRecorderPlaceholder {
    fn start(&mut self) -> Result<()> {
        tracing::warn!(
            "native input capture is not enabled in this Rust build; compile with feature `native-recorders`"
        );
        Ok(())
    }

    fn stop(&mut self) -> Result<()> {
        Ok(())
    }
}
