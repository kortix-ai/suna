import { channel } from "./config";
import { addCost, loadEpisode, saveEpisode } from "./episode";
import { synthBeat, type TtsProvider } from "./audio/tts";
import { episodeCast } from "./audio/voicecast";
import { usdEstimate } from "./audio/sound";
import { load, round, writeJson } from "./lib/io";
import { ep } from "./lib/paths";
import { Script } from "./schemas";
import { layoutTiming, type BeatClip } from "./timing";

/** Narrate every beat (only changed beats hit the API) and lock timing.json. */
export async function voice(slug: string, provider?: TtsProvider) {
  const p = ep(slug);
  const cfg = channel();
  const prov = provider ?? cfg.voice.provider;
  const script = load(Script, p.script);
  const cast = prov === "elevenlabs" ? episodeCast(slug) : undefined;
  const clips = new Map<string, BeatClip>();
  let newChars = 0;
  for (const beat of script.beats) {
    const a = await synthBeat(beat, p.narration, prov, cast);
    if (!a.cached) newChars += a.chars;
    clips.set(beat.id, { id: beat.id, file: a.file, duration: a.duration, words: a.words });
  }
  const timing = layoutTiming(script, clips, { provider: prov, defaultPause: cfg.voice.default_pause, tail: 1.5, relativeTo: p.root });
  writeJson(p.timing, timing);
  if (newChars > 0 && prov === "elevenlabs") {
    const state = loadEpisode(slug);
    addCost(state, { stage: "voice", provider: "elevenlabs", item: "narration", units: newChars, unit: "chars", usd: round(usdEstimate.tts(newChars), 2) });
    saveEpisode(state);
  }
  return { provider: prov, total: timing.total, beats: timing.beats.length, new_chars: newChars };
}
