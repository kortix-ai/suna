import { existsSync } from "node:fs";
import { join } from "node:path";
import { channel } from "../config";
import { ffprobeDuration, run } from "../lib/exec";
import { ensureDir, readJson, round, sha256, writeJson } from "../lib/io";
import { elevenlabsPost } from "./elevenlabs";
import { toWav } from "./tts";

export type GenProvider = "elevenlabs" | "stub";

interface Cached {
  key: string;
  file: string;
  duration: number;
}

async function cached(dir: string, name: string, keyObj: unknown, make: (wav: string) => Promise<void>) {
  ensureDir(dir);
  const key = sha256(JSON.stringify(keyObj));
  const wav = join(dir, `${name}.wav`);
  const meta = join(dir, `${name}.json`);
  if (existsSync(wav) && existsSync(meta) && readJson<Cached>(meta).key === key) {
    return { file: wav, duration: readJson<Cached>(meta).duration, cached: true };
  }
  await make(wav);
  const duration = await ffprobeDuration(wav);
  writeJson(meta, { key, file: wav, duration } satisfies Cached);
  return { file: wav, duration, cached: false };
}

async function elevenlabsAudio(path: string, body: unknown, out: string) {
  const res = await elevenlabsPost(path, body, "audio/mpeg");
  const mp3 = out.replace(/\.wav$/, ".mp3");
  await Bun.write(mp3, await res.arrayBuffer());
  await toWav(mp3, out);
}

/** A music cue of `seconds` length. ElevenLabs Music accepts 10 s – 5 min per generation. */
export async function makeMusic(dir: string, name: string, prompt: string, seconds: number, provider: GenProvider) {
  if (seconds > 300) throw new Error(`music cue ${name} is ${seconds.toFixed(0)}s; split cues at act boundaries (max 300s)`);
  const ms = Math.round(Math.max(10, seconds + 2) * 1000);
  return cached(dir, name, { provider, prompt, ms }, async (wav) => {
    if (provider === "elevenlabs") {
      await elevenlabsAudio("/v1/music", { prompt, music_length_ms: ms, model_id: "music_v1" }, wav);
    } else {
      // Offline placeholder score: a gentle I–vi–IV–V pad (Cmaj7 Am7 Fmaj7 G6, 4 s per chord) with
      // soft attacks and an echo tail. Not a real score — enough to judge pacing and ducking.
      const d = ms / 1000;
      const chords = [[261.63, 329.63, 392.0, 493.88], [220.0, 261.63, 329.63, 392.0], [174.61, 220.0, 261.63, 329.63], [196.0, 246.94, 293.66, 329.63]];
      const sel = (i: number) => chords.map((c, k) => `eq(mod(floor(t/4)\\,4)\\,${k})*${c[i]}`).join("+");
      const env = "(0.55+0.45*sin(PI*mod(t\\,4)/4))";
      const voice = (i: number, amp: number) => `${amp}*sin(2*PI*(${sel(i)})*t)`;
      const expr = `(${voice(0, 0.07)}+${voice(1, 0.06)}+${voice(2, 0.05)}+${voice(3, 0.035)})*${env}`;
      await run([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=48000:d=${d}`,
        "-af", "lowpass=f=2400,aecho=0.8:0.6:120|240:0.25|0.15,afade=t=in:d=2", "-ac", "2", "-c:a", "pcm_s16le", wav,
      ]);
    }
  });
}

/** A sound effect (ElevenLabs sound generation, 0.5–22 s). */
export async function makeSfx(dir: string, name: string, prompt: string, seconds: number, provider: GenProvider) {
  const d = round(Math.min(22, Math.max(0.5, seconds)), 2);
  return cached(dir, name, { provider, prompt, d }, async (wav) => {
    if (provider === "elevenlabs") {
      await elevenlabsAudio("/v1/sound-generation", { text: prompt, duration_seconds: d, prompt_influence: 0.4 }, wav);
    } else if (/chime|bell|ding|ping|sparkle/i.test(prompt)) {
      // Placeholder chime: two decaying partials.
      const f = /bell/i.test(prompt) ? 330 : 880;
      await run([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=0.4*(sin(2*PI*${f}*t)+0.5*sin(2*PI*${f * 2.76}*t))*exp(-3.2*t):s=48000:d=${d}`,
        "-af", "aecho=0.8:0.5:60:0.3", "-ac", "2", "-c:a", "pcm_s16le", wav,
      ]);
    } else {
      await run([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `anoisesrc=d=${d}:c=pink:a=0.35`,
        "-af", `highpass=f=300,lowpass=f=4000,afade=t=in:d=${d * 0.4},afade=t=out:st=${d * 0.4}:d=${d * 0.6}`,
        "-ac", "2", "-c:a", "pcm_s16le", wav,
      ]);
    }
  });
}

export const usdEstimate = {
  tts: (chars: number) => (chars / 1000) * (channel().rates.elevenlabs_tts_per_1k_chars ?? 0.15),
  music: (seconds: number) => (seconds / 60) * (channel().rates.elevenlabs_music_per_minute ?? 0.8),
  sfx: (n: number) => n * (channel().rates.elevenlabs_sfx_per_generation ?? 0.08),
};
