/**
 * The episode state machine. `episode.yaml` is the single source of truth for where an episode is;
 * every stage is idempotent and resumable because sandboxes die (~4h) and sessions are re-keyed.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { channel, GateMode } from "./config";
import { load, writeYaml } from "./lib/io";
import { ep, type EpisodePaths } from "./lib/paths";

export const STAGES = [
  "topic", "research", "factcheck", "script", "voice", "storyboard", "scenes", "sound", "render", "package", "publish", "followup",
] as const;
export type Stage = (typeof STAGES)[number];

export const GATES = ["topic", "script", "storyboard", "final"] as const;
export type Gate = (typeof GATES)[number];

/**
 * What each stage consumes. Stages whose inputs are ready run in parallel: after the storyboard,
 * scenes, sound and package proceed side by side; render waits for scenes + sound.
 */
export const DEPS: Record<Stage, Stage[]> = {
  topic: [],
  research: ["topic"],
  factcheck: ["research"],
  script: ["factcheck"],
  voice: ["script"],
  storyboard: ["voice"],
  scenes: ["storyboard"],
  sound: ["storyboard"], // SFX live in the storyboard; music follows the locked timing
  package: ["storyboard"], // titles, thumbnail and description read script, claims and timing
  render: ["scenes", "sound"],
  publish: ["render", "package"],
  followup: ["publish"],
};

/** The stages whose outputs each human gate approves. */
export const GATE_COVERS: Record<Gate, Stage[]> = {
  topic: ["topic"],
  script: ["script"],
  storyboard: ["storyboard"],
  final: ["render", "package"],
};

/** The gate that must be approved before a stage may start. */
export const GATE_BEFORE: Partial<Record<Stage, Gate>> = {
  research: "topic",
  voice: "script",
  scenes: "storyboard",
  sound: "storyboard",
  package: "storyboard",
  publish: "final",
};

/** Every stage `stage` depends on, directly or not, in pipeline order. */
export function ancestors(stage: Stage): Stage[] {
  const seen = new Set<Stage>();
  const visit = (s: Stage) => DEPS[s].forEach((d) => { if (!seen.has(d)) { seen.add(d); visit(d); } });
  visit(stage);
  return STAGES.filter((s) => seen.has(s));
}

/** Every stage that depends on `stage`, directly or not, in pipeline order. */
export function descendants(stage: Stage): Stage[] {
  return STAGES.filter((s) => ancestors(s).includes(stage));
}

export interface StageSpec {
  agent: string;
  skills: string[];
  rubric?: string;
  outputs: (p: EpisodePaths) => string[];
  summary: string;
}

export const STAGE_SPECS: Record<Stage, StageSpec> = {
  topic: {
    agent: "topic-scout", skills: ["editorial-framing"], rubric: "rubrics/topic.md",
    outputs: (p) => [p.brief], summary: "Pick and frame the question; prove originality against existing YouTube coverage.",
  },
  research: {
    agent: "researcher", skills: ["research-dossier"], rubric: "rubrics/research.md",
    outputs: (p) => [p.dossier, p.claims], summary: "Build the dossier and claims.json from primary sources.",
  },
  factcheck: {
    agent: "fact-checker", skills: ["claim-verification"],
    outputs: (p) => [p.factcheck], summary: "Independently re-fetch every source and verify every claim; `yt claims apply`.",
  },
  script: {
    agent: "scriptwriter", skills: ["edutainment-scriptwriting"], rubric: "rubrics/script.md",
    outputs: (p) => [p.script, p.scriptMd], summary: "Write script.json beat by beat; every fact cites verified claims.",
  },
  voice: {
    agent: "sound-editor", skills: ["narration-and-sound"],
    outputs: (p) => [p.timing], summary: "Generate narration per beat (`yt voice`) and lock timing.json.",
  },
  storyboard: {
    agent: "art-director", skills: ["art-direction"], rubric: "rubrics/storyboard.md",
    outputs: (p) => [p.storyboard], summary: "Storyboard scenes over locked timing, with style frames.",
  },
  scenes: {
    agent: "animator", skills: ["scene-animation", "hyperframes", "hyperframes-core", "hyperframes-animation"],
    rubric: "rubrics/scene.md",
    outputs: () => [], summary: "Build every scene as a HyperFrames composition; each passes `yt scene check` + critic.",
  },
  sound: {
    agent: "sound-editor", skills: ["narration-and-sound"],
    outputs: (p) => [p.sound], summary: "Music cues + SFX (`yt music`, `yt sfx`).",
  },
  render: {
    agent: "showrunner", skills: ["showrunner-loop"], rubric: "rubrics/final-cut.md",
    outputs: (p) => [p.final], summary: "`yt render` then `yt qa final`; critic watches the contact sheet.",
  },
  package: {
    agent: "packager", skills: ["packaging"], rubric: "rubrics/packaging.md",
    outputs: (p) => [p.pkg, p.thumbnailHtml], summary: "Titles, thumbnail, description, tags; `yt sources`, `yt thumb`.",
  },
  publish: {
    agent: "publisher", skills: ["youtube-publishing"],
    outputs: (p) => [p.publish], summary: "Upload private, captions, thumbnail; schedule only after the final gate.",
  },
  followup: {
    agent: "publisher", skills: ["post-mortem"],
    outputs: () => [], summary: "48h/7d analytics + comments → corrections, learnings in memory/.",
  },
};

