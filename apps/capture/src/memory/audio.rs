//! Audio memory: opt-in 24/7 recording of the microphone and of what the
//! computer plays, stored next to the screen timeline.
//!
//! Off by default (`audio.enabled`). While it is on and recording is neither
//! off nor paused, two threads run in the recorder:
//!
//! 1. `memory-audio` keeps one engine process per source
//!    (`kortix-capture-engine audio --source microphone|system|file`). Each
//!    writes raw PCM (16 kHz, mono, s16le) to stdout and JSON events to stderr.
//!    A source that exits restarts with backoff; exit code 3 (the default
//!    device changed, headphones plugged in) restarts at once, exit code 2
//!    (permission missing) every 30 s. The mixer places every block on the
//!    wall clock, sums the sources and writes one PCM file per wall-clock
//!    minute into `audio/staging/` (shorter at a start, a stop or a gap).
//! 2. `memory-audio-finalize` encodes each closed PCM file with the engine
//!    (`encode_audio`: AAC in M4A), inserts an `audio` row, optionally
//!    transcribes it on the device (`transcribe`) into `audio_transcript` /
//!    `audio_fts`, and deletes the PCM.
//!
//! Turning audio off stops the sources and closes the open segment within one
//! tick (250 ms). A fresh library never starts a source, creates no `audio/`
//! directory and has no `audio` row.

use super::engine::{self, Engine};
use super::paths::MemoryPaths;
use super::recorder::RecorderStatus;
use super::redaction;
use super::settings::Settings;
use super::store::{self, now_ms};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Samples per second of the PCM the sources deliver and the encoder reads.
pub const RATE: i64 = 16_000;
/// Encoded bitrate (AAC-LC, mono). macOS and Linux honor it; the Windows AAC
/// encoder's floor is 96 kbps.
pub const BITRATE: u32 = 32_000;
/// One segment per wall-clock minute.
pub const SEGMENT_MS: i64 = 60_000;
/// Samples are committed this far behind the wall clock, so a late source still lands.
const LATENCY_MS: i64 = 400;
/// A source whose next block is more than this off the wall clock is re-anchored.
const RESYNC_MS: i64 = 500;
/// A source without data for this long no longer counts as recording.
const LIVE_MS: i64 = 1_500;
/// After all data is committed, a block that starts this much later restarts the timeline.
const GAP_MS: i64 = 1_000;
/// Segments shorter than this are dropped.
const MIN_SEGMENT_MS: i64 = 500;
const TICK: Duration = Duration::from_millis(100);
/// Test and CI harnesses only: feed this WAV file (any rate, 16-bit PCM or
/// float) through the real engine source, mixer, encoder, store, transcription
/// and sync instead of the microphone and system audio. It plays once, in real
/// time. Never set in a shipped app; it exists so the pipeline can be verified
/// without a microphone permission prompt.
pub const TEST_WAV_ENV: &str = "KORTIX_CAPTURE_AUDIO_TEST_WAV";

pub const TRANSCRIPT_NONE: i64 = 0;
pub const TRANSCRIPT_PENDING: i64 = 1;
pub const TRANSCRIPT_DONE: i64 = 2;
pub const TRANSCRIPT_FAILED: i64 = 3;

const fn idx_of_ms(ms: i64) -> i64 {
    ms * RATE / 1000
}
const fn ms_of_idx(idx: i64) -> i64 {
    idx * 1000 / RATE
}

// ------------------------------------------------------------------- status

/// `<library>/audio.json`, read by the tray, `status` and the settings window.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AudioStatus {
    /// off | paused | locked | low_disk | sync_backlog | starting | recording |
    /// permission_missing | error
    pub state: String,
    pub sources: BTreeMap<String, SourceStatus>,
    /// Start of the segment being written, epoch ms.
    pub segment_start_ms: Option<i64>,
    /// The newest sample written, epoch ms.
    pub last_audio_ms: Option<i64>,
    pub last_error: Option<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SourceStatus {
    /// starting | recording | silent | restarting | permission_missing | error | finished
    pub state: String,
    pub device: Option<String>,
    pub error: Option<String>,
}

impl AudioStatus {
    pub fn read(paths: &MemoryPaths) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(paths.audio_status()).ok()?).ok()
    }
    /// Written within the last 10 s by a running recorder.
    pub fn is_fresh(&self, now: i64) -> bool {
        now - self.updated_at_ms < 10_000
    }
    fn write(&self, paths: &MemoryPaths) {
        let tmp = paths.audio_status().with_extension("json.tmp");
        if let Ok(b) = serde_json::to_vec_pretty(self) {
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(tmp, paths.audio_status());
            }
        }
    }
}

/// Why audio is not recording right now, or None when it should record.
/// Audio follows the screen recorder: off, paused, a locked screen, low disk
/// and a sync backlog stop it. Inactivity (no keyboard or mouse input) does not:
/// a call you only listen to is recorded.
pub fn gate(s: &Settings, recorder: Option<&RecorderStatus>, now: i64) -> Option<&'static str> {
    if !s.audio.enabled {
        return Some("off");
    }
    if let Some(r) = s.inactive_reason(now) {
        return Some(if matches!(r, "disabled" | "policy_off") {
            "off"
        } else {
            "paused"
        });
    }
    let fresh = recorder.filter(|r| now - r.updated_at_ms < 15_000);
    match fresh.map(|r| r.state.as_str()) {
        Some("locked") => Some("locked"),
        Some("low_disk") => Some("low_disk"),
        Some("sync_backlog") => Some("sync_backlog"),
        _ => None,
    }
}

// ------------------------------------------------------------------- sources

/// What one source process should be: its name and the engine arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpec {
    pub name: &'static str,
    pub args: Vec<String>,
}

