#!/usr/bin/env python3
"""
The film soundtrack: a synthesized score on the film's bar grid, plus sound
effects placed on the film's cue frames. Deterministic: same input, same WAV.

  python3 soundtrack.py fetch-sfx              # once: ElevenLabs sound effects -> sfx/
  python3 soundtrack.py mix <film.json> <out.wav>   # {cues, score} written by render.ts

Needs numpy, scipy, and ffmpeg on PATH. `fetch-sfx` reads ELEVENLABS_API_KEY.
The score is synthesized because the ElevenLabs Music API needs a paid plan
(402 paid_plan_required on the free key); sound effects work on the free plan.

Grid (must match engine/time.ts): 120 BPM, 4/4, one bar = 2 s = 120 frames at 60 fps.
Each film declares its own section map (FilmDef.score); see
.agents/skills/kortix-presentation/references/films.md.
"""

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sawtooth, sosfilt

SR = 48000
BPM = 120
BEAT = 60 / BPM
BAR = BEAT * 4
FPS = 60
HERE = Path(__file__).parent
SFX_DIR = HERE / "sfx"
rng = np.random.default_rng(7)

SFX_PROMPTS = {
    "tick": ("a single soft minimal UI tick, clean digital click, very short, dry", 0.5),
    "click": ("a crisp quiet mouse button click, close-mic, very short, dry", 0.5),
    "typing": ("fast typing on a quiet low-profile keyboard, clean, dry", 2.0),
    "whoosh": ("a soft airy cinematic whoosh transition, short, modern and clean", 1.0),
    "impact": ("deep cinematic sub-bass impact hit with a short dark tail, modern", 2.5),
    "chime": ("a gentle bright success chime, two soft rising notes, minimal modern UI", 1.5),
}

# ── helpers ──────────────────────────────────────────────────────────────


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def t_of(n):
    return np.arange(n) / SR


def lowpass(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, "low", fs=SR, output="sos"), x)


def highpass(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, "high", fs=SR, output="sos"), x)


def adsr(n, a, d, s, r):
    """Attack/decay/sustain/release envelope over n samples (times in seconds)."""
    env = np.full(n, s, dtype=float)
    ai, di, ri = int(a * SR), int(d * SR), int(r * SR)
    ai = min(ai, n)
    env[:ai] = np.linspace(0, 1, ai, endpoint=False)
    de = min(ai + di, n)
    env[ai:de] = np.linspace(1, s, de - ai, endpoint=False)
    if ri:
        env[max(0, n - ri):] *= np.linspace(1, 0, min(ri, n))
    return env


def place(buf, sig, at_s, gain=1.0):
    """Add a mono or stereo signal into the stereo buffer at a time in seconds."""
    i = int(round(at_s * SR))
    if i >= len(buf):
        return
    if sig.ndim == 1:
        sig = np.stack([sig, sig], axis=1)
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[: end - i] * gain


# ── instruments ──────────────────────────────────────────────────────────