const Attempt = z.object({
  attempt: z.number(),
  started_at: z.string(),
  finished_at: z.string().optional(),
  outcome: z.enum(["done", "failed", "reopened"]).optional(),
});
const StageState = z.object({
  status: z.enum(["pending", "in_progress", "done", "failed", "skipped"]).default("pending"),
  attempts: z.number().default(0),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  score: z.number().optional(),
  note: z.string().optional(),
  /** One entry per attempt, so `yt episode timing` can show where the hours went. */
  history: z.array(Attempt).default([]),
});
const GateState = z.object({
  mode: GateMode,
  status: z.enum(["closed", "requested", "approved", "rejected"]).default("closed"),
  by: z.string().optional(),
  at: z.string().optional(),
  notes: z.string().optional(),
  review_id: z.string().optional(),
});
const CostEntry = z.object({
  at: z.string(),
  stage: z.string(),
  provider: z.string(),
  item: z.string(),
  units: z.number(),
  unit: z.string(),
  usd: z.number(),
});

export const EpisodeState = z.object({
  slug: z.string(),
  title: z.string(),
  created_at: z.string(),
  stages: z.record(z.enum(STAGES), StageState),
  gates: z.record(z.enum(GATES), GateState),
  costs: z.array(CostEntry).default([]),
  log: z.array(z.object({ at: z.string(), msg: z.string() })).default([]),
});
export type EpisodeState = z.infer<typeof EpisodeState>;

const now = () => new Date().toISOString();

export function newEpisode(slug: string, title: string): EpisodeState {
  const gates = channel().gates;
  return {
    slug,
    title,
    created_at: now(),
    stages: Object.fromEntries(STAGES.map((s) => [s, StageState.parse({})])) as EpisodeState["stages"],
    gates: Object.fromEntries(GATES.map((g) => [g, { mode: gates[g], status: "closed" }])) as EpisodeState["gates"],
    costs: [],
    log: [{ at: now(), msg: "episode created" }],
  };
}

export function loadEpisode(slug: string): EpisodeState {
  return load(EpisodeState, ep(slug).state);
}

export function saveEpisode(state: EpisodeState) {
  writeYaml(ep(state.slug).state, state);
}

export interface RunStage { stage: Stage; agent: string; skills: string[]; rubric?: string; summary: string; attempt: number }

export type NextAction =
  | ({ action: "run_stage"; also: RunStage[] } & RunStage)
  | { action: "await_gate"; gate: Gate; mode: z.infer<typeof GateMode>; status: string }
  | { action: "blocked"; stage: Stage; reason: string }
  | { action: "done" };

const finished = (state: EpisodeState, s: Stage) => ["done", "skipped"].includes(state.stages[s].status);
const gateOpen = (state: EpisodeState, g: Gate) => state.gates[g].mode === "auto" || state.gates[g].status === "approved";

/**
 * Pure decision function: what should happen next for this episode? `run_stage` names the first
 * runnable stage and lists every other stage whose inputs are ready in `also`: dispatch them together.
 */
export function nextAction(state: EpisodeState, maxAttempts = channel().critic.max_revisions + 1): NextAction {
  const runnable: RunStage[] = [];
  let waiting: NextAction | undefined;
  for (const stage of STAGES) {
    const s = state.stages[stage];
    if (finished(state, stage)) continue;
    if (s.status === "failed" && s.attempts >= maxAttempts) {
      return { action: "blocked", stage, reason: `failed ${s.attempts} times: ${s.note ?? ""}`.trim() };
    }
    if (!DEPS[stage].every((d) => finished(state, d))) continue;
    const gate = GATE_BEFORE[stage];
    if (gate && !gateOpen(state, gate)) {
      const g = state.gates[gate];
      if (g.status === "rejected") {
        const stg = GATE_COVERS[gate].find((c) => finished(state, c)) ?? stage;
        return { action: "blocked", stage: stg, reason: `gate ${gate} rejected: ${g.notes ?? "(no notes)"}; reopen with \`yt episode reopen\`` };
      }
      waiting ??= { action: "await_gate", gate, mode: g.mode, status: g.status };
      continue;
    }
    const spec = STAGE_SPECS[stage];
    runnable.push({
      stage,
      agent: spec.agent,
      skills: spec.skills,
      rubric: spec.rubric,
      summary: spec.summary,
      attempt: s.attempts + (s.status === "in_progress" ? 0 : 1),
    });
  }
  const [first, ...also] = runnable;
  if (first) return { action: "run_stage", ...first, also };
  return waiting ?? { action: "done" };
}