/// The sources the settings ask for. The test WAV replaces every real source.
pub fn wanted_sources(s: &Settings, test_wav: Option<&str>) -> Vec<SourceSpec> {
    if let Some(wav) = test_wav.filter(|w| !w.is_empty()) {
        return vec![SourceSpec {
            name: "file",
            args: vec![
                "--source".into(),
                "file".into(),
                "--path".into(),
                wav.into(),
            ],
        }];
    }
    let mut out = Vec::new();
    if s.audio.microphone {
        let mut args = vec!["--source".to_string(), "microphone".to_string()];
        if !s.audio.input_device.trim().is_empty() {
            args.extend(["--device".into(), s.audio.input_device.trim().to_string()]);
        }
        out.push(SourceSpec {
            name: "microphone",
            args,
        });
    }
    if s.audio.system_audio {
        // Excluded apps' audio is left out where the OS allows it (macOS).
        let mut args = vec!["--source".to_string(), "system".to_string()];
        let excluded = s.effective_excluded_bundle_ids();
        if !excluded.is_empty() {
            args.extend(["--exclude".into(), excluded.join(",")]);
        }
        out.push(SourceSpec {
            name: "system",
            args,
        });
    }
    out
}

struct Block {
    at_ms: i64,
    samples: Vec<i16>,
}

struct Running {
    spec: SourceSpec,
    child: Child,
    rx: Receiver<Block>,
    events: Arc<Mutex<SourceStatus>>,
}

struct Slot {
    run: Option<Running>,
    /// Earliest restart after an exit.
    next_start: Instant,
    failures: u32,
    status: SourceStatus,
    finished: bool,
}

/// The file source plays once; every other source restarts after it exits.
fn restart_delay(code: Option<i32>, failures: u32) -> Option<Duration> {
    match code {
        Some(0) => None,
        Some(3) => Some(Duration::ZERO),
        Some(2) => Some(Duration::from_secs(30)),
        _ => Some(Duration::from_secs((2u64 << failures.min(5)).min(60))),
    }
}

fn spawn_source(exe: &Path, spec: &SourceSpec) -> Result<Running> {
    let mut child = crate::os_proc::no_window(&mut Command::new(exe))
        .arg("audio")
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start the {} audio source", spec.name))?;
    let mut stdout = child.stdout.take().context("audio source stdout")?;
    let stderr = child.stderr.take().context("audio source stderr")?;
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name(format!("audio-{}", spec.name))
        .spawn(move || {
            // 100 ms blocks; an odd trailing byte waits for its pair.
            let mut buf = vec![0u8; idx_of_ms(100) as usize * 2];
            let mut carry: Option<u8> = None;
            loop {
                let n = match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let at_ms = now_ms();
                let mut bytes: Vec<u8> = carry.take().into_iter().collect();
                bytes.extend_from_slice(&buf[..n]);
                if bytes.len() % 2 == 1 {
                    carry = bytes.pop();
                }
                let samples = bytes
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]))
                    .collect();
                if tx.send(Block { at_ms, samples }).is_err() {
                    break;
                }
            }
        })?;
    let events = Arc::new(Mutex::new(SourceStatus {
        state: "starting".into(),
        ..Default::default()
    }));
    let ev = events.clone();
    std::thread::Builder::new()
        .name(format!("audio-{}-events", spec.name))
        .spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    tracing::debug!("audio source: {line}");
                    continue;
                };
                let mut st = ev.lock().unwrap_or_else(|e| e.into_inner());
                match v["event"].as_str() {
                    Some("started") => {
                        st.state = "recording".into();
                        st.device = v["device"].as_str().map(str::to_string);
                        st.error = None;
                    }
                    Some("error") => {
                        st.state = if v["permission"].as_bool() == Some(true) {
                            "permission_missing".into()
                        } else {
                            "error".into()
                        };
                        st.error = v["error"].as_str().map(str::to_string);
                    }
                    _ => {}
                }
            }
        })?;
    Ok(Running {
        spec: spec.clone(),
        child,
        rx,
        events,
    })
}

fn stop_source(r: &mut Running) {
    let _ = r.child.kill();
    let _ = r.child.wait();
}

// --------------------------------------------------------------------- mixer

/// Places every source's blocks on the wall clock and sums them. A block is
/// assumed to end when it arrives; a source's following blocks continue
/// sample-exact until it drifts more than [`RESYNC_MS`] from the wall clock.
/// A block that starts more than [`GAP_MS`] after everything buffered (sleep,
/// a long stall) closes the buffered run and starts a new one, so a gap never
/// becomes hours of silence.
#[derive(Default)]
pub struct Mixer {
    /// Absolute sample index (16 kHz since the epoch) of `buf[0]`; everything
    /// before it is committed.
    origin: Option<i64>,
    buf: VecDeque<i32>,
    /// Runs closed by a gap, waiting to be taken.
    closed: Vec<(i64, Vec<i16>)>,
    next: BTreeMap<&'static str, i64>,
    last_data_ms: BTreeMap<&'static str, i64>,
}

