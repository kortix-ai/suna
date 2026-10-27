import { join } from "node:path";
import { z } from "zod";
import { CHANNEL } from "./lib/paths";
import { load } from "./lib/io";

export const GateMode = z.enum(["human", "critic", "auto"]);

export const ChannelConfig = z.object({
  name: z.string(),
  niche: z.string(),
  language: z.string().default("en"),
  video: z.object({
    width: z.number().default(1920),
    height: z.number().default(1080),
    fps: z.number().default(30),
    quality: z.enum(["draft", "looks", "standard", "high", "delivery"]).default("standard"),
  }),
  voice: z.object({
    provider: z.enum(["elevenlabs", "kokoro", "stub"]),
    wpm: z.number().default(150),
    default_pause: z.number().default(0.35),
    elevenlabs: z
      .object({
        stability: z.number().default(0.5),
        similarity_boost: z.number().default(0.75),
        style: z.number().default(0.3),
        speed: z.number().default(1),
      })
      .default({ stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: 1 }),
    casting: z
      .object({
        language: z.string().default("en"),
        use_case: z.string().default("narrative_story"),
        sort: z.string().default("usage_character_count_1y"),
        model_id: z.string().default("eleven_v4"),
      })
      .default({ language: "en", use_case: "narrative_story", sort: "usage_character_count_1y", model_id: "eleven_v4" }),
    kokoro: z.object({ voice: z.string().default("am_michael") }).default({ voice: "am_michael" }),
  }),
  music: z.object({
    provider: z.enum(["elevenlabs", "stub"]),
    default_volume: z.number().default(0.22),
    /** Side-chain ratio of the ducker that sits the score under the narration. */
    duck_db: z.number().default(2),
    /** Every music take is normalised to this integrated loudness before its cue volume is applied. */
    reference_lufs: z.number().default(-20),
  }),
  sfx: z.object({
    provider: z.enum(["elevenlabs", "stub"]),
    /** Every SFX take is normalised to this true peak before its storyboard volume is applied. */
    reference_peak_db: z.number().default(-4),
  }),
  mix: z.object({
    target_lufs: z.number().default(-14),
    true_peak: z.number().default(-1.5),
    /** Ducker side-chain threshold (dBFS) and release (ms) for the narration key. */
    duck_threshold_db: z.number().default(-30),
    duck_release_ms: z.number().default(700),
    /** Equal-power crossfade between adjacent music cues (s); 0 restores hard per-cue fades. */
    music_crossfade_s: z.number().default(1.5),
  }),
  broll: z.object({
    enabled: z.boolean().default(false),
    provider: z.literal("fal").default("fal"),
    model: z.string(),
    max_runtime_fraction: z.number().min(0).max(1).default(0.2),
    budget_usd: z.number().default(25),
    usd_per_second: z.number().default(0.1),
  }),
  /** Style frames: the image model draws each scene's key frame from the art director's `styleframe_prompt`;
   * animators recreate them, so the frames set the episode's look. */
  styleframes: z.object({
    model: z.string(),
    size: z.string(),
    quality: z.enum(["low", "medium", "high", "auto"]),
    /** Saved width (px); frames are cropped to 16:9. */
    width: z.number().int().positive(),
    /** The art direction sent with every frame. */
    look: z.string().min(1),
  }),
  gates: z.object({ topic: GateMode, script: GateMode, storyboard: GateMode, final: GateMode }),
  critic: z.object({ max_revisions: z.number().default(3), scene_fix_rounds: z.number().int().min(0).default(1) }),
  /**
   * Agents run stages and scenes in parallel; CPU-heavy HyperFrames jobs share the sandbox through
   * `withHeavySlot`, one pool per kind: renders (`heavy_job`) and previews (`preview_job`: check, snapshot).
   * Slots = min(cores / job.cores, RAM / job.memory_gb).
   */
  parallel: z
    .object({
      heavy_job: z
        .object({ cores: z.number().positive().default(1.65), memory_gb: z.number().positive().default(1.4) })
        .prefault({}),
      preview_job: z
        .object({ cores: z.number().positive().default(0.9), memory_gb: z.number().positive().default(0.84) })
        .prefault({}),
    })
    .prefault({}),
  rates: z.record(z.string(), z.number()).default({}),
  publish: z.object({
    default_privacy: z.enum(["private", "unlisted"]).default("private"),
    sources_base_url: z.string().default(""),
  }),
});
export type ChannelConfig = z.infer<typeof ChannelConfig>;

export const channelConfigPath = () => process.env.YT_CHANNEL_CONFIG ?? join(CHANNEL, "channel.yaml");

let cached: ChannelConfig | undefined;
export function channel(): ChannelConfig {
  if (!cached) {
    cached = load(ChannelConfig, channelConfigPath());
    // YT_OFFLINE=1: stub voice/music/SFX everywhere (tests, dry runs, sessions without API keys).
    if (process.env.YT_OFFLINE === "1") {
      cached.voice.provider = "stub";
      cached.music.provider = "stub";
      cached.sfx.provider = "stub";
    }
  }
  return cached;
}

/** Test hook. */
export function setChannel(cfg: ChannelConfig | undefined) {
  cached = cfg;
}
