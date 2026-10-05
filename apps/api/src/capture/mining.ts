/**
 * L3 workflow mining, one job per account (`capture.mine`): nightly, and 10
 * minutes after new episodes are traced. The gateway has no embedding model,
 * so similarity is structural and lexical:
 *
 *   sim(a, b) = 0.5 · step-sequence similarity (edit distance over verb@app)
 *             + 0.3 · Jaccard of the step objects' words
 *             + 0.2 · Jaccard of the labels' words
 *
 *   1. traced procedural episodes of the last MINE_DAYS, grouped by signature;
 *      abandoned runs wait for step 3b
 *   2. average-linkage clustering of the signature groups down to MERGE_AT;
 *      cluster pairs between ASK_FROM and MERGE_AT go to one model call that
 *      judges which are the same procedure
 *   3. per cluster with MIN_RUNS runs: paths (sub-clusters at PATH_AT), the
 *      canonical procedure (largest path), variants (paths with VARIANT_SHARE),
 *      decision points (where a variant leaves the canonical path), stats,
 *      and the automation score = runs/week × p50 hours × determinism
 *   3b. each abandoned run joins the workflow it started: the one whose canonical
 *      path holds most of its steps in order (PARTIAL_AT), most similar first
 *   4. one model call per new or changed workflow names it and its variants
 *   5. clusters keep the identity of the workflow most of their runs had:
 *      names, review state and skills survive re-mining (the incremental part)
 *
 * ponytail: O(n³) agglomeration over distinct signatures, fine to ~600 per
 * account; beyond that, cluster within app-set buckets first.
 */
import { captureEpisodeSteps, captureEpisodes, captureWorkflows } from '@kortix/db';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { CaptureBudgetExceeded, recordSpend, withinBudget } from './budget';
import { withCaptureGateway } from './gateway';
import { emptyUsage, gatewayCaller, type Caller } from './processing';
import type { WorkflowStep, WorkflowVariant } from './skills';

export const MINE_DAYS = 56;
export const MERGE_AT = 0.55;
export const ASK_FROM = 0.4;
export const PATH_AT = 0.8;
export const MIN_RUNS = 3;
export const VARIANT_SHARE = 0.08;
export const PARTIAL_AT = 0.75;
const MAX_JUDGEMENTS = 20;

// ─── Similarity ──────────────────────────────────────────────────────────────

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'with', 'by', 'from', 'as', 'at', 'or', 'its', 'their', 'into']);

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

export function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export const sequenceSimilarity = <T>(a: T[], b: T[]) => (a.length || b.length ? 1 - editDistance(a, b) / Math.max(a.length, b.length) : 1);

export interface Group {
  signature: string;
  tokens: string[];
  objectWords: Set<string>;
  labelWords: Set<string>;
  members: number;
}

export function similarity(a: Group, b: Group): number {
  return 0.5 * sequenceSimilarity(a.tokens, b.tokens) + 0.3 * jaccard(a.objectWords, b.objectWords) + 0.2 * jaccard(a.labelWords, b.labelWords);
}

/**
 * Average-linkage agglomerative clustering, weighted by `weights`, merging
 * while the best pair reaches `threshold`. Returns clusters as index lists,
 * and the final cluster similarity matrix (for borderline pairs).
 */
export function agglomerate(sim: number[][], weights: number[], threshold: number) {
  const n = weights.length;
  const s = sim.map((row) => [...row]);
  const w = [...weights];
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (const i of alive) for (const j of alive) if (i < j && s[i]![j]! > best) [best, bi, bj] = [s[i]![j]!, i, j];
    if (bi < 0 || best < threshold) break;
    for (const k of alive) {
      if (k === bi || k === bj) continue;
      const v = (w[bi]! * s[bi]![k]! + w[bj]! * s[bj]![k]!) / (w[bi]! + w[bj]!);
      s[bi]![k] = v;
      s[k]![bi] = v;
    }
    w[bi] = w[bi]! + w[bj]!;
    members[bi] = [...members[bi]!, ...members[bj]!];
    alive.delete(bj);
  }
  const ids = [...alive];
  return { clusters: ids.map((i) => members[i]!), between: (x: number, y: number) => s[ids[x]!]![ids[y]!]! };
}