export function startStage(state: EpisodeState, stage: Stage) {
  const s = state.stages[stage];
  if (s.status === "done") throw new Error(`${stage} already done; use \`yt episode reopen\``);
  for (const prev of ancestors(stage)) {
    if (!finished(state, prev)) throw new Error(`cannot start ${stage}: ${prev} is ${state.stages[prev].status}`);
  }
  const gate = GATE_BEFORE[stage];
  if (gate && !gateOpen(state, gate)) throw new Error(`cannot start ${stage}: gate ${gate} is ${state.gates[gate].status}`);
  if (s.status !== "in_progress") {
    s.attempts += 1;
    s.started_at = now();
    s.history.push({ attempt: s.attempts, started_at: s.started_at });
  }
  s.status = "in_progress";
  log(state, `start ${stage} (attempt ${s.attempts})`);
}

/** Mark done only when every declared output exists. Schema validation is done by the caller (`yt validate`). */
export function completeStage(state: EpisodeState, stage: Stage, opts: { score?: number; note?: string } = {}) {
  const missing = STAGE_SPECS[stage].outputs(ep(state.slug)).filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`cannot complete ${stage}; missing outputs:\n  ${missing.join("\n  ")}`);
  const s = state.stages[stage];
  if (s.status !== "in_progress") throw new Error(`${stage} is ${s.status}, not in_progress`);
  s.status = "done";
  s.finished_at = now();
  closeAttempt(s, "done", s.finished_at);
  if (opts.score !== undefined) s.score = opts.score;
  if (opts.note) s.note = opts.note;
  for (const gate of GATES) {
    if (GATE_COVERS[gate].includes(stage) && state.gates[gate].mode !== "auto") state.gates[gate].status = "closed";
  }
  log(state, `done ${stage}${opts.score !== undefined ? ` (score ${opts.score})` : ""}`);
}

export function failStage(state: EpisodeState, stage: Stage, note: string) {
  const s = state.stages[stage];
  s.status = "failed";
  s.note = note;
  closeAttempt(s, "failed", now());
  log(state, `failed ${stage}: ${note}`);
}

/** Re-open a stage and every stage that consumes it — e.g. after a rejected gate or a factual correction. */
export function reopen(state: EpisodeState, stage: Stage, reason: string) {
  const affected = [stage, ...descendants(stage)];
  for (const later of affected) {
    const s = state.stages[later];
    if (s.status === "in_progress") closeAttempt(s, "reopened", now());
    if (s.status !== "pending") s.status = "pending";
    s.note = later === stage ? reason : `invalidated by reopen of ${stage}`;
  }
  for (const gate of GATES) {
    if (GATE_COVERS[gate].some((c) => affected.includes(c))) state.gates[gate].status = "closed";
  }
  log(state, `reopen ${stage}: ${reason}`);
}

function closeAttempt(s: EpisodeState["stages"][Stage], outcome: "done" | "failed" | "reopened", at: string) {
  const last = s.history.at(-1);
  if (last && !last.finished_at) Object.assign(last, { finished_at: at, outcome });
}

/** Per-stage active minutes (sum of attempts) and the episode's wall clock (first start → last finish). */
export function stageTimings(state: EpisodeState) {
  const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();
  const min = (x: number) => Math.round(x / 600) / 100;
  const all = STAGES.flatMap((st) => state.stages[st].history);
  const stages = STAGES.filter((st) => state.stages[st].history.length).map((stage) => {
    const h = state.stages[stage].history;
    const active = h.reduce((t, a) => t + (a.finished_at ? ms(a.started_at, a.finished_at) : 0), 0);
    return { stage, attempts: h.length, minutes: min(active), outcomes: h.map((a) => a.outcome ?? "running") };
  });
  const starts = all.map((a) => new Date(a.started_at).getTime());
  const ends = all.filter((a) => a.finished_at).map((a) => new Date(a.finished_at!).getTime());
  const wall = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
  return { stages, wall_minutes: min(wall) };
}

export function requestGate(state: EpisodeState, gate: Gate, reviewId?: string) {
  const g = state.gates[gate];
  if (g.status === "approved") throw new Error(`gate ${gate} is already approved; reopen a stage to change it`);
  g.status = "requested";
  g.at = now();
  if (reviewId) g.review_id = reviewId;
  log(state, `gate ${gate} requested (${g.mode})`);
}

export function decideGate(state: EpisodeState, gate: Gate, approve: boolean, by: string, notes?: string) {
  const g = state.gates[gate];
  if (g.mode === "human" && by === "critic") throw new Error(`gate ${gate} needs a human decision`);
  g.status = approve ? "approved" : "rejected";
  g.by = by;
  g.at = now();
  g.notes = notes;
  log(state, `gate ${gate} ${g.status} by ${by}${notes ? `: ${notes}` : ""}`);
}

export function addCost(state: EpisodeState, entry: Omit<z.infer<typeof CostEntry>, "at">) {
  state.costs.push({ at: now(), ...entry });
}

export function totalCost(state: EpisodeState): number {
  return Math.round(state.costs.reduce((a, c) => a + c.usd, 0) * 100) / 100;
}

function log(state: EpisodeState, msg: string) {
  state.log.push({ at: now(), msg });
}