fn clip(v: i32) -> i16 {
    v.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

impl Mixer {
    pub fn push(&mut self, src: &'static str, at_ms: i64, samples: &[i16]) {
        if samples.is_empty() {
            return;
        }
        let len = samples.len() as i64;
        let ends_now = idx_of_ms(at_ms);
        let start = match self.next.get(src) {
            Some(&n) if (n + len - ends_now).abs() <= idx_of_ms(RESYNC_MS) => n,
            _ => ends_now - len,
        };
        self.next.insert(src, start + len);
        self.last_data_ms.insert(src, at_ms);
        let origin = *self.origin.get_or_insert(start);
        if start > origin + self.buf.len() as i64 + idx_of_ms(GAP_MS) {
            if !self.buf.is_empty() {
                self.closed
                    .push((origin, self.buf.drain(..).map(clip).collect()));
            }
            self.origin = Some(start);
        }
        let origin = self.origin.unwrap_or(start);
        // Samples before the commit point arrived too late.
        let skip = (origin - start).max(0) as usize;
        if skip >= samples.len() {
            return;
        }
        let first = (start + skip as i64 - origin) as usize;
        let end = first + samples.len() - skip;
        if self.buf.len() < end {
            self.buf.resize(end, 0);
        }
        for (i, s) in samples[skip..].iter().enumerate() {
            self.buf[first + i] += *s as i32;
        }
    }

    pub fn is_live(&self, src: &str, now_ms: i64) -> bool {
        self.last_data_ms
            .get(src)
            .is_some_and(|t| now_ms - *t <= LIVE_MS)
    }

    /// Sources that delivered since they (re)started.
    pub fn known(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.next.keys().copied()
    }

    /// Silence up to `upto` (absolute index) where no source wrote, but never
    /// more than [`LIVE_MS`] past the newest data: a stalled source ends the run.
    pub fn pad_to(&mut self, upto: i64) {
        let (Some(origin), Some(newest)) = (self.origin, self.last_data_ms.values().max()) else {
            return;
        };
        let upto = upto.min(idx_of_ms(newest + LIVE_MS));
        let want = (upto - origin).max(0) as usize;
        if self.buf.len() < want {
            self.buf.resize(want, 0);
        }
    }

    pub fn forget(&mut self, src: &'static str) {
        self.next.remove(src);
        self.last_data_ms.remove(src);
    }

    /// Commit the mixed samples before `upto` (absolute index): runs closed by a
    /// gap first, then the buffer. Each run is (index of its first sample,
    /// samples clipped to 16 bits). Holes inside the buffer are silence.
    pub fn take(&mut self, upto: i64) -> Vec<(i64, Vec<i16>)> {
        let mut out = std::mem::take(&mut self.closed);
        if let Some(origin) = self.origin {
            let n = (upto - origin).clamp(0, self.buf.len() as i64) as usize;
            if n > 0 {
                out.push((origin, self.buf.drain(..n).map(clip).collect()));
                self.origin = Some(origin + n as i64);
            }
        }
        out
    }

    /// Commit everything pending (turning off, shutdown).
    pub fn drain(&mut self) -> Vec<(i64, Vec<i16>)> {
        self.take(i64::MAX)
    }
}

// ----------------------------------------------------------------- segmenter

struct OpenSegment {
    start_idx: i64,
    next_idx: i64,
    file: std::fs::File,
    part: PathBuf,
    sources: BTreeSet<String>,
}

/// Writes committed samples into one staging file per wall-clock minute.
#[derive(Default)]
pub struct Segmenter {
    open: Option<OpenSegment>,
}

/// `<start_ms>_<source+source>.pcm` in `audio/staging/`.
fn staging_name(start_ms: i64, sources: &BTreeSet<String>) -> String {
    let s: Vec<&str> = sources.iter().map(String::as_str).collect();
    format!("{start_ms}_{}.pcm", s.join("+"))
}

/// Start time and sources from a staging file name.
pub fn parse_staging_name(name: &str) -> Option<(i64, Vec<String>)> {
    let stem = name.strip_suffix(".pcm")?;
    let (start, sources) = stem.split_once('_')?;
    Some((
        start.parse().ok()?,
        sources
            .split('+')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    ))
}

impl Segmenter {
    pub fn segment_start_ms(&self) -> Option<i64> {
        self.open.as_ref().map(|o| ms_of_idx(o.start_idx))
    }

    pub fn write(
        &mut self,
        paths: &MemoryPaths,
        mut start_idx: i64,
        mut samples: &[i16],
        sources: &BTreeSet<String>,
    ) -> Result<()> {
        if self.open.as_ref().is_some_and(|o| o.next_idx != start_idx) {
            self.close()?;
        }
        while !samples.is_empty() {
            if self.open.is_none() {
                std::fs::create_dir_all(paths.audio_staging_dir())?;
                let part = paths.audio_staging_dir().join(format!(
                    "{}.part",
                    staging_name(ms_of_idx(start_idx), sources)
                ));
                let file = std::fs::File::create(&part)
                    .with_context(|| format!("create {}", part.display()))?;
                self.open = Some(OpenSegment {
                    start_idx,
                    next_idx: start_idx,
                    file,
                    part,
                    sources: sources.clone(),
                });
            }
            let o = self.open.as_mut().expect("open segment");
            o.sources.extend(sources.iter().cloned());
            // The next wall-clock minute boundary ends this segment.
            let boundary = idx_of_ms((ms_of_idx(o.start_idx) / SEGMENT_MS + 1) * SEGMENT_MS);
            let room = (boundary - start_idx).max(1) as usize;
            let n = room.min(samples.len());
            let mut bytes = Vec::with_capacity(n * 2);
            for s in &samples[..n] {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            o.file.write_all(&bytes)?;
            o.next_idx = start_idx + n as i64;
            start_idx += n as i64;
            samples = &samples[n..];
            if start_idx >= boundary {
                self.close()?;
            }
        }
        Ok(())
    }

    /// Close the open segment: it becomes `<name>.pcm` for the finalizer, or
    /// is dropped when shorter than [`MIN_SEGMENT_MS`].
    pub fn close(&mut self) -> Result<()> {
        let Some(mut o) = self.open.take() else {
            return Ok(());
        };
        o.file.flush()?;
        drop(o.file);
        if ms_of_idx(o.next_idx - o.start_idx) < MIN_SEGMENT_MS {
            let _ = std::fs::remove_file(&o.part);
            return Ok(());
        }
        // The name carries every source that contributed.
        let done = o
            .part
            .with_file_name(staging_name(ms_of_idx(o.start_idx), &o.sources));
        std::fs::rename(&o.part, &done)?;
        Ok(())
    }
}

/// A crash leaves `.pcm.part` files: they hold valid PCM up to the crash.
pub fn recover_staging(paths: &MemoryPaths) {
    let Ok(rd) = std::fs::read_dir(paths.audio_staging_dir()) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("part") {
            let _ = std::fs::rename(&p, p.with_extension(""));
        }
    }
}

// ----------------------------------------------------------- capture thread

fn new_slot() -> Slot {
    Slot {
        run: None,
        next_start: Instant::now(),
        failures: 0,
        status: SourceStatus {
            state: "starting".into(),
            ..Default::default()
        },
        finished: false,
    }
}

/// Stop sources that are no longer wanted or whose arguments changed; start
/// wanted ones that are due; note exits and schedule restarts.
fn reconcile(
    slots: &mut BTreeMap<&'static str, Slot>,
    wanted: &[SourceSpec],
    mixer: &mut Mixer,
    exe: &mut Option<PathBuf>,
) {
    slots.retain(|name, slot| {
        let keep = wanted
            .iter()
            .any(|w| w.name == *name && slot.run.as_ref().is_none_or(|r| r.spec == *w));
        if !keep {
            if let Some(r) = slot.run.as_mut() {
                stop_source(r);
            }
            mixer.forget(name);
        }
        keep
    });
    for spec in wanted {
        let slot = slots.entry(spec.name).or_insert_with(new_slot);
        if let Some(r) = slot.run.as_mut() {
            if let Ok(Some(exit)) = r.child.try_wait() {
                // Keep what it wrote before it exited.
                while let Ok(b) = r.rx.try_recv() {
                    mixer.push(spec.name, b.at_ms, &b.samples);
                }
                let ev = r.events.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let code = exit.code();
                slot.run = None;
                mixer.forget(spec.name);
                match restart_delay(code, slot.failures) {
                    None => {
                        slot.finished = true;
                        slot.status.state = "finished".into();
                    }
                    Some(d) => {
                        if code != Some(3) {
                            slot.failures += 1;
                        }
                        slot.next_start = Instant::now() + d;
                        slot.status = SourceStatus {
                            state: if code == Some(2) {
                                "permission_missing"
                            } else {
                                "restarting"
                            }
                            .into(),
                            device: ev.device,
                            error: ev
                                .error
                                .or_else(|| Some(format!("audio source exited ({exit})"))),
                        };
                        if code == Some(3) {
                            tracing::info!(
                                source = spec.name,
                                "audio device changed; restarting the source"
                            );
                        } else {
                            tracing::warn!(source = spec.name, code = ?code, "audio source stopped: {:?}", slot.status.error);
                        }
                    }
                }
            }
        }
        if slot.run.is_none() && !slot.finished && Instant::now() >= slot.next_start {
            if exe.is_none() {
                *exe = engine::locate();
            }
            match exe.as_deref().map(|e| spawn_source(e, spec)) {
                Some(Ok(r)) => slot.run = Some(r),
                Some(Err(err)) => {
                    slot.failures += 1;
                    slot.next_start =
                        Instant::now() + restart_delay(Some(1), slot.failures).unwrap_or_default();
                    slot.status.state = "error".into();
                    slot.status.error = Some(format!("{err:#}"));
                }
                None => {
                    slot.next_start = Instant::now() + Duration::from_secs(30);
                    slot.status.state = "error".into();
                    slot.status.error = Some(format!("{} not found", engine::ENGINE_NAME));
                }
            }
        }
    }
}

/// The state the tray and the window show.
fn overall_state(gated: Option<&str>, sources: &BTreeMap<String, SourceStatus>) -> String {
    if let Some(g) = gated {
        return g.to_string();
    }
    let all = |st: &str| !sources.is_empty() && sources.values().all(|s| s.state == st);
    let any = |st: &str| sources.values().any(|s| s.state == st);
    if any("recording") || any("silent") {
        "recording"
    } else if all("permission_missing") {
        "permission_missing"
    } else if all("finished") {
        "finished"
    } else if any("error") || any("restarting") {
        "error"
    } else {
        "starting"
    }
    .into()
}

/// The `memory-audio` thread.
pub fn run(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let test_wav = std::env::var(TEST_WAV_ENV).ok();
    recover_staging(&paths);
    let mut slots: BTreeMap<&'static str, Slot> = BTreeMap::new();
    let mut mixer = Mixer::default();
    let mut seg = Segmenter::default();
    let mut status = AudioStatus::default();
    let mut settings = Settings::effective(&paths);
    let mut settings_mtime = None;
    let mut recorder: Option<RecorderStatus> = None;
    let mut slow_at = Instant::now() - Duration::from_secs(10);
    let mut exe: Option<PathBuf> = None;
    let mut written: Option<(AudioStatus, Instant)> = None;
    while !stop.load(Ordering::SeqCst) {
        let tick = Instant::now();
        // Settings and policy hot-reload: an mtime check every tick, so "off" lands within ~100 ms.
        let stamp = |p: PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let mtime = Some((stamp(paths.settings()), stamp(super::policy::path(&paths))));
        if mtime != settings_mtime {
            settings_mtime = mtime;
            settings = Settings::effective(&paths);
        }
        if slow_at.elapsed() >= Duration::from_secs(1) {
            slow_at = Instant::now();
            recorder = RecorderStatus::read(&paths);
        }
        let gated = gate(&settings, recorder.as_ref(), now_ms());
        let wanted = match gated {
            Some(_) => Vec::new(),
            None => wanted_sources(&settings, test_wav.as_deref()),
        };
        reconcile(&mut slots, &wanted, &mut mixer, &mut exe);

        // Pull blocks into the mixer.
        for (name, slot) in slots.iter_mut() {
            let Some(r) = slot.run.as_mut() else { continue };
            while let Ok(b) = r.rx.try_recv() {
                mixer.push(name, b.at_ms, &b.samples);
                slot.failures = 0;
            }
            let ev = r.events.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let live = mixer.is_live(name, now_ms());
            slot.status = SourceStatus {
                state: if live {
                    "recording".into()
                } else if ev.state == "recording" {
                    "silent".into()
                } else {
                    ev.state.clone()
                },
                device: ev.device,
                error: ev.error,
            };
        }

        // Commit. While a source runs, missing samples up to the commit point are
        // silence; without one, what is pending is the end of the segment.
        let now = now_ms();
        let sources: BTreeSet<String> = mixer.known().map(str::to_string).collect();
        let running = slots.values().any(|s| s.run.is_some()) && !sources.is_empty();
        let names = if sources.is_empty() {
            slots.keys().map(|n| n.to_string()).collect()
        } else {
            sources
        };
        let committed = if running {
            let upto = idx_of_ms(now - LATENCY_MS);
            mixer.pad_to(upto);
            mixer.take(upto)
        } else {
            mixer.drain()
        };
        for (start, samples) in committed {
            match seg.write(&paths, start, &samples, &names) {
                Ok(()) => {
                    status.last_audio_ms = Some(ms_of_idx(start + samples.len() as i64));
                    status.last_error = None;
                }
                Err(err) => {
                    status.last_error = Some(format!("{err:#}"));
                    tracing::warn!("audio segment write failed: {err:#}");
                }
            }
        }
        let quiet_ms = status.last_audio_ms.map_or(i64::MAX, |t| now - t);
        if !running || quiet_ms > LIVE_MS + LATENCY_MS + 500 {
            if let Err(err) = seg.close() {
                tracing::warn!("audio segment close failed: {err:#}");
            }
        }

        // Status for the tray, the CLI and the window.
        status.sources = slots
            .iter()
            .map(|(n, s)| (n.to_string(), s.status.clone()))
            .collect();
        status.segment_start_ms = seg.segment_start_ms();
        status.state = overall_state(gated, &status.sources);
        // Written when something a reader shows changed, else once a second.
        // A library that never turned audio on gets no audio.json either.
        let due = written.as_ref().is_none_or(|(w, at)| {
            at.elapsed() >= Duration::from_secs(1)
                || w.state != status.state
                || w.sources != status.sources
                || w.segment_start_ms != status.segment_start_ms
        });
        if due && (settings.audio.enabled || paths.audio_status().exists()) {
            status.updated_at_ms = now_ms();
            status.write(&paths);
            written = Some((status.clone(), Instant::now()));
        }
        let spent = tick.elapsed();
        if spent < TICK {
            std::thread::sleep(TICK - spent);
        }
    }
    for slot in slots.values_mut() {
        if let Some(r) = slot.run.as_mut() {
            stop_source(r);
        }
    }
    let names: BTreeSet<String> = slots.keys().map(|n| n.to_string()).collect();
    for (start, samples) in mixer.drain() {
        let _ = seg.write(&paths, start, &samples, &names);
    }
    let _ = seg.close();
    if paths.audio_status().exists() {
        status.state = "stopped".into();
        status.sources.clear();
        status.segment_start_ms = None;
        status.updated_at_ms = now_ms();
        status.write(&paths);
    }
    Ok(())
}

// --------------------------------------------------------------- finalizer

/// The `memory-audio-finalize` thread: encode closed segments, then transcribe.
pub fn finalize_loop(paths: MemoryPaths, stop: Arc<AtomicBool>) -> Result<()> {
    let conn = store::open(&paths)?;
    let mut engine: Option<Engine> = None;
    let mut backoff_until = Instant::now();
    loop {
        let stopping = stop.load(Ordering::SeqCst);
        if Instant::now() >= backoff_until || stopping {
            if engine.is_none() {
                engine = Engine::new().ok();
            }
            if let Some(e) = engine.as_mut() {
                let s = Settings::effective(&paths);
                if let Err(err) = finalize_pass(&conn, &paths, e, &s) {
                    tracing::warn!("audio finalize failed: {err:#}");
                    backoff_until = Instant::now() + Duration::from_secs(30);
                }
                if !stopping {
                    if let Err(err) = transcribe_pass(&conn, &paths, e, &s, &stop) {
                        tracing::warn!("audio transcription failed: {err:#}");
                    }
                }
            }
        }
        if stopping {
            break;
        }
        for _ in 0..4 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    Ok(())
}

/// Encode every closed staging file into `audio/<start_ms>.m4a` and insert its row.
pub fn finalize_pass(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
) -> Result<usize> {
    let Ok(rd) = std::fs::read_dir(paths.audio_staging_dir()) else {
        return Ok(0);
    };
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("pcm"))
        .collect();
    files.sort();
    let mut n = 0;
    for pcm in files {
        let name = pcm
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let Some((start_ms, sources)) = parse_staging_name(&name) else {
            tracing::warn!("audio: unexpected staging file {name}; removing it");
            let _ = std::fs::remove_file(&pcm);
            continue;
        };
        let bytes = std::fs::metadata(&pcm).map(|m| m.len()).unwrap_or(0) as i64;
        let duration_ms = ms_of_idx(bytes / 2);
        if duration_ms < MIN_SEGMENT_MS {
            let _ = std::fs::remove_file(&pcm);
            continue;
        }
        let out = paths.audio_dir().join(format!("{start_ms}.m4a"));
        let resp = engine.request(
            json!({"cmd": "encode_audio", "input": pcm.to_string_lossy(), "out": out.to_string_lossy(),
                   "sample_rate": RATE, "bitrate": BITRATE}),
            Duration::from_secs(60),
        )?;
        let out = resp
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or(out);
        let size = std::fs::metadata(&out)
            .map(|m| m.len() as i64)
            .context("encoded audio is missing")?;
        let rel = out
            .strip_prefix(paths.audio_dir())
            .unwrap_or(&out)
            .to_string_lossy()
            .into_owned();
        let transcribe = s.audio.transcribe;
        conn.execute(
            "INSERT INTO audio(start_ms, end_ms, path, size_bytes, sources, transcript_status, pii_redacted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                start_ms,
                start_ms + duration_ms,
                rel,
                size,
                sources.join(","),
                if transcribe { TRANSCRIPT_PENDING } else { TRANSCRIPT_NONE },
                (transcribe && s.privacy.redact_pii) as i64,
            ],
        )?;
        std::fs::remove_file(&pcm)?;
        n += 1;
    }
    Ok(n)
}

