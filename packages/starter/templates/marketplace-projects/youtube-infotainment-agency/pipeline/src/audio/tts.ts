import { existsSync } from "node:fs";
import { join } from "node:path";
import { channel } from "../config";
import { ffprobeDuration, hyperframes, run } from "../lib/exec";
import { ensureDir, readJson, round, sha256, writeJson } from "../lib/io";
import type { Beat, VoiceCast } from "../schemas";
import { stripTags, words } from "../script";
import { alignTranscript, charsToWords, estimateWords } from "./align";
import { elevenlabsPost } from "./elevenlabs";

export type TtsProvider = "elevenlabs" | "kokoro" | "stub";

export interface BeatAudio {
  file: string;
  duration: number;
  /** Word timings relative to the start of this beat's audio. */
  words: { w: string; start: number; end: number }[];
  chars: number;
  cached: boolean;
}

/**
 * Generate (or reuse) narration for one beat. Cached by a hash of provider + settings + text; for ElevenLabs
 * the settings include the episode's cast (voice + model), so a re-cast re-generates.
 */
export async function synthBeat(beat: Beat, dir: string, provider: TtsProvider, cast?: VoiceCast): Promise<BeatAudio> {
  ensureDir(dir);
  const cfg = channel().voice;
  if (provider === "elevenlabs" && !cast) throw new Error("ElevenLabs narration needs the episode's cast (yt cast library <slug>)");
  const settings =
    provider === "elevenlabs" ? { ...cfg.elevenlabs, voice_id: cast!.voice_id, model_id: cast!.model_id } : provider === "kokoro" ? cfg.kokoro : { wpm: cfg.wpm };
  const key = sha256(JSON.stringify({ provider, settings, text: beat.narration }));
  const wav = join(dir, `${beat.id}.wav`);
  const meta = join(dir, `${beat.id}.json`);
  if (existsSync(wav) && existsSync(meta)) {
    const m = readJson<BeatAudio & { key: string }>(meta);
    if (m.key === key) return { ...m, cached: true };
  }
  const result =
    provider === "elevenlabs" ? await elevenlabs(beat, wav, cast!) : provider === "kokoro" ? await kokoro(beat, wav) : await stub(beat, wav);
  writeJson(meta, { ...result, key });
  return { ...result, cached: false };
}

async function elevenlabs(beat: Beat, wav: string, cast: VoiceCast): Promise<Omit<BeatAudio, "cached">> {
  const cfg = channel().voice.elevenlabs;
  const res = await elevenlabsPost(`/v1/text-to-speech/${cast.voice_id}/with-timestamps?output_format=mp3_44100_128`, {
    text: beat.narration,
    model_id: cast.model_id,
    voice_settings: { stability: cfg.stability, similarity_boost: cfg.similarity_boost, style: cfg.style, speed: cfg.speed },
  });
  const body = (await res.json()) as {
    audio_base64: string;
    alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  };
  const mp3 = wav.replace(/\.wav$/, ".mp3");
  await Bun.write(mp3, Buffer.from(body.audio_base64, "base64"));
  await toWav(mp3, wav);
  const duration = await ffprobeDuration(wav);
  const a = body.alignment;
  const w = a
    ? charsToWords(a.characters, a.character_start_times_seconds, a.character_end_times_seconds)
    : estimateWords(words(beat.narration), duration);
  return { file: wav, duration, words: w, chars: beat.narration.length };
}

async function kokoro(beat: Beat, wav: string): Promise<Omit<BeatAudio, "cached">> {
  const raw = wav.replace(/\.wav$/, ".kokoro.wav");
  await run([...hyperframes(), "tts", stripTags(beat.narration), "-v", channel().voice.kokoro.voice, "-o", raw]);
  await toWav(raw, wav);
  const duration = await ffprobeDuration(wav);
  // Kokoro gives no alignment: transcribe with the local whisper (via HyperFrames) and map the ASR
  // timings back onto the script's words; fall back to an estimate if transcription is unavailable.
  const tokens = words(beat.narration);
  const dir = wav.replace(/\.wav$/, ".asr");
  ensureDir(dir);
  const res = await run([...hyperframes(), "transcribe", wav, "--json", "-d", dir, "-m", "base.en"], { allowFail: true });
  const transcript = join(dir, "transcript.json");
  const w = res.code === 0 && existsSync(transcript)
    ? alignTranscript(tokens, readJson<{ text: string; start: number; end: number }[]>(transcript), duration)
    : estimateWords(tokens, duration);
  return { file: wav, duration, words: w, chars: beat.narration.length };
}

/**
 * Offline stand-in for a voice: one voiced blip per word at the channel's words-per-minute, so timing,
 * captions, ducking and loudness are all exercised without any API key.
 */
async function stub(beat: Beat, wav: string): Promise<Omit<BeatAudio, "cached">> {
  const tokens = words(beat.narration);
  const per = 60 / channel().voice.wpm;
  const duration = round(Math.max(1, tokens.length) * per, 3);
  const expr = `0.35*sin(2*PI*(165+25*sin(2*PI*2.5*t))*t)*lt(mod(t\\,${per})\\,${per * 0.82})`;
  await run([
    "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=${expr}:s=48000:d=${duration}`,
    "-ac", "1", "-c:a", "pcm_s16le", wav,
  ]);
  const w = tokens.map((t, i) => ({ w: t, start: round(i * per), end: round(i * per + per * 0.82) }));
  return { file: wav, duration, words: w, chars: beat.narration.length };
}

export async function toWav(input: string, wav: string) {
  await run(["ffmpeg", "-y", "-v", "error", "-i", input, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
}

export function narrationChars(beats: Beat[]): number {
  return beats.reduce((a, b) => a + b.narration.length, 0);
}

