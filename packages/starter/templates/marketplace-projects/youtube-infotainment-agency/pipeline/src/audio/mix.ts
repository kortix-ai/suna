import { channel } from "../config";
import { run } from "../lib/exec";

export interface Placed {
  file: string;
  at: number;
  volume?: number;
  /** Trim to this length (music cues). */
  duration?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** A normalised cue never peaks above this, however loud its measured loudness says it should be. */
const MUSIC_PEAK_CEILING_DB = -3;
/** Normalisation is a take-level correction, not a rescue: never move a take by more than this. */
const MAX_NORMALISE_DB = 24;

/**
 * Normalisation gain in dB for one placed clip, so a planned `volume` means the same thing from any
 * provider: generated takes arrive at wildly different levels (one ElevenLabs SFX prompt returned takes
 * from −42 to −12 dBFS peak; music cues land −18…−22 LUFS), and an unnormalised take silently disappears
 * from the mix. Music is matched by integrated loudness, SFX by true peak (punctuation is about transients).
 */
async function normaliseDb(file: string, kind: "music" | "sfx"): Promise<number> {
  const cfg = channel();
  const m = await measureLoudness(file);
  const lufs = Number(m.input_i);
  const tp = Number(m.input_tp);
  if (!Number.isFinite(tp)) return 0;
  let db: number;
  if (kind === "music") {
    if (!Number.isFinite(lufs)) return 0;
    db = Math.min(cfg.music.reference_lufs - lufs, MUSIC_PEAK_CEILING_DB - tp);
  } else {
    db = cfg.sfx.reference_peak_db - tp;
  }
  return Math.max(-MAX_NORMALISE_DB, Math.min(MAX_NORMALISE_DB, db));
}

/**
 * Mix narration, music and SFX into one stereo master:
 *   voice  — beats placed at their timing offsets (not normalised: the voice stage already locks its level)
 *   music  — cues normalised, trimmed + faded, then side-chain ducked under the voice
 *   sfx    — normalised to a reference peak, placed on their cues
 * then two-pass loudnorm to the channel target (YouTube normalises to about −14 LUFS).
 */
export async function mixMaster(opts: {
  voice: Placed[];
  music: Placed[];
  sfx: Placed[];
  total: number;
  out: string;
  workDir: string;
}): Promise<{ integrated: number; truePeak: number; normalised: { file: string; gain_db: number }[] }> {
  const { mix } = channel();
  const pre = `${opts.workDir}/premix.wav`;
  const inputs: string[] = [];
  const filters: string[] = [];
  const add = (p: Placed) => {
    inputs.push("-i", p.file);
    return inputs.length / 2 - 1;
  };
  const ms = (t: number) => Math.max(0, Math.round(t * 1000));

  const bus = (items: Placed[], label: string, shape: (p: Placed, i: number) => string, pad = false) => {
    if (items.length === 0) {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${opts.total}[${label}]`);
      return;
    }
    const tags = items.map((p) => {
      const i = add(p);
      const tag = `${label}${i}`;
      filters.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,${shape(p, i)},adelay=${ms(p.at)}|${ms(p.at)}[${tag}]`);
      return `[${tag}]`;
    });
    const shapeTail = pad ? `,apad,atrim=0:${opts.total}` : "";
    filters.push(`${tags.join("")}amix=inputs=${tags.length}:normalize=0:dropout_transition=0${shapeTail}[${label}]`);
  };

  // Take-level normalisation: measured once per file, applied inside each clip's gain filter.
  const normDb = new Map<string, number>();
  for (const p of opts.music) if (!normDb.has(p.file)) normDb.set(p.file, await normaliseDb(p.file, "music"));
  for (const p of opts.sfx) if (!normDb.has(p.file)) normDb.set(p.file, await normaliseDb(p.file, "sfx"));
  /** A clip's planned linear volume plus its take normalisation, as a dB gain for the filter graph. */
  const gainDb = (p: Placed, fallback: number) => {
    const planned = Math.max(1e-4, p.volume ?? fallback);
    return Math.max(-60, Math.min(24, 20 * Math.log10(planned) + (normDb.get(p.file) ?? 0)));
  };

  // The narration bus is padded to the film's length so it is the full timeline: sidechaincompress stops
  // with its shorter input, so an unpadded narration key silently truncated the score (and any music-only
  // tail) at the last narration sample. Pad the *bus* here, not the key: an apad/atrim on a sidechain key
  // branch livelocks ffmpeg's framesync (measured: the graph never exits, at 100 % CPU) where this is fast.
  bus(opts.voice, "voice", (p) => `volume=${p.volume ?? 1}`, true);
  // Music cues hand over with an equal-power crossfade (`mix.music_crossfade_s`), centred on the act seam:
  // each cue but the first starts half of it early and each cue but the last plays half of it long, so both
  // neighbours sit at −3 dB on the boundary and the sum stays constant. Without it every cue faded to nothing
  // before the next rose, and — because a generated cue's own resolution lands ~1 s inside its window — the
  // score vanished for ~0.5 s at each seam once it was loud enough to be heard.
  const xf = Math.max(0, mix.music_crossfade_s);
  const half = xf / 2;
  const musicOrder = [...opts.music].sort((a, b) => a.at - b.at);
  const musicItems = musicOrder.map((p, k) => ({ ...p, at: Math.max(0, p.at - (xf > 0 && k > 0 ? half : 0)) }));
  const musicPos = new Map(musicItems.map((p, k) => [p, k]));
  bus(musicItems, "musicraw", (p) => {
    const k = musicPos.get(p) ?? 0;
    const d = p.duration ?? 30;
    const first = k === 0;
    const last = k === musicItems.length - 1;
    const pre = xf > 0 && !first ? half : 0;
    const len = d + pre + (xf > 0 && !last ? half : 0);
    const fadeIn = xf > 0 && !first ? `afade=t=in:d=${xf}:curve=qsin` : `afade=t=in:d=${p.fadeIn ?? 1.5}`;
    const fadeOut =
      xf > 0 && !last
        ? `afade=t=out:st=${d + pre - half}:d=${xf}:curve=qsin`
        : `afade=t=out:st=${Math.max(0, len - Math.min(p.fadeOut ?? 2.5, d / 2))}:d=${Math.min(p.fadeOut ?? 2.5, d / 2)}`;
    return `atrim=0:${len},${fadeIn},${fadeOut},volume=${gainDb(p, channel().music.default_volume).toFixed(2)}dB`;
  });
  bus(opts.sfx, "sfx", (p) => `volume=${gainDb(p, 0.8).toFixed(2)}dB`);

  filters.push(`[voice]asplit=2[vmain][vkey]`);
  const duckThreshold = Math.pow(10, mix.duck_threshold_db / 20);
  filters.push(
    `[musicraw][vkey]sidechaincompress=threshold=${duckThreshold.toFixed(5)}:ratio=${Math.max(2, channel().music.duck_db)}:attack=15:release=${mix.duck_release_ms}[music]`,
  );
  filters.push(`[vmain][music][sfx]amix=inputs=3:normalize=0:dropout_transition=0,apad,atrim=0:${opts.total}[out]`);

  await run(["ffmpeg", "-y", "-v", "error", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-ar", "48000", "-c:a", "pcm_s24le", pre]);

  // Pass 1: measure. Pass 2: apply linear normalisation with the measured values.
  const m = await measureLoudness(pre, mix.target_lufs, mix.true_peak);
  const ln =
    `loudnorm=I=${mix.target_lufs}:TP=${mix.true_peak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await run(["ffmpeg", "-y", "-v", "error", "-i", pre, "-af", ln, "-ar", "48000", "-c:a", "pcm_s16le", opts.out]);
  const after = await measureLoudness(opts.out, mix.target_lufs, mix.true_peak);
  return {
    integrated: Number(after.input_i),
    truePeak: Number(after.input_tp),
    normalised: [...normDb].map(([file, gain_db]) => ({ file, gain_db: Math.round(gain_db * 100) / 100 })),
  };
}

export async function measureLoudness(file: string, target = -14, tp = -1.5) {
  const { stderr } = await run([
    "ffmpeg", "-hide_banner", "-nostats", "-i", file, "-af", `loudnorm=I=${target}:TP=${tp}:LRA=11:print_format=json`, "-f", "null", "-",
  ]);
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  return JSON.parse(json) as {
    input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string;
  };
}