/// Transcribe pending segments on the device. Text goes through the same
/// redactor as screen text when `privacy.redact_pii` was on at capture time;
/// a required local model that is unavailable fails the segment closed (no text).
pub fn transcribe_pass(
    conn: &Connection,
    paths: &MemoryPaths,
    engine: &mut Engine,
    s: &Settings,
    stop: &AtomicBool,
) -> Result<usize> {
    let pending: Vec<(i64, i64, String, bool)> = conn
        .prepare(
            "SELECT id, start_ms, path, pii_redacted FROM audio
             WHERE transcript_status = ?1 AND status = 0 ORDER BY id LIMIT 20",
        )?
        .query_map([TRANSCRIPT_PENDING], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut done = 0;
    for (id, start_ms, rel, private) in pending {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let file = paths.audio_dir().join(&rel);
        let resp = engine.request(
            json!({"cmd": "transcribe", "path": file.to_string_lossy(), "allow_download": !s.airgap}),
            Duration::from_secs(300),
        );
        let result = resp.and_then(|r| {
            let lines = transcript_lines(&r, start_ms);
            if private {
                redact_lines(paths, s, lines)
            } else {
                Ok(lines)
            }
        });
        match result {
            Ok(lines) => {
                let tx = conn.unchecked_transaction()?;
                tx.execute("DELETE FROM audio_transcript WHERE audio = ?1", [id])?;
                for (a, b, text) in &lines {
                    tx.execute(
                        "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (?1, ?2, ?3, ?4)",
                        params![id, a, b, text],
                    )?;
                }
                tx.execute(
                    "UPDATE audio SET transcript_status = ?1, transcript_error = NULL WHERE id = ?2",
                    params![TRANSCRIPT_DONE, id],
                )?;
                tx.commit()?;
                done += 1;
            }
            Err(err) => {
                // Engine errors never quote the audio; keep the reason short.
                let msg: String = format!("{err:#}").chars().take(200).collect();
                conn.execute(
                    "UPDATE audio SET transcript_status = ?1, transcript_error = ?2 WHERE id = ?3",
                    params![TRANSCRIPT_FAILED, msg, id],
                )?;
            }
        }
    }
    Ok(done)
}

/// `(start_ms, end_ms, text)` in epoch ms from an engine `transcribe` reply.
pub fn transcript_lines(resp: &Value, start_ms: i64) -> Vec<(i64, i64, String)> {
    resp.get("segments")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|seg| {
                    let text = seg.get("text")?.as_str()?.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    let a = seg.get("start_ms").and_then(Value::as_i64).unwrap_or(0);
                    let b = seg.get("end_ms").and_then(Value::as_i64).unwrap_or(a);
                    Some((start_ms + a, start_ms + b.max(a), text))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn redact_lines(
    paths: &MemoryPaths,
    s: &Settings,
    lines: Vec<(i64, i64, String)>,
) -> Result<Vec<(i64, i64, String)>> {
    let mut model = if s.privacy.use_local_model {
        Some(super::privacy_model::shared(paths).map_err(|_| {
            anyhow::anyhow!("the local privacy model is not installed; transcript discarded")
        })?)
    } else {
        None
    };
    lines
        .into_iter()
        .map(|(a, b, text)| {
            let spans = match model.as_mut() {
                Some(m) => m.as_mut().expect("loaded").detect(&text).map_err(|_| {
                    anyhow::anyhow!("local privacy inference failed; transcript discarded")
                })?,
                None => Vec::new(),
            };
            Ok((a, b, redaction::redact_with_spans(&text, &spans).text))
        })
        .collect()
}

// ------------------------------------------------------------ library ops

/// Bytes of encoded segments and staged PCM.
pub fn usage_bytes(paths: &MemoryPaths) -> u64 {
    let dir = |d: PathBuf| -> u64 {
        std::fs::read_dir(d)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.metadata().ok())
                    .filter(|m| m.is_file())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0)
    };
    dir(paths.audio_dir()) + dir(paths.audio_staging_dir())
}

/// Remove the local file of segment `id`. An uploaded segment stays playable
/// from the cloud (status 3); otherwise it is gone (status 2). Transcripts stay.
pub fn delete_local(conn: &Connection, paths: &MemoryPaths, id: i64, rel: &str) -> Result<()> {
    let _ = std::fs::remove_file(paths.audio_dir().join(rel));
    conn.execute(
        "UPDATE audio SET status = CASE WHEN remote_key IS NOT NULL THEN 3 ELSE 2 END,
                          size_bytes = CASE WHEN remote_key IS NOT NULL THEN size_bytes ELSE 0 END
         WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// One segment for the timeline: where it plays from.
#[derive(Debug, Clone, Serialize)]
pub struct Segment {
    pub id: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: i64,
    pub path: String,
    pub sources: String,
}

pub fn segments(conn: &Connection, from: i64, to: i64) -> Result<Vec<Segment>> {
    let mut st = conn.prepare(
        "SELECT id, start_ms, end_ms, status, path, sources FROM audio
         WHERE end_ms >= ?1 AND start_ms <= ?2 AND status != 2 ORDER BY start_ms",
    )?;
    let rows = st.query_map([from, to], |r| {
        Ok(Segment {
            id: r.get(0)?,
            start_ms: r.get(1)?,
            end_ms: r.get(2)?,
            status: r.get(3)?,
            path: r.get(4)?,
            sources: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Local file of segment `id`: the library copy, or the playback cache after
/// downloading a remote-only segment. None when it is gone.
pub fn locate(conn: &Connection, paths: &MemoryPaths, id: i64) -> Result<Option<PathBuf>> {
    let row: Option<(String, i64)> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT path, status FROM audio WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let Some((rel, status)) = row else {
        return Ok(None);
    };
    if rel.contains("..") || Path::new(&rel).is_absolute() {
        anyhow::bail!("bad audio path");
    }
    let local = paths.audio_dir().join(&rel);
    if local.exists() {
        return Ok(Some(local));
    }
    if status == 3 {
        return super::sync::fetch_remote_audio(conn, paths, id);
    }
    Ok(None)
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, v: i16) -> Vec<i16> {
        vec![v; n]
    }

    #[test]
    fn mixer_sums_sources_on_the_wall_clock_and_keeps_a_source_contiguous() {
        let mut m = Mixer::default();
        let t0 = 1_800_000_000_000;
        // 100 ms blocks arriving with jitter stay sample-contiguous.
        m.push("microphone", t0 + 100, &tone(1600, 100));
        m.push("microphone", t0 + 230, &tone(1600, 100)); // 30 ms late
        m.push("system", t0 + 200, &tone(1600, 50));
        let runs = m.take(idx_of_ms(t0 + 200));
        let (start, s) = &runs[0];
        assert_eq!(*start, idx_of_ms(t0));
        assert_eq!(s.len(), 3200);
        assert_eq!(s[0], 100, "first block: microphone only");
        assert_eq!(s[1600], 150, "second 100 ms: microphone + system");
        // Clipping, not wrapping.
        let mut m = Mixer::default();
        m.push("a", t0 + 100, &tone(1600, 30_000));
        m.push("b", t0 + 100, &tone(1600, 30_000));
        assert_eq!(m.drain()[0].1[0], i16::MAX);
    }

    #[test]
    fn mixer_resyncs_a_drifting_source_and_restarts_after_a_gap() {
        let t0 = 1_800_000_000_000;
        let mut m = Mixer::default();
        m.push("a", t0 + 100, &tone(1600, 1));
        // The next block arrives 0.8 s later than its samples account for: re-anchored
        // at its arrival, and the hole between is silence.
        m.push("a", t0 + 1_000, &tone(1600, 2));
        let runs = m.drain();
        assert_eq!(runs.len(), 1);
        let (start, s) = &runs[0];
        assert_eq!(*start, idx_of_ms(t0));
        assert_eq!(s.len(), idx_of_ms(1_000) as usize);
        assert_eq!(s[s.len() - 1], 2);
        assert_eq!(s[idx_of_ms(500) as usize], 0);
        // A block an hour later (sleep) never becomes an hour of silence, even with
        // samples still buffered: the buffered run closes and a new one starts.
        m.push("a", t0 + 1_100, &tone(1600, 3));
        m.push("a", t0 + 3_600_000, &tone(1600, 4));
        let runs = m.drain();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].1.len(), 1600);
        assert_eq!(runs[1].0, idx_of_ms(t0 + 3_599_900));
        assert_eq!(runs[1].1, tone(1600, 4));
        // Late samples (before the commit point) are dropped.
        m.push("b", t0 + 3_599_950, &tone(1600, 9));
        assert!(m.drain().is_empty());
        // Padding stops 1.5 s after the newest data.
        let mut m = Mixer::default();
        m.push("a", t0 + 100, &tone(1600, 1));
        m.pad_to(idx_of_ms(t0 + 60_000));
        let runs = m.take(idx_of_ms(t0 + 60_000));
        assert_eq!(runs[0].1.len(), idx_of_ms(100 + LIVE_MS) as usize);
    }

    #[test]
    fn segments_split_at_minute_boundaries_gaps_and_stops() {
        let dir = std::env::temp_dir().join(format!("kcap-audio-seg-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        let mut seg = Segmenter::default();
        let src: BTreeSet<String> = ["microphone".to_string()].into();
        let minute = 1_800_000_000_000 / SEGMENT_MS * SEGMENT_MS;
        // 50 s .. 70 s: crosses a minute boundary.
        let start = idx_of_ms(minute + 50_000);
        seg.write(&paths, start, &tone(idx_of_ms(20_000) as usize, 7), &src)
            .unwrap();
        // A gap: the next write does not continue the previous one.
        seg.write(
            &paths,
            start + idx_of_ms(25_000),
            &tone(idx_of_ms(5_000) as usize, 7),
            &src,
        )
        .unwrap();
        seg.close().unwrap();
        // Too short to keep.
        seg.write(&paths, idx_of_ms(minute + 200_000), &tone(100, 7), &src)
            .unwrap();
        seg.close().unwrap();
        let mut names: Vec<(i64, u64)> = std::fs::read_dir(paths.audio_staging_dir())
            .unwrap()
            .flatten()
            .map(|e| {
                let n = e.file_name().into_string().unwrap();
                (
                    parse_staging_name(&n).unwrap().0,
                    e.metadata().unwrap().len(),
                )
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                (minute + 50_000, idx_of_ms(10_000) as u64 * 2),
                (minute + 60_000, idx_of_ms(10_000) as u64 * 2),
                (minute + 75_000, idx_of_ms(5_000) as u64 * 2),
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn staging_names_round_trip_and_crash_leftovers_recover() {
        let s: BTreeSet<String> = ["system".into(), "microphone".into()].into();
        let n = staging_name(42, &s);
        assert_eq!(n, "42_microphone+system.pcm");
        assert_eq!(
            parse_staging_name(&n),
            Some((42, vec!["microphone".into(), "system".into()]))
        );
        assert_eq!(parse_staging_name("x.pcm"), None);
        let dir = std::env::temp_dir().join(format!("kcap-audio-rec-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        std::fs::create_dir_all(paths.audio_staging_dir()).unwrap();
        std::fs::write(paths.audio_staging_dir().join("5_file.pcm.part"), [0u8; 4]).unwrap();
        recover_staging(&paths);
        assert!(paths.audio_staging_dir().join("5_file.pcm").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gate_follows_the_screen_recorder_but_not_inactivity() {
        let mut s = Settings::default();
        let now = 1_800_000_000_000;
        assert_eq!(gate(&s, None, now), Some("off"), "off by default");
        s.audio.enabled = true;
        assert_eq!(gate(&s, None, now), None);
        let rec = |state: &str| RecorderStatus {
            state: state.into(),
            updated_at_ms: now,
            ..Default::default()
        };
        assert_eq!(
            gate(&s, Some(&rec("inactive")), now),
            None,
            "listening without input still records"
        );
        assert_eq!(gate(&s, Some(&rec("excluded")), now), None);
        assert_eq!(gate(&s, Some(&rec("locked")), now), Some("locked"));
        assert_eq!(gate(&s, Some(&rec("low_disk")), now), Some("low_disk"));
        let mut stale = rec("locked");
        stale.updated_at_ms = now - 60_000;
        assert_eq!(
            gate(&s, Some(&stale), now),
            None,
            "a stale heartbeat does not gate"
        );
        s.paused_until_ms = Some(now + 1000);
        assert_eq!(gate(&s, None, now), Some("paused"));
        s.paused_until_ms = None;
        s.recording_enabled = false;
        assert_eq!(gate(&s, None, now), Some("off"));
    }

    #[test]
    fn sources_follow_the_settings_and_the_test_wav_replaces_them() {
        let mut s = Settings::default();
        s.audio.enabled = true;
        let names = |v: Vec<SourceSpec>| v.iter().map(|x| x.name).collect::<Vec<_>>();
        assert_eq!(names(wanted_sources(&s, None)), ["microphone", "system"]);
        s.audio.input_device = "dev-1".into();
        s.excluded_bundle_ids = vec!["com.example.a".into()];
        let w = wanted_sources(&s, None);
        assert!(w[0].args.ends_with(&["--device".into(), "dev-1".into()]));
        assert!(w[1].args.contains(&"--exclude".to_string()));
        assert!(w[1].args.iter().any(|a| a.contains("com.example.a")));
        s.audio.microphone = false;
        assert_eq!(names(wanted_sources(&s, None)), ["system"]);
        assert_eq!(names(wanted_sources(&s, Some("/tmp/x.wav"))), ["file"]);
        assert_eq!(
            restart_delay(Some(0), 0),
            None,
            "the file source plays once"
        );
        assert_eq!(
            restart_delay(Some(3), 4),
            Some(Duration::ZERO),
            "device change"
        );
        assert_eq!(restart_delay(Some(2), 0), Some(Duration::from_secs(30)));
        assert_eq!(restart_delay(Some(1), 0), Some(Duration::from_secs(2)));
        assert_eq!(restart_delay(None, 9), Some(Duration::from_secs(60)));
    }

    #[test]
    fn transcript_lines_are_absolute_and_skip_empty_text() {
        let r = json!({"segments": [
            {"start_ms": 0, "end_ms": 2940, "text": " The budget review. "},
            {"start_ms": 2940, "end_ms": 4980, "text": ""},
            {"start_ms": 3000, "text": "zebrafish"}
        ]});
        assert_eq!(
            transcript_lines(&r, 1_000),
            vec![
                (1_000, 3_940, "The budget review.".to_string()),
                (4_000, 4_000, "zebrafish".to_string())
            ]
        );
    }

    #[test]
    fn private_transcripts_are_masked_and_fail_closed_without_the_model() {
        let dir = std::env::temp_dir().join(format!("kcap-audio-pii-{}", uuid::Uuid::new_v4()));
        let paths = MemoryPaths::at(&dir);
        let mut s = Settings::default();
        s.privacy.redact_pii = true;
        s.privacy.use_local_model = false;
        let lines = vec![(
            1,
            2,
            "mail me at jordan@example.com or call 415-555-0134".to_string(),
        )];
        let masked = redact_lines(&paths, &s, lines.clone()).unwrap();
        assert_eq!(masked[0].2, "mail me at [email] or call [phone]");
        // The model is required but not installed: no text is kept.
        s.privacy.use_local_model = true;
        let err = redact_lines(&paths, &s, lines).unwrap_err();
        assert!(err.to_string().contains("transcript discarded"), "{err:#}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn transcripts_are_searchable_and_cascade_with_their_segment() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        store::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO audio(start_ms, end_ms, path) VALUES (0, 60000, '0.m4a')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO audio_transcript(audio, start_ms, end_ms, text) VALUES (1, 0, 2000, 'quarterly budgets reviewed')",
            [],
        )
        .unwrap();
        let hits = |q: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM audio_fts WHERE audio_fts MATCH ?1",
                [q],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(hits("budget"), 1, "porter stemming");
        conn.execute("DELETE FROM audio WHERE id = 1", []).unwrap();
        assert_eq!(
            hits("budget"),
            0,
            "deleting a segment removes its transcript from search"
        );
    }
}