def supersaw(midi, dur, cutoff=1800, spread=0.12):
    n = int(dur * SR)
    t = t_of(n)
    out = np.zeros((n, 2))
    for k, cents in enumerate((-12, -6, 0, 6, 12)):
        f = hz(midi) * 2 ** (cents * spread / 12 / 10)
        v = sawtooth(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
        pan = 0.5 + (k - 2) * 0.2
        out[:, 0] += v * (1 - pan)
        out[:, 1] += v * pan
    out = np.stack([lowpass(out[:, 0], cutoff), lowpass(out[:, 1], cutoff)], axis=1)
    return out / 5


def pad(chord, dur, cutoff=1800):
    env = adsr(int(dur * SR), 0.35, 0.4, 0.8, 0.6)[:, None]
    return sum(supersaw(m, dur, cutoff) for m in chord) * env / len(chord)


def kick():
    n = int(0.45 * SR)
    t = t_of(n)
    f = 45 + 110 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    click = highpass(rng.standard_normal(n), 3000) * np.exp(-t / 0.004) * 0.25
    return np.tanh((body + click) * 1.6) * 0.9


def hat(open_=False):
    n = int((0.18 if open_ else 0.06) * SR)
    t = t_of(n)
    return highpass(rng.standard_normal(n), 7500, 4) * np.exp(-t / (0.06 if open_ else 0.018)) * 0.22


def clap():
    n = int(0.3 * SR)
    t = t_of(n)
    noise = sosfilt(butter(2, [900, 2600], "band", fs=SR, output="sos"), rng.standard_normal(n))
    env = sum(np.exp(-np.clip(t - d, 0, None) / 0.012) * (t >= d) for d in (0, 0.011, 0.022))
    env += 0.5 * np.exp(-np.clip(t - 0.03, 0, None) / 0.09) * (t >= 0.03)
    return noise * env * 0.3


def pluck(midi, dur=0.22, cutoff=2600):
    n = int(dur * SR)
    t = t_of(n)
    v = sawtooth(2 * np.pi * hz(midi) * t) * 0.6 + np.sign(np.sin(2 * np.pi * hz(midi) * 2 * t)) * 0.2
    return lowpass(v, cutoff) * np.exp(-t / 0.09)


def bass(midi, dur):
    n = int(dur * SR)
    t = t_of(n)
    v = sawtooth(2 * np.pi * hz(midi) * t) * 0.5 + np.sin(2 * np.pi * hz(midi - 12) * t) * 0.8
    return lowpass(v, 420) * adsr(n, 0.005, 0.12, 0.6, 0.04)


def riser(dur):
    n = int(dur * SR)
    t = t_of(n)
    p = t / dur
    noise = rng.standard_normal(n)
    # a sweeping band of noise plus a rising tone, both swelling toward the hit
    swept = np.concatenate([lowpass(c, 300 + 9000 * (i / 32) ** 2) for i, c in enumerate(np.array_split(noise, 32))])
    tone = np.sin(2 * np.pi * np.cumsum(220 + 660 * p**2) / SR) * 0.3
    return (swept * 0.5 + tone) * p**2.2 * 0.5


def impact():
    n = int(2.8 * SR)
    t = t_of(n)
    boom = np.sin(2 * np.pi * np.cumsum(38 + 60 * np.exp(-t / 0.08)) / SR) * np.exp(-t / 0.7)
    air = lowpass(rng.standard_normal(n), 1200) * np.exp(-t / 0.25) * 0.3
    return np.tanh((boom + air) * 1.4)


def reverb(x, seconds=2.4, mix=0.22):
    n = int(seconds * SR)
    t = t_of(n)
    ir = np.stack([lowpass(rng.standard_normal(n), 5000) * np.exp(-t / (seconds / 5)) for _ in (0, 1)], axis=1)
    ir /= np.abs(ir).sum(axis=0) ** 0.5 * 12
    wet = np.stack([fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in (0, 1)], axis=1)
    return x * (1 - mix) + wet * mix * 4


# ── the score ────────────────────────────────────────────────────────────

AM = ([57, 60, 64], 45)
F = ([53, 57, 60], 41)
C = ([55, 60, 64], 48)
G = ([55, 59, 62], 43)
CYCLE = [AM, F, C, G]


class Score:
    """A film's score, read from its `score` block (FilmDef.score in the film engine).

    sections: [[start_bar, kind], ...], kinds intro | reveal | groove | break | lift | end.
    cycle_from: the bar the Am–F–C–G cycle starts on. risers: [[bar, seconds]] swell INTO the bar.
    impacts: [[bar, gain]] hit ON the bar. Layers are placed relative to the first groove bar:
    hats from +6 bars, claps and the octave-up arpeggio from +12.
    """

    def __init__(self, spec):
        self.bars = spec["bars"]
        self.length = self.bars * BAR
        self.sections = sorted(spec["sections"])
        self.cycle_from = spec["cycle_from"]
        self.risers = spec.get("risers", [])
        self.impacts = spec.get("impacts", [])
        starts = {kind: b for b, kind in reversed(self.sections)}
        self.groove = starts.get("groove", 0)
        self.break_at = starts.get("break", self.bars)
        self.end_at = starts.get("end", self.bars)
        reveal = [b for b, kind in self.sections if kind == "reveal"]
        # the reveal's last bar already carries the kick and the arpeggio
        self.reveal_last = self.groove - 1 if reveal else -1

    def section(self, b):
        kind = self.sections[0][1]
        for start, k in self.sections:
            if b >= start:
                kind = k
        return kind

    def chord(self, b):
        sec = self.section(b)
        if sec == "end":
            # F, G, then home: the last bar always resolves to Am
            return AM if b == self.bars - 1 else [F, G][min(1, b - self.end_at)]
        if b < self.cycle_from:
            return AM
        return CYCLE[(b - self.cycle_from) % 4]


def score(sc):
    n = int((sc.length + 3) * SR)
    music = np.zeros((n, 2))
    drums = np.zeros((n, 2))
    duck = np.ones(n)
    arp_bus = np.zeros((n, 2))

    for b in range(sc.bars):
        s0 = b * BAR
        notes, root = sc.chord(b)
        sec = sc.section(b)

        # pad — darker in the intro and the break, open in the groove
        cutoff = {"intro": 900, "reveal": 1600, "groove": 2000, "break": 1100, "lift": 2400, "end": 1800}[sec]
        hold = BAR * (3 if b == sc.bars - 1 else 1) + 0.6
        place(music, pad(notes, hold, cutoff), s0, {"intro": 0.5, "break": 1.7, "end": 1.9}.get(sec, 0.8))

        if sec in ("groove", "lift") or b == sc.reveal_last:
            for q in range(4):
                place(drums, kick(), s0 + q * BEAT, 0.9)
                i = int((s0 + q * BEAT) * SR)
                env = 1 - 0.55 * np.exp(-t_of(int(BEAT * SR)) / 0.11)
                duck[i : i + len(env)] = np.minimum(duck[i : i + len(env)], env[: len(duck) - i])
            for e in range(8):
                place(music, bass(root, BEAT / 2 * 0.9), s0 + e * BEAT / 2, 0.4)
        if (sec == "groove" and b >= sc.groove + 6) or sec == "lift":
            for e in range(8):
                place(drums, hat(open_=e % 2 == 1), s0 + e * BEAT / 2, 0.8)
        if (sec == "groove" and b >= sc.groove + 12) or sec == "lift":
            for q in (1, 3):
                place(drums, clap(), s0 + q * BEAT, 0.8)
        if sec in ("break", "end"):
            place(music, lowpass(np.sin(2 * np.pi * hz(root - 12) * t_of(int(BAR * SR))), 200) * adsr(int(BAR * SR), 0.2, 0.2, 1, 0.3), s0, 0.35)
        if sec == "intro":
            place(drums, kick() * 0.5, s0, 0.5)  # a heartbeat on the one

        # arpeggio: 16ths over chord tones; an octave up once the groove is 12 bars in
        if sec in ("groove", "lift", "break") or b == sc.reveal_last:
            tones = notes + [notes[0] + 12]
            pattern = [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 2, 3, 2, 1]
            up = 12 if (b >= sc.groove + 12 and sec != "break") else 0
            cut = 1400 + (b - sc.break_at) * 900 if sec == "break" else 2600
            for i, p in enumerate(pattern):
                place(arp_bus, pluck(tones[p] + 12 + up, cutoff=max(700, cut)), s0 + i * BEAT / 4, 0.16)

    # dotted-eighth delay on the arpeggio
    d = int(BEAT * 0.75 * SR)
    for tap, g in ((1, 0.35), (2, 0.18)):
        arp_bus[d * tap :] += arp_bus[: -d * tap] * g
    music += arp_bus

    for target, dur in sc.risers:
        place(music, riser(dur), target * BAR - dur, 0.6)
    for target, g in sc.impacts:
        place(drums, impact(), target * BAR, g)

    music *= duck[:, None]
    mixed = reverb(music, mix=0.25) + drums

    # end: fade across the last bar so the film closes on the tail
    fade_from, fade_to = int((sc.length - 2.2) * SR), int((sc.length - 0.1) * SR)
    mixed[fade_from:fade_to] *= np.linspace(1, 0, fade_to - fade_from)[:, None] ** 1.5
    mixed[fade_to:] = 0
    return mixed[: int(sc.length * SR)]


# ── sound effects ────────────────────────────────────────────────────────


def fetch_sfx():
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("ELEVENLABS_API_KEY is not set")
    SFX_DIR.mkdir(exist_ok=True)
    for name, (text, seconds) in SFX_PROMPTS.items():
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/sound-generation",
            data=json.dumps({"text": text, "duration_seconds": seconds, "prompt_influence": 0.6}).encode(),
            headers={"xi-api-key": key, "content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as res:
            (SFX_DIR / f"{name}.mp3").write_bytes(res.read())
        print(f"sfx/{name}.mp3")


def load_audio(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(float)


def mix(meta_path, out_path):
    meta = json.loads(Path(meta_path).read_text())
    cues = meta["cues"]
    out = score(Score(meta["score"]))
    cache = {}
    for cue in cues:
        name = cue["sfx"]
        if name not in cache:
            cache[name] = load_audio(SFX_DIR / f"{name}.mp3")
            cache[name] /= max(1e-9, np.abs(cache[name]).max())
        place(out, cache[name], cue["frame"] / FPS, 0.5 * cue.get("gain", 1))

    out = np.tanh(out * 1.1)
    out /= np.abs(out).max() / 0.95
    tmp = Path(out_path).with_suffix(".raw.wav")
    from scipy.io import wavfile

    wavfile.write(tmp, SR, (out * 32767).astype(np.int16))
    # streaming loudness target, true-peak safe
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), str(out_path)],
        check=True,
    )
    tmp.unlink()
    print(out_path)


if __name__ == "__main__":
    if sys.argv[1:2] == ["fetch-sfx"]:
        fetch_sfx()
    elif sys.argv[1:2] == ["mix"] and len(sys.argv) == 4:
        mix(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
