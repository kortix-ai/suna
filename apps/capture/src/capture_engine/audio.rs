//! Audio memory in the Windows/Linux engine. Same contract as the Swift engine:
//!
//! - `kortix-capture-engine audio --source microphone|system|file [--device ID] [--path WAV]`
//!   writes raw PCM (16 kHz, mono, s16le) to stdout and one JSON event per
//!   line to stderr. Exit codes: 0 the file ended, 1 error, 2 permission
//!   missing, 3 the default device changed (the recorder restarts at once).
//! - `encode_audio` (PCM -> AAC in M4A) and `audio_devices` requests.
//!
//! Linux records through PulseAudio (PipeWire's pulse server included) with
//! `parec`: the default source for the microphone, `@DEFAULT_MONITOR@` for
//! what the computer plays, and encodes with `ffmpeg`. Windows records with
//! WASAPI (cpal; loopback on the default output for system audio) and encodes
//! with Media Foundation (`win.rs`). This module's code is plain std and
//! compiles on every OS, so its tests run everywhere.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const RATE: u32 = 16_000;

pub fn event(v: Value) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{v}");
    let _ = err.flush();
}

/// Report and return the exit code the recorder understands.
pub fn fail(msg: &str, code: i32) -> i32 {
    event(json!({"event": "error", "error": msg, "permission": code == 2}));
    code
}

/// `--key value` pairs after `audio`.
pub fn options(args: &[String]) -> std::collections::HashMap<String, String> {
    args.chunks(2)
        .filter(|p| p.len() == 2)
        .map(|p| (p[0].clone(), p[1].clone()))
        .collect()
}

/// The `audio` subcommand: returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let o = options(args);
    let device = o.get("--device").map(String::as_str);
    match o.get("--source").map(String::as_str) {
        Some("file") => match o.get("--path") {
            Some(p) => match play_file(Path::new(p), &mut std::io::stdout().lock()) {
                Ok(()) => 0,
                Err(e) => fail(&format!("file_source: {e:#}"), 1),
            },
            None => fail("bad_request", 1),
        },
        Some(src @ ("microphone" | "system")) => super::os::audio_source(src, device),
        _ => fail("unknown_source", 1),
    }
}

// ---------------------------------------------------------------- PCM helpers

/// Mono f32 samples at `from` Hz -> `to` Hz (linear interpolation; speech
/// quality, and the recorder's 16 kHz target needs nothing better).
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let n = (input.len() as u64 * to as u64 / from as u64) as usize;
    let step = from as f64 / to as f64;
    (0..n)
        .map(|i| {
            let x = i as f64 * step;
            let a = x.floor() as usize;
            let b = (a + 1).min(input.len() - 1);
            let t = (x - a as f64) as f32;
            input[a] * (1.0 - t) + input[b] * t
        })
        .collect()
}

pub fn to_i16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Interleaved frames -> mono by averaging the channels.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect()
}

/// Streaming converter: any rate and channel count -> 16 kHz mono s16le,
/// keeping the fractional resampling position across blocks.
pub struct Converter {
    rate: u32,
    channels: usize,
    pos: f64,
    last: f32,
}

impl Converter {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self {
            rate,
            channels: channels.max(1),
            pos: 0.0,
            last: 0.0,
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) -> Vec<u8> {
        let mono = downmix(interleaved, self.channels);
        if self.rate == RATE {
            return to_i16_bytes(&mono);
        }
        let step = self.rate as f64 / RATE as f64;
        let mut out = Vec::new();
        // `pos` is relative to the sample before mono[0] (`last`).
        while self.pos < mono.len() as f64 {
            let a = self.pos.floor() as isize - 1;
            let t = (self.pos - self.pos.floor()) as f32;
            let s0 = if a < 0 { self.last } else { mono[a as usize] };
            let s1 = mono[(a + 1) as usize];
            out.push(s0 * (1.0 - t) + s1 * t);
            self.pos += step;
        }
        self.pos -= mono.len() as f64;
        if let Some(l) = mono.last() {
            self.last = *l;
        }
        to_i16_bytes(&out)
    }
}

// ------------------------------------------------------------------ WAV seam

pub struct Wav {
    pub rate: u32,
    pub channels: usize,
    /// Interleaved samples in [-1, 1].
    pub samples: Vec<f32>,
}