/** Canonical indexes (1-based) a path does not keep, by longest common subsequence; else where it inserts. */
export function differingSteps(canonical: string[], path: string[]): number[] {
  const m = canonical.length;
  const n = path.length;
  const L = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i]![j] = canonical[i] === path[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const kept = new Set<number>();
  let firstInsert = -1;
  for (let i = 0, j = 0; i < m && j < n; ) {
    if (canonical[i] === path[j]) {
      kept.add(i);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else {
      if (firstInsert < 0) firstInsert = i;
      j++;
    }
  }
  const missing = canonical.map((_, i) => i).filter((i) => !kept.has(i)).map((i) => i + 1);
  return missing.length ? missing : [Math.max(1, firstInsert < 0 ? m : firstInsert + 1)];
}

export function commonSubsequence(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[b.length]!;
}

/** A workflow as one group: its canonical path and the words most of its runs share. */
export function workflowGroup(m: MinedWorkflow): Group {
  return {
    signature: m.signature,
    tokens: m.paths[0]!.tokens,
    objectWords: frequent(m.runs.map((r) => r.steps.flatMap((s) => words(s.object))), 0.3),
    labelWords: frequent(m.runs.map((r) => words(r.label)), 0.3),
    members: m.runs.length,
  };
}

/** The workflow an abandoned run started: most of its steps in order on the canonical path, most similar first. */
export function startedWorkflow(run: Group, workflows: Array<{ group: Group }>): number {
  let best = -1;
  let score = 0;
  for (const [i, w] of workflows.entries()) {
    if (commonSubsequence(run.tokens, w.group.tokens) / run.tokens.length < PARTIAL_AT) continue;
    const sim = similarity(run, w.group);
    if (sim > score) [best, score] = [i, sim];
  }
  return best;
}

/** Verbs of a step that changes something; a path that differs only in other verbs is the same way of working. */
const MUTATING = new Set(['create', 'update', 'set', 'send', 'approve', 'reject', 'delete', 'submit', 'schedule', 'upload', 'import', 'export', 'attach']);

/** Whether two paths differ in at least one step that changes something (multiset difference of verb@app). */
export function changesSomething(a: string[], b: string[]): boolean {
  const diff = [...minus(a, b), ...minus(b, a)];
  return diff.some((t) => MUTATING.has(t.split('@')[0]!));
}

/**
 * What a path changes against `a`, as one comparable key: the changing steps of `a` it skips, and
 * the apps it adds work in. The verb of an added step is left out on purpose: the model names the
 * same step "Open" in one run and "Update" in the next (a carrier page, measured on the eval set).
 */
export function changeKey(a: string[], b: string[]): string {
  const changing = (t: string) => MUTATING.has(t.split('@')[0]!);
  const apps = [...new Set(minus(b, a).map((t) => t.split('@')[1]!))].sort();
  return `-${minus(a, b).filter(changing).sort().join(',')}|+${apps.join(',')}`;
}

/** Items of `a` left after removing one match per item of `b` (by verb@app for steps). */
function minus<T>(a: T[], b: T[]): T[] {
  const key = (x: T) => (typeof x === 'string' ? x : `${(x as { verb: string }).verb.toLowerCase()}@${((x as { app: string | null }).app ?? '').toLowerCase()}`);
  const left = new Map<string, number>();
  for (const x of b) left.set(key(x), (left.get(key(x)) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(key(x)) ?? 0;
    if (n) left.set(key(x), n - 1);
    return !n;
  });
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (idx - lo);
}

// ─── Mining ──────────────────────────────────────────────────────────────────

interface Run {
  episodeId: string;
  userId: string;
  start: Date;
  end: Date;
  label: string;
  goal: string | null;
  outcome: string | null;
  outcomeStatus: string | null;
  signature: string;
  workflowId: string | null;
  steps: Array<{ verb: string; app: string | null; object: string; params: string | null; variables: string[] }>;
}

function frequent(sets: string[][], min: number): Set<string> {
  const counts = new Map<string, number>();
  for (const list of sets) for (const w of new Set(list)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return new Set([...counts].filter(([, c]) => c >= Math.max(1, min * sets.length)).map(([w]) => w));
}

export function groupRuns(runs: Run[]): Array<Group & { runs: Run[] }> {
  const bySig = new Map<string, Run[]>();
  for (const r of runs) bySig.set(r.signature, [...(bySig.get(r.signature) ?? []), r]);
  return [...bySig].map(([signature, rs]) => ({
    signature,
    tokens: signature.split(' '),
    objectWords: frequent(rs.map((r) => r.steps.flatMap((s) => words(s.object))), 0.3),
    labelWords: frequent(rs.map((r) => words(r.label)), 0.3),
    members: rs.length,
    runs: rs,
  }));
}

export interface MinedWorkflow {
  signature: string;
  runs: Run[];
  paths: Array<{ key: string; runs: Run[]; tokens: string[]; representative: Run }>;
  steps: WorkflowStep[];
  variants: WorkflowVariant[];
  apps: string[];
  stats: {
    runsTotal: number;
    runsPerWeek: number;
    p50: number;
    p90: number;
    people: number;
    successRate: number | null;
    determinism: number;
    hoursPerWeek: number;
    first: Date;
    last: Date;
  };
}

/** Paths, canonical steps, variants and stats of one cluster of runs. `now` bounds the runs/week window. */
export function describeCluster(runs: Run[], now: number): MinedWorkflow {
  // Paths come from finished runs: an abandoned run is a prefix, not a way of doing the task.
  const finished = runs.filter((r) => r.outcomeStatus !== 'abandoned');
  const groups = groupRuns(finished.length ? finished : runs);
  const sim = groups.map((a) => groups.map((b) => sequenceSimilarity(a.tokens, b.tokens)));
  const sub = agglomerate(sim, groups.map((g) => g.members), PATH_AT).clusters
    .map((idx) => {
      const rs = idx.flatMap((i) => groups[i]!.runs);
      const mode = idx.map((i) => groups[i]!).sort((a, b) => b.members - a.members)[0]!;
      const representative = [...mode.runs].sort((a, b) => b.start.getTime() - a.start.getTime())[0]!;
      return { runs: rs, tokens: mode.tokens, representative };
    })
    .sort((a, b) => b.runs.length - a.runs.length);
  // A variant, like a workflow, needs MIN_RUNS runs (and VARIANT_SHARE of them).
  const minRuns = Math.max(MIN_RUNS, Math.ceil(VARIANT_SHARE * finished.length));
  // A path that differs from the most common one only in steps that change nothing (open, read,
  // copy, fill…) is the same way of working, traced at another grain: it folds into A.
  const folded: typeof sub = [];
  for (const p of sub) {
    if (folded.length && !changesSomething(folded[0]!.tokens, p.tokens)) {
      folded[0] = { ...folded[0]!, runs: [...folded[0]!.runs, ...p.runs] };
      continue;
    }
    // Two paths that add and skip the same changing steps against A are one variant at two grains.
    const same = folded.findIndex((q, i) => i > 0 && changeKey(folded[0]!.tokens, q.tokens) === changeKey(folded[0]!.tokens, p.tokens));
    if (same > 0) folded[same] = { ...folded[same]!, runs: [...folded[same]!.runs, ...p.runs] };
    else folded.push(p);
  }
  const ordered = [folded[0]!, ...folded.slice(1).sort((a, b) => b.runs.length - a.runs.length)];
  const named = ordered.filter((p, i) => i === 0 || p.runs.length >= minRuns).slice(0, 5);
  const paths = named.map((p, i) => ({ ...p, key: String.fromCharCode(65 + i) }));
  const canonical = paths[0]!;
  const steps: WorkflowStep[] = canonical.representative.steps.map((s, index) => ({
    index: index + 1,
    verb: s.verb,
    object: s.object,
    app: s.app,
    params: s.params,
    variables: s.variables,
    decision: null,
  }));
  const variants: Array<WorkflowVariant & { question: string }> = paths.map((p) => {
    // Until the model names it: a variant is named by the first step it adds, else by the step it skips.
    const added = minus(p.representative.steps, canonical.representative.steps);
    const skipped = minus(canonical.representative.steps, p.representative.steps);
    const changing = (x: Run['steps'][number]) => MUTATING.has(x.verb.toLowerCase());
    const lead = added.find(changing) ?? skipped.find(changing) ?? added[0] ?? skipped[0];
    const leadAdded = !!lead && added.includes(lead);
    const phrase = (x: Run['steps'][number]) => `${x.verb.toLowerCase()} ${x.object}`;
    // A is named by what it does that the variants do not (else its last changing step).
    const own = paths.slice(1).flatMap((q) => minus(canonical.representative.steps, q.representative.steps));
    const signature = own.find(changing) ?? own[0] ?? [...canonical.representative.steps].reverse().find((x) => MUTATING.has(x.verb.toLowerCase())) ?? canonical.representative.steps[canonical.representative.steps.length - 1];
    return {
      key: p.key,
      name: p.key === 'A' ? `Standard: ${signature ? phrase(signature) : 'the usual steps'}` : lead ? `${leadAdded ? '' : 'Skip: '}${capitalize(phrase(lead))}` : `Path ${p.key}`,
      runs: p.runs.length,
      share: Math.round((p.runs.length / finished.length || 0) * 1000) / 1000,
      steps_count: p.tokens.length,
      differs: p.key === 'A' ? [] : differingSteps(canonical.tokens, p.tokens),
      note:
        p.key === 'A'
          ? `The usual way, ${Math.round((p.runs.length / Math.max(1, finished.length)) * 100)}% of runs: ${canonical.representative.steps.map(phrase).join(' → ')}.`
          : [added.length && `Adds: ${added.map(phrase).join(' → ')}.`, skipped.length && `Skips: ${skipped.map(phrase).join(' → ')}.`].filter(Boolean).join(' '),
      question: lead ? `the run needs to ${leadAdded ? phrase(lead) : `go without the step "${phrase(lead)}"`}` : `the case differs from path A`,
    };
  });
  for (const v of variants.slice(1)) {
    const at = Math.max(0, Math.min(steps.length - 1, v.differs[0]! - 2));
    if (!steps[at]!.decision) steps[at]!.decision = { question: v.question, variant: v.key, share: v.share };
  }
  const done = runs.filter((r) => r.outcomeStatus !== 'abandoned');
  const durations = done.map((r) => (r.end.getTime() - r.start.getTime()) / 1000).sort((a, b) => a - b);
  const first = new Date(Math.min(...runs.map((r) => r.start.getTime())));
  const last = new Date(Math.max(...runs.map((r) => r.start.getTime())));
  const windowStart = Math.max(first.getTime(), now - 28 * 86_400_000);
  const weeks = Math.max(1, (now - windowStart) / (7 * 86_400_000));
  const runsPerWeek = runs.filter((r) => r.start.getTime() >= windowStart).length / weeks;
  const judged = runs.filter((r) => r.outcomeStatus);
  const onNamedPath = paths.reduce((n, p) => n + p.runs.filter((r) => r.outcomeStatus !== 'abandoned').length, 0);
  const determinism = done.length ? onNamedPath / done.length : 0;
  const p50 = percentile(durations, 0.5);
  return {
    signature: canonical.tokens.join(' '),
    runs,
    paths,
    steps,
    variants,
    // The apps of the named paths: a detour inside one run (a chat reply) is not something the workflow needs.
    apps: [...new Set(paths.flatMap((p) => p.representative.steps.map((s) => s.app)).filter((a): a is string => !!a))],
    stats: {
      runsTotal: runs.length,
      runsPerWeek,
      p50,
      p90: percentile(durations, 0.9),
      people: new Set(runs.map((r) => r.userId)).size,
      successRate: judged.length ? judged.filter((r) => r.outcomeStatus === 'succeeded').length / judged.length : null,
      determinism,
      hoursPerWeek: (runsPerWeek * p50 * determinism) / 3600,
      first,
      last,
    },
  };
}

const judgeZod = z.object({ same: z.array(z.coerce.number()).nullish().transform((v) => v ?? []) });
const nameZod = z.object({
  name: z.string(),
  goal: z.string().nullish(),
  outcome: z.string().nullish(),
  variants: z
    .array(z.object({ key: z.string(), name: z.string(), note: z.string().nullish(), question: z.string().nullish() }))
    .nullish()
    .transform((v) => v ?? []),
});

const describeRun = (r: Run) => `"${r.label}" — ${r.steps.map((s) => `${s.verb} ${s.object}${s.app ? ` (${s.app})` : ''}`).join(' → ')}`;

/**
 * The naming prompt. The workflow's name, goal and outcome describe its standard path (A, the most
 * runs): the samples are A's latest runs only, so a variant's wording (a denial, a redirect) never
 * names the whole workflow. The variants are named by how they differ from A.
 */
export function namePrompt(w: MinedWorkflow): string {
  const samples = w.paths[0]!.runs.slice(-6).map((r) => `- ${r.label}: ${r.goal ?? ''} → ${r.outcome ?? ''}`).join('\n');
  const paths = w.paths
    .map((p) => {
      const v = w.variants.find((x) => x.key === p.key);
      return `${p.key} (${p.runs.length} runs): ${describeRun(p.representative)}${p.key === 'A' ? '' : `\n   differs from A: ${v?.note || 'other steps'}`}`;
    })
    .join('\n');
  return `These are runs of one procedure people repeat at work, mined from their recorded activity.

Sample runs of path A, the standard path (label: goal → outcome):
${samples}

Paths (A = the most common; others are variants):
${paths}

Name the procedure and each path. "name", "goal" and "outcome" describe path A, the standard path, never a variant: "name" 3-7 words, imperative, generic (e.g. "Refund a damaged-order claim"); "goal" and "outcome" one sentence each. For every path, A included: "name" (2-5 words, distinct per path; A by what it does, e.g. "Standard: refund to original payment"; the others by the case they handle, from the steps where they differ from A, e.g. "Outside the return window"), "note" (one sentence: what this path does; for the others, what differs from A). For each path except A also "question" (the decision that leads to it, as a condition, e.g. "the order is older than 30 days"). No literal values (names, numbers, emails).

Return ONLY JSON: {"name":"…","goal":"…","outcome":"…","variants":[{"key":"A","name":"…","note":"…"},{"key":"B","name":"…","note":"…","question":"…"}]}`;
}

function judgePrompt(pairs: Array<[MinedWorkflow, MinedWorkflow]>): string {
  const lines = pairs.map(([a, b], i) => `${i + 1}. X: ${describeRun(a.paths[0]!.representative)}\n   Y: ${describeRun(b.paths[0]!.representative)}`).join('\n');
  return `Each pair shows two recorded procedures. They are the same procedure when they handle the same kind of request on the same kind of item, even if steps differ. One may be a branch of the other: the same trigger and opening steps, then a decision leads to another ending (for example approving or rejecting the same kind of request). They differ when the request they handle differs.

${lines}

Return ONLY JSON: {"same":[<numbers of the pairs that are the same procedure>]}`;
}

export const MINE_QUEUE = 'capture.mine';

/** Episodes as runs: their steps loaded, those with fewer than 2 steps or no signature left out. */
async function runsOf(episodes: Array<typeof captureEpisodes.$inferSelect>): Promise<Run[]> {
  const stepRows = episodes.length
    ? await db
        .select()
        .from(captureEpisodeSteps)
        .where(inArray(captureEpisodeSteps.episodeId, episodes.map((e) => e.episodeId)))
        .orderBy(asc(captureEpisodeSteps.episodeId), asc(captureEpisodeSteps.index))
    : [];
  const stepsOf = new Map<string, Run['steps']>();
  for (const s of stepRows) stepsOf.set(s.episodeId, [...(stepsOf.get(s.episodeId) ?? []), { verb: s.verb, app: s.app, object: s.object, params: s.params, variables: s.variables }]);
  return episodes
    .filter((e) => e.signature && (stepsOf.get(e.episodeId)?.length ?? 0) >= 2)
    .map((e) => ({
      episodeId: e.episodeId,
      userId: e.userId,
      start: e.startAt,
      end: e.endAt,
      label: e.label ?? '',
      goal: e.goal,
      outcome: e.outcome,
      outcomeStatus: e.outcomeStatus,
      signature: e.signature!,
      workflowId: e.workflowId,
      steps: stepsOf.get(e.episodeId)!,
    }));
}

/**
 * Rebuild workflows from the runs they still hold, with no model call: after a forget, nothing a
 * workflow shows may come from a run that is gone. Steps, variants and stats are recomputed. A
 * detected workflow also takes its name, goal and outcome from its own remaining runs (the most
 * common label, the latest goal and outcome) and is named again by the next mining run; a
 * reviewed or exported one keeps the name a person gave it. Below MIN_RUNS runs, a detected
 * workflow is deleted and a reviewed one keeps its row with no steps.
 */
export async function refreshWorkflows(workflowIds: string[], now = Date.now()): Promise<void> {
  if (!workflowIds.length) return;
  const rows = await db.select().from(captureWorkflows).where(inArray(captureWorkflows.workflowId, workflowIds));
  for (const w of rows) {
    const members = await db.select().from(captureEpisodes).where(eq(captureEpisodes.workflowId, w.workflowId)).orderBy(asc(captureEpisodes.startAt));
    const runs = await runsOf(members);
    const finished = runs.filter((r) => r.outcomeStatus !== 'abandoned');
    if (finished.length < MIN_RUNS) {
      if (w.status === 'detected') await db.delete(captureWorkflows).where(eq(captureWorkflows.workflowId, w.workflowId));
      else await db.update(captureWorkflows).set({ steps: [], variants: [], runsTotal: runs.length, updatedAt: new Date() }).where(eq(captureWorkflows.workflowId, w.workflowId));
      await db.update(captureEpisodes).set({ workflowId: null, variantKey: null }).where(eq(captureEpisodes.workflowId, w.workflowId));
      continue;
    }
    const m = describeCluster(runs, now);
    const labels = new Map<string, number>();
    for (const r of finished) if (r.label) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
    const latest = finished[finished.length - 1]!;
    const own = w.status === 'detected';
    await db
      .update(captureWorkflows)
      .set({
        ...(own ? { name: [...labels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unnamed workflow', goal: latest.goal, outcome: latest.outcome, model: null } : {}),
        steps: m.steps as unknown as Record<string, unknown>[],
        variants: m.variants as unknown as Record<string, unknown>[],
        apps: m.apps,
        runsTotal: m.stats.runsTotal,
        runsPerWeek: m.stats.runsPerWeek.toFixed(2),
        durationP50S: Math.round(m.stats.p50),
        durationP90S: Math.round(m.stats.p90),
        peopleCount: m.stats.people,
        successRate: m.stats.successRate === null ? null : m.stats.successRate.toFixed(4),
        determinism: m.stats.determinism.toFixed(4),
        automationHoursPerWeek: m.stats.hoursPerWeek.toFixed(2),
        firstSeenAt: m.stats.first,
        lastSeenAt: m.stats.last,
        updatedAt: new Date(),
      })
      .where(eq(captureWorkflows.workflowId, w.workflowId));
    for (const path of m.paths) await db.update(captureEpisodes).set({ variantKey: path.key }).where(inArray(captureEpisodes.episodeId, path.runs.map((r) => r.episodeId)));
  }
}

/** Re-mine one account. Returns how many workflows it holds after the run, and the model spend. */
/**
 * `rename`: name every unreviewed workflow again (an admin's "run now"); else a kept workflow is
 * named again only when its runs or standard path changed, so names stay stable between runs.
 */
export async function mineAccount(accountId: string, caller?: Caller, now = Date.now(), opts: { rename?: boolean } = {}): Promise<{ workflows: number; costUsd: number }> {
  if (!caller) {
    const [owner] = await db
      .select({ userId: captureEpisodes.userId })
      .from(captureEpisodes)
      .where(eq(captureEpisodes.accountId, accountId))
      .limit(1);
    if (!owner) return { workflows: 0, costUsd: 0 };
    return withCaptureGateway({ accountId, userId: owner.userId }, (gateway) =>
      mineAccount(accountId, gatewayCaller(gateway.authorization, config.KORTIX_CAPTURE_MODEL, gateway.url), now, opts),
    );
  }
  const since = new Date(now - MINE_DAYS * 86_400_000);
  const episodes = await db
    .select()
    .from(captureEpisodes)
    .where(and(eq(captureEpisodes.accountId, accountId), eq(captureEpisodes.status, 'traced'), gte(captureEpisodes.startAt, since)))
    .orderBy(asc(captureEpisodes.startAt));
  const runs = await runsOf(episodes);

  // 1–2. Cluster the signature groups of finished runs.
  const abandoned = runs.filter((r) => r.outcomeStatus === 'abandoned');
  const groups = groupRuns(runs.filter((r) => r.outcomeStatus !== 'abandoned'));
  const sim = groups.map((a) => groups.map((b) => similarity(a, b)));
  const { clusters, between } = agglomerate(sim, groups.map((g) => g.members), MERGE_AT);
  let mined = clusters.map((idx) => describeCluster(idx.flatMap((i) => groups[i]!.runs), now));
  let costUsd = 0;
  const spend = async (run: (usage: ReturnType<typeof emptyUsage>) => Promise<void>) => {
    if (!(await withinBudget(accountId))) throw new CaptureBudgetExceeded();
    const usage = emptyUsage();
    try {
      await run(usage);
    } finally {
      await recordSpend(accountId, usage.cost_usd, usage.requests);
      costUsd += usage.cost_usd;
    }
  };

  // Borderline pairs of real clusters: one model call judges them; the same ones merge.
  const big = mined.map((m, i) => ({ m, i })).filter(({ m }) => m.runs.length >= MIN_RUNS);
  const borderline: Array<[number, number, number]> = [];
  for (const a of big) for (const b of big) if (a.i < b.i && between(a.i, b.i) >= ASK_FROM) borderline.push([a.i, b.i, between(a.i, b.i)]);
  borderline.sort((x, y) => y[2] - x[2]);
  // A pair whose runs mostly belonged to one workflow before was judged the same then: merge it
  // without asking again (a model outage must not split a workflow the last run held together).
  const before = (m: MinedWorkflow) => {
    const votes = new Map<string, number>();
    for (const r of m.runs) if (r.workflowId) votes.set(r.workflowId, (votes.get(r.workflowId) ?? 0) + 1);
    const [id, n] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    return id && n >= m.runs.length * 0.5 ? id : null;
  };
  const remembered = borderline.filter(([i, j]) => before(mined[i]!) && before(mined[i]!) === before(mined[j]!));
  const asked = borderline.filter((pair) => !remembered.includes(pair)).slice(0, MAX_JUDGEMENTS);
  if (asked.length || remembered.length) {
    let same: number[] = [];
    try {
      if (asked.length) {
        await spend(async (usage) => {
          same = (await caller.call(judgeZod, judgePrompt(asked.map(([i, j]) => [mined[i]!, mined[j]!])), [], usage)).same;
        });
      }
    } catch (error) {
      // Without the judgement a run would write workflows split apart, and a person would review
      // them: fail instead, so the job retries with backoff (6 attempts) and the last result stays.
      logger.warn('[capture] mining equivalence judgement failed; the run retries', { accountId, error: String(error) });
      throw error;
    }
    const parent = mined.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (const pair of [...remembered, ...same.map((n) => asked[n - 1]).filter((p): p is [number, number, number] => !!p)]) {
      parent[find(pair[1])] = find(pair[0]);
    }
    const merged = new Map<number, Run[]>();
    for (const [i, m] of mined.entries()) merged.set(find(i), [...(merged.get(find(i)) ?? []), ...m.runs]);
    if (merged.size < mined.length) mined = [...merged.values()].map((rs) => describeCluster(rs, now));
  }

  // 3b. A workflow needs MIN_RUNS finished runs. Abandoned runs, and the runs of smaller clusters,
  // join the workflow they started (its canonical path holds most of their steps in order); else none.
  const real = mined.filter((m) => m.runs.length >= MIN_RUNS);
  const strays = mined.filter((m) => m.runs.length < MIN_RUNS).flatMap((m) => m.runs);
  const joins = new Map<number, Run[]>();
  const canon = real.map((m) => ({ group: workflowGroup(m) }));
  for (const g of groupRuns([...abandoned, ...strays])) {
    const at = startedWorkflow(g, canon);
    if (at >= 0) joins.set(at, [...(joins.get(at) ?? []), ...g.runs]);
  }
  const workflows = real.map((m, i) => (joins.has(i) ? describeCluster([...m.runs, ...joins.get(i)!], now) : m));

  // 3–5. Keep identities, name what is new or changed, write.
  const existing = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, accountId));
  const byId = new Map(existing.map((w) => [w.workflowId, w]));
  const claimed = new Set<string>();
  const plan = workflows
    .sort((a, b) => b.runs.length - a.runs.length)
    .map((m) => {
      const votes = new Map<string, number>();
      for (const r of m.runs) if (r.workflowId && byId.has(r.workflowId)) votes.set(r.workflowId, (votes.get(r.workflowId) ?? 0) + 1);
      const [id, n] = [...votes].filter(([wid]) => !claimed.has(wid)).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      const keep = id && n >= m.runs.length * 0.5 ? byId.get(id)! : null;
      if (keep) claimed.add(keep.workflowId);
      const changed = !keep || Math.abs(keep.runsTotal - m.runs.length) > keep.runsTotal * 0.2 || keep.signature !== m.signature;
      return { m, keep, changed };
    });
  const names = new Map<MinedWorkflow, z.output<typeof nameZod>>();
  for (const p of plan) {
    const unnamed = p.keep?.name === 'Unnamed workflow' || (p.keep?.status === 'detected' && p.keep.model === null);
    if (p.keep && p.keep.status !== 'detected') continue;
    if (p.keep && !unnamed && !p.changed && !opts.rename) continue;
    try {
      await spend(async (usage) => {
        names.set(p.m, await caller.call(nameZod, namePrompt(p.m), [], usage));
      });
    } catch (error) {
      // Unnamed for now: a new workflow is written as "Unnamed workflow" and named on the next run.
      if (error instanceof CaptureBudgetExceeded) throw error;
      logger.warn('[capture] mining naming failed', { accountId, error: String(error) });
    }
  }
  const perWorkflowCost = plan.length ? costUsd / plan.length : 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-mine:${accountId}`}, 0))`);
    // Free the signatures first: a re-mine may move a signature between rows.
    await tx.update(captureWorkflows).set({ signature: sql`'old:' || ${captureWorkflows.workflowId}` }).where(eq(captureWorkflows.accountId, accountId));
    const stale = existing.filter((w) => !claimed.has(w.workflowId) && w.status === 'detected').map((w) => w.workflowId);
    if (stale.length) await tx.delete(captureWorkflows).where(inArray(captureWorkflows.workflowId, stale));
    await tx
      .update(captureEpisodes)
      .set({ workflowId: null, variantKey: null })
      .where(and(eq(captureEpisodes.accountId, accountId), sql`${captureEpisodes.workflowId} IS NOT NULL`));
    const used = new Set<string>();
    // Names are unique per account: a repeat gets " (2)", " (3)"…, after the names kept rows hold.
    const taken = new Set(existing.filter((w) => !claimed.has(w.workflowId)).map((w) => w.name.toLowerCase()));
    const uniqueName = (name: string) => {
      let out = name;
      for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${name} (${k})`;
      taken.add(out.toLowerCase());
      return out;
    };
    for (const p of plan) {
      const named = names.get(p.m);
      const keepNames = p.keep && !named;
      // Names: the model's, else the kept workflow's (same differing steps), else the derived ones.
      const usedNames = new Set<string>();
      const variants = p.m.variants.map((v) => {
        const n = named?.variants.find((x) => x.key === v.key);
        const old = (p.keep?.variants as unknown as WorkflowVariant[] | undefined)?.find((x) => x.key === v.key && x.differs.join() === v.differs.join() && x.name !== 'Canonical path');
        // Names are distinct within a workflow: a repeat falls back to the derived name, then a key suffix.
        let name = n?.name?.trim() || old?.name || v.name;
        if (usedNames.has(name.toLowerCase())) name = usedNames.has(v.name.toLowerCase()) ? `${name} (${v.key})` : v.name;
        usedNames.add(name.toLowerCase());
        return {
          ...v,
          name,
          note: n?.note?.trim() || old?.note || v.note,
          question: v.key === 'A' ? undefined : n?.question?.trim() || old?.question || v.question,
        };
      });
      const steps = p.m.steps.map((s) => {
        if (!s.decision) return s;
        const q = variants.find((x) => x.key === s.decision!.variant)?.question;
        return { ...s, decision: { ...s.decision, question: q ?? s.decision.question } };
      });
      let signature = p.m.signature;
      for (let k = 2; used.has(signature); k++) signature = `${p.m.signature}#${k}`;
      used.add(signature);
      const values = {
        accountId,
        name: uniqueName(keepNames ? p.keep!.name : (named?.name?.trim() || 'Unnamed workflow').slice(0, 190)),
        goal: keepNames ? p.keep!.goal : (named?.goal ?? null),
        outcome: keepNames ? p.keep!.outcome : (named?.outcome ?? null),
        signature,
        steps: steps as unknown as Record<string, unknown>[],
        variants: variants as unknown as Record<string, unknown>[],
        apps: p.m.apps,
        runsTotal: p.m.stats.runsTotal,
        runsPerWeek: p.m.stats.runsPerWeek.toFixed(2),
        durationP50S: Math.round(p.m.stats.p50),
        durationP90S: Math.round(p.m.stats.p90),
        peopleCount: p.m.stats.people,
        successRate: p.m.stats.successRate === null ? null : p.m.stats.successRate.toFixed(4),
        determinism: p.m.stats.determinism.toFixed(4),
        automationHoursPerWeek: p.m.stats.hoursPerWeek.toFixed(2),
        firstSeenAt: p.m.stats.first,
        lastSeenAt: p.m.stats.last,
        model: caller.model,
        updatedAt: new Date(),
      };
      let workflowId: string;
      if (p.keep) {
        // A reviewed or exported workflow keeps its name and goal; its stats and steps follow the data.
        await tx.update(captureWorkflows).set(values).where(eq(captureWorkflows.workflowId, p.keep.workflowId));
        if (named) await tx.update(captureWorkflows).set({ costUsd: sql`${captureWorkflows.costUsd} + ${perWorkflowCost.toFixed(6)}::numeric` }).where(eq(captureWorkflows.workflowId, p.keep.workflowId));
        workflowId = p.keep.workflowId;
      } else {
        const [row] = await tx.insert(captureWorkflows).values({ ...values, costUsd: perWorkflowCost.toFixed(6) }).returning({ workflowId: captureWorkflows.workflowId });
        workflowId = row!.workflowId;
      }
      for (const path of p.m.paths) {
        await tx
          .update(captureEpisodes)
          .set({ workflowId, variantKey: path.key })
          .where(inArray(captureEpisodes.episodeId, path.runs.map((r) => r.episodeId)));
      }
      const onPath = new Set(p.m.paths.flatMap((x) => x.runs.map((r) => r.episodeId)));
      const off = p.m.runs.filter((r) => !onPath.has(r.episodeId)).map((r) => r.episodeId);
      if (off.length) await tx.update(captureEpisodes).set({ workflowId }).where(inArray(captureEpisodes.episodeId, off));
    }
    // A reviewed or exported workflow nothing joined keeps its old signature row; give it back its own.
    for (const w of existing.filter((x) => !claimed.has(x.workflowId) && x.status !== 'detected')) {
      let signature = w.signature.startsWith('old:') ? w.workflowId : w.signature;
      if (used.has(signature)) signature = `${signature}#${w.workflowId}`;
      await tx.update(captureWorkflows).set({ signature }).where(eq(captureWorkflows.workflowId, w.workflowId));
    }
  });
  return { workflows: plan.length, costUsd };
}
