/**
 * Every artifact an agent hands to the next stage has a schema here. Agents write JSON; `yt validate`
 * and `yt episode complete` refuse to advance an episode whose artifacts do not parse.
 */
import { z } from "zod";

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9]{2,3}[a-z]?$`), `id like ${prefix}01`);
const slugRe = /^[0-9]{3}-[a-z0-9-]+$|^_[a-z0-9-]+$/;

// ─── Stage 1: topic & editorial framing ──────────────────────────────────────
export const Brief = z.object({
  slug: z.string().regex(slugRe, "slug like 001-why-the-sky-is-blue"),
  working_title: z.string().min(5),
  question: z.string().min(10).describe("The single question the video answers."),
  one_liner: z.string().min(10),
  audience: z.string().min(5),
  misconception: z.string().min(10).describe("What most viewers wrongly believe going in."),
  resolution: z.string().min(10).describe("The satisfying, correct model they leave with."),
  hook_ideas: z.array(z.string()).min(2),
  why_now: z.string(),
  originality: z.object({
    score: z.number().min(1).max(5),
    existing_coverage: z.array(
      z.object({ title: z.string(), url: z.string().url(), channel: z.string(), views: z.number().optional() }),
    ),
    our_angle: z.string().min(20).describe("What this video does that existing coverage does not."),
  }),
  target_minutes: z.number().min(1).max(20),
  key_questions: z.array(z.string()).min(3).describe("Research questions the dossier must answer."),
  risks: z.array(z.string()).default([]),
});
export type Brief = z.infer<typeof Brief>;

// ─── Stage 2: research & reporting ───────────────────────────────────────────
export const Source = z.object({
  id: id("s"),
  url: z.string().url(),
  title: z.string(),
  publisher: z.string(),
  authors: z.array(z.string()).default([]),
  published: z.string().optional(),
  tier: z.enum(["primary", "secondary", "tertiary"]),
  type: z.enum(["paper", "book", "dataset", "gov", "institution", "news", "encyclopedia", "expert", "other"]),
  accessed_at: z.string(),
});
export type Source = z.infer<typeof Source>;

export const ClaimStatus = z.enum(["unverified", "verified", "disputed", "rejected"]);
export const Claim = z.object({
  id: id("c"),
  text: z.string().min(5),
  source_ids: z.array(id("s")).min(1),
  quotes: z
    .array(z.object({ source_id: id("s"), quote: z.string().min(5), locator: z.string().optional() }))
    .min(1)
    .describe("Verbatim passages that support the claim."),
  confidence: z.enum(["high", "medium", "low"]),
  status: ClaimStatus.default("unverified"),
  notes: z.string().optional(),
});
export type Claim = z.infer<typeof Claim>;

export const Claims = z
  .object({ sources: z.array(Source).min(1), claims: z.array(Claim).min(1) })
  .superRefine((v, ctx) => {
    const sourceIds = new Set(v.sources.map((s) => s.id));
    if (sourceIds.size !== v.sources.length) ctx.addIssue({ code: "custom", message: "duplicate source id" });
    const claimIds = new Set(v.claims.map((c) => c.id));
    if (claimIds.size !== v.claims.length) ctx.addIssue({ code: "custom", message: "duplicate claim id" });
    for (const c of v.claims) {
      for (const s of [...c.source_ids, ...c.quotes.map((q) => q.source_id)]) {
        if (!sourceIds.has(s)) ctx.addIssue({ code: "custom", path: ["claims", c.id], message: `unknown source ${s}` });
      }
    }
  });
export type Claims = z.infer<typeof Claims>;

export const Verdict = z.enum(["supported", "partially_supported", "unsupported", "source_unreachable"]);
export const FactCheck = z.object({
  checked_at: z.string(),
  checker: z.string().default("fact-checker"),
  results: z
    .array(
      z.object({
        claim_id: id("c"),
        verdict: Verdict,
        evidence: z.string().min(5).describe("What the checker read, in its own fetch of the source."),
        corrected_text: z.string().optional(),
        claim_text: z.string().optional().describe("The claim text as checked; a claim reworded since then is not verified."),
      }),
    )
    .min(1),
});
export type FactCheck = z.infer<typeof FactCheck>;

// ─── Stage 3: script & structure ─────────────────────────────────────────────
export const Act = z.enum(["hook", "setup", "journey", "twist", "climax", "resolution", "outro"]);
export const Beat = z.object({
  id: id("b"),
  act: Act,
  kind: z.enum(["fact", "framing", "question", "analogy", "transition", "cta"]),
  narration: z.string().min(1).describe("Spoken text. ElevenLabs v3/v4 audio tags like [curious] or [short pause] are allowed."),
  claims: z.array(id("c")).default([]),
  visual_intent: z.string().min(5).describe("What the viewer should see, in one sentence."),
  emphasis: z.array(z.string()).default([]).describe("Words the animation should hit on cue."),
  chapter: z.string().max(60).optional().describe("Starts a YouTube chapter at this beat."),
  pause_after: z.number().min(0).max(3).optional(),
});
export type Beat = z.infer<typeof Beat>;

export const Script = z
  .object({
    title: z.string(),
    voice_direction: z.string().default(""),
    target_wpm: z.number().min(110).max(190).default(150),
    beats: z.array(Beat).min(1),
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>();
    v.beats.forEach((b, i) => {
      if (ids.has(b.id)) ctx.addIssue({ code: "custom", path: ["beats", i], message: `duplicate beat ${b.id}` });
      ids.add(b.id);
    });
  });
export type Script = z.infer<typeof Script>;

// Produced by `yt voice`, never by hand.
export const Word = z.object({ w: z.string(), start: z.number(), end: z.number() });
/** The narrator one episode was cast with (`yt cast adopt`), read by `yt voice`. */
export const VoiceCast = z.object({
  source: z.literal("library"),
  voice_id: z.string().min(1),
  model_id: z.string().min(1),
  name: z.string(),
  accent: z.string().nullish(),
  gender: z.string().nullish(),
  age: z.string().nullish(),
  descriptive: z.string().nullish(),
  description: z.string().nullish(),
  reason: z.string().min(1).describe("Why this voice fits this episode."),
  decided_by: z.string(),
  cast_at: z.string(),
});
export type VoiceCast = z.infer<typeof VoiceCast>;

export const Timing = z.object({
  provider: z.string(),
  total: z.number(),
  beats: z.array(
    z.object({
      id: z.string(),
      start: z.number(),
      end: z.number(),
      speech_end: z.number(),
      audio: z.string(),
      words: z.array(Word),
    }),
  ),
});
export type Timing = z.infer<typeof Timing>;

// ─── Stage 4: visual concepting ──────────────────────────────────────────────
export const SceneType = z.enum(["hf-2d", "diagram", "title", "hf-3d", "genbroll"]);
export const Sfx = z.object({
  prompt: z.string().min(3),
  beat: id("b"),
  at_word: z.string().optional().describe("Fire on this word of the beat; omitted = beat start."),
  offset: z.number().default(0),
  duration: z.number().min(0.3).max(10).default(1.5),
  volume: z.number().min(0).max(2).default(0.8),
});
export const Scene = z.object({
  id: id("sc"),
  beats: z.array(id("b")).min(1),
  type: SceneType,
  concept: z.string().min(10),
  visual_metaphor: z.string().optional(),
  elements: z.array(z.string()).default([]),
  motion: z.string().min(5),
  on_screen_text: z.array(z.string()).default([]),
  transition_in: z.enum(["cut", "wipe", "zoom", "match", "fade"]).default("cut"),
  styleframe: z.string().optional(),
  /** What the scene's key frame shows; `yt storyboard frames` has the image model draw it into `styleframe`. */
  styleframe_prompt: z.string().optional(),
  broll_prompt: z.string().optional(),
  sfx: z.array(Sfx).default([]),
});
export type Scene = z.infer<typeof Scene>;
export const Storyboard = z.object({
  style_notes: z.string().default(""),
  scenes: z.array(Scene).min(1),
});
export type Storyboard = z.infer<typeof Storyboard>;

// ─── Stage 6: sound ──────────────────────────────────────────────────────────
export const Sound = z.object({
  music: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string().min(10),
        from_beat: id("b"),
        to_beat: id("b"),
        volume: z.number().min(0).max(1).default(0.25),
      }),
    )
    .default([]),
  voice: z.object({ provider: z.string(), voice_id: z.string().optional() }).optional(),
});
export type Sound = z.infer<typeof Sound>;

// ─── Stage 7: packaging ──────────────────────────────────────────────────────
export const Package = z.object({
  titles: z
    .array(z.object({ text: z.string().max(100), rationale: z.string(), score: z.number().min(1).max(10) }))
    .min(5),
  chosen_title: z.string().max(100),
  description: z.string().min(50).describe("Body only; sources and chapters are appended by `yt sources`."),
  tags: z.array(z.string()).max(30),
  thumbnail: z.object({ concept: z.string(), text: z.string().max(40) }),
  category_id: z.string().default("27"),
  language: z.string().default("en"),
  made_for_kids: z.boolean().default(false),
  contains_synthetic_media: z.boolean(),
  synthetic_media_reason: z.string().optional(),
});
export type Package = z.infer<typeof Package>;

// ─── Stage 8: publication ────────────────────────────────────────────────────
export const Publish = z.object({
  video_id: z.string(),
  url: z.string().url(),
  uploaded_at: z.string(),
  privacy: z.enum(["private", "unlisted", "public"]),
  publish_at: z.string().optional(),
  captions_uploaded: z.boolean().default(false),
  thumbnail_set: z.boolean().default(false),
  sources_url: z.string().optional(),
});
export type Publish = z.infer<typeof Publish>;

// ─── Critic reviews (every gate) ─────────────────────────────────────────────
export const Review = z.object({
  stage: z.string(),
  rubric: z.string(),
  reviewer: z.string().default("critic"),
  reviewed_at: z.string(),
  scores: z.record(z.string(), z.number().min(1).max(5)),
  overall: z.number().min(1).max(5),
  pass: z.boolean(),
  auto_fail: z.array(z.string()).default([]),
  issues: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        where: z.string(),
        problem: z.string(),
        fix: z.string(),
      }),
    )
    .default([]),
  evidence: z.array(z.string()).default([]).describe("Snapshot/contact-sheet paths the critic looked at."),
});
export type Review = z.infer<typeof Review>;

/**
 * The pass rule, decided here rather than trusted from the critic's own `pass` field: a stage passes
 * when nothing would stop it shipping — no auto-fail, no blocker, no major. Scores are feedback only;
 * minor issues are recorded, never sent back.
 */
export function reviewVerdict(r: Review) {
  const count = (sev: "blocker" | "major" | "minor") => r.issues.filter((i) => i.severity === sev).length;
  const blockers = count("blocker"), majors = count("major"), minors = count("minor");
  return { pass: r.auto_fail.length === 0 && blockers === 0 && majors === 0, blockers, majors, minors, auto_fail: r.auto_fail, overall: r.overall };
}