/// RIFF/WAVE with 16-bit PCM or 32-bit float data (the formats `afconvert`,
/// `sox` and `ffmpeg` write).
pub fn read_wav(bytes: &[u8]) -> Result<Wav> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("not a WAV file");
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at =
        |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut fmt: Option<(u16, usize, u32, u16)> = None;
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32_at(i + 4) as usize;
        let body = i + 8;
        let end = (body + len).min(bytes.len());
        if id == b"fmt " && len >= 16 {
            fmt = Some((
                u16_at(body),
                u16_at(body + 2) as usize,
                u32_at(body + 4),
                u16_at(body + 14),
            ));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = fmt.context("WAV data before fmt")?;
            let data = &bytes[body..end];
            // 0xFFFE (extensible) carries the real format in its subformat; 16-bit means PCM here.
            let samples = match (tag, bits) {
                (1 | 0xFFFE, 16) => data
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                    .collect(),
                (3 | 0xFFFE, 32) => data
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect(),
                _ => bail!("unsupported WAV format {tag} with {bits} bits"),
            };
            return Ok(Wav {
                rate,
                channels: channels.max(1),
                samples,
            });
        }
        i = body + len + (len & 1);
    }
    bail!("WAV has no data chunk")
}

/// Play a WAV once in real time: one 100 ms block when its last sample would be heard.
pub fn play_file(path: &Path, out: &mut impl Write) -> Result<()> {
    let wav = read_wav(&std::fs::read(path).with_context(|| format!("read {}", path.display()))?)?;
    event(json!({"event": "started", "source": "file",
                 "device": path.file_name().map(|n| n.to_string_lossy().into_owned())}));
    let mut conv = Converter::new(wav.rate, wav.channels);
    let block = (wav.rate as usize / 10) * wav.channels;
    let start = Instant::now();
    let mut played = 0f64;
    for chunk in wav.samples.chunks(block.max(1)) {
        played += chunk.len() as f64 / wav.channels as f64 / wav.rate as f64;
        let due = start + Duration::from_secs_f64(played);
        if let Some(wait) = due.checked_duration_since(Instant::now()) {
            std::thread::sleep(wait);
        }
        out.write_all(&conv.push(chunk))?;
        out.flush()?;
    }
    Ok(())
}

// ------------------------------------------------------------- Linux helpers

/// PCM (16 kHz mono s16le) -> AAC-LC in M4A with the `ffmpeg` CLI (Linux).
pub fn ffmpeg_encode_audio(input: &str, out: &str, rate: u32, bitrate: u32) -> Result<()> {
    let res = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-nostdin"])
        .args([
            "-f",
            "s16le",
            "-ar",
            &rate.to_string(),
            "-ac",
            "1",
            "-i",
            input,
        ])
        .args([
            "-c:a",
            "aac",
            "-b:a",
            &bitrate.to_string(),
            "-movflags",
            "+faststart",
            out,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow!("ffmpeg_unavailable: ffmpeg is not installed (apt install ffmpeg)")
            } else {
                anyhow!("ffmpeg: {e}")
            }
        })?;
    if !res.status.success() {
        bail!(
            "ffmpeg exited {}: {}",
            res.status,
            String::from_utf8_lossy(&res.stderr).trim()
        );
    }
    Ok(())
}

/// `pactl get-default-source|sink`, for following the default device.
pub fn pactl_default(what: &str) -> Option<String> {
    let out = Command::new("pactl")
        .arg(format!("get-default-{what}"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Record through PulseAudio (PipeWire included) with `parec`, copying its PCM
/// to stdout. Without a pinned device, a change of the default source (the
/// microphone) or sink (system audio: its monitor) exits 3.
pub fn parec_source(source: &str, device: Option<&str>) -> i32 {
    let (watch, dev) = match (source, device) {
        ("system", _) => ("sink", "@DEFAULT_MONITOR@".to_string()),
        (_, Some(d)) => ("", d.to_string()),
        _ => ("source", "@DEFAULT_SOURCE@".to_string()),
    };
    let mut child = match Command::new("parec")
        .args([
            "--raw",
            "--format=s16le",
            "--rate=16000",
            "--channels=1",
            "--latency-msec=100",
        ])
        .arg(format!("--device={dev}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return fail(
                "parec_unavailable: install pulseaudio-utils (PipeWire: pipewire-pulse)",
                1,
            )
        }
        Err(e) => return fail(&format!("parec: {e}"), 1),
    };
    let initial = (!watch.is_empty()).then(|| pactl_default(watch)).flatten();
    event(json!({"event": "started", "source": source,
                 "device": if source == "system" { initial.clone().map(|s| format!("{s} (monitor)")) } else { initial.clone().or(device.map(str::to_string)) }}));
    let mut pcm = child.stdout.take().expect("piped");
    let copier = std::thread::spawn(move || {
        let mut out = std::io::stdout().lock();
        let mut buf = [0u8; 3200];
        while let Ok(n) = pcm.read(&mut buf) {
            if n == 0 || out.write_all(&buf[..n]).and_then(|_| out.flush()).is_err() {
                break;
            }
        }
    });
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if copier.is_finished() {
            let status = child.wait().ok();
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            return fail(
                &format!(
                    "parec stopped ({status:?}): {}",
                    err.trim().chars().take(200).collect::<String>()
                ),
                1,
            );
        }
        if initial.is_some() && pactl_default(watch) != initial {
            let _ = child.kill();
            event(json!({"event": "device_changed"}));
            return 3;
        }
    }
}

/// `pactl list short sources`: one device per input (monitors of outputs left out).
pub fn pactl_devices() -> Result<Value> {
    let out = Command::new("pactl")
        .args(["list", "short", "sources"])
        .stdin(Stdio::null())
        .output()
        .context("pactl is not installed (pulseaudio-utils)")?;
    let default = pactl_default("source");
    let devices: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.split('\t').nth(1))
        .filter(|name| !name.ends_with(".monitor"))
        .map(|name| json!({"id": name, "name": name, "default": Some(name.to_string()) == default}))
        .collect();
    Ok(json!({"devices": devices, "default": default}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav16(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        b.extend_from_slice(&(channels * 2).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"LIST");
        b.extend_from_slice(&3u32.to_le_bytes());
        b.extend_from_slice(b"abc\0"); // odd chunk: padded
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        b
    }

    #[test]
    fn wav_reads_and_converts_to_16k_mono() {
        // 48 kHz stereo, 0.25 s: left 0.5, right -0.5 → mono 0.
        let n = 12_000;
        let frames: Vec<i16> = (0..n).flat_map(|_| [16384i16, -16384]).collect();
        let w = read_wav(&wav16(48_000, 2, &frames)).unwrap();
        assert_eq!((w.rate, w.channels, w.samples.len()), (48_000, 2, n * 2));
        let mut c = Converter::new(w.rate, w.channels);
        let mut out = Vec::new();
        for chunk in w.samples.chunks(9600) {
            out.extend(c.push(chunk));
        }
        assert_eq!(out.len() / 2, 4000, "0.25 s at 16 kHz, across blocks");
        assert!(out.iter().all(|b| *b == 0));
        assert!(read_wav(b"RIFF0000WAVEnope").is_err());
    }

    #[test]
    fn resampling_keeps_a_tone_and_its_length() {
        let tone: Vec<f32> = (0..44_100)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5)
            .collect();
        let r = resample(&tone, 44_100, 16_000);
        assert_eq!(r.len(), 16_000);
        let peak = r.iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((0.45..=0.5).contains(&peak), "peak {peak}");
    }

    #[test]
    fn options_parse_pairs() {
        let o = options(&[
            "--source".into(),
            "file".into(),
            "--path".into(),
            "/x.wav".into(),
        ]);
        assert_eq!(o["--source"], "file");
        assert_eq!(o["--path"], "/x.wav");
    }

    /// The Linux encoder, wherever ffmpeg is installed (skipped otherwise).
    #[test]
    fn ffmpeg_encodes_speech_pcm_to_small_aac() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            eprintln!("skipped: ffmpeg not installed");
            return;
        }
        let dir = std::env::temp_dir().join(format!("kce-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pcm = dir.join("in.pcm");
        let tone: Vec<f32> = (0..16_000 * 10)
            .map(|i| (i as f32 * 300.0 * std::f32::consts::TAU / 16_000.0).sin() * 0.3)
            .collect();
        std::fs::write(&pcm, to_i16_bytes(&tone)).unwrap();
        let out = dir.join("out.m4a");
        ffmpeg_encode_audio(pcm.to_str().unwrap(), out.to_str().unwrap(), RATE, 32_000).unwrap();
        let size = std::fs::metadata(&out).unwrap().len();
        // 10 s at 32 kbps is 40 KB; container overhead is small.
        assert!((20_000..60_000).contains(&size), "{size} bytes");
        let _ = std::fs::remove_dir_all(dir);
    }
}
