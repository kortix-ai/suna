/**
 * L3 workflow mining, one job per account (`capture.mine`): nightly, and 10
 * minutes after new episodes are traced. The gateway has no embedding model,
 * so similarity is structural and lexical:
 *
 *   sim(a, b) = 0.5 · step-sequence similarity (edit distance over verb@app)
 *             + 0.3 · Jaccard of the step objects' words
 *             + 0.2 · Jaccard of the labels' words
 *
 *   1. traced procedural episodes of the last MINE_DAYS, grouped by signature
 *   2. average-linkage clustering of the signature groups down to MERGE_AT;
 *      cluster pairs between ASK_FROM and MERGE_AT go to one model call that
 *      judges which are the same procedure
 *   3. per cluster with MIN_RUNS runs: paths (sub-clusters at PATH_AT), the
 *      canonical procedure (largest path), variants (paths with VARIANT_SHARE),
 *      decision points (where a variant leaves the canonical path), stats,
 *      and the automation score = runs/week × p50 hours × determinism
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
  const groups = groupRuns(runs);
  const sim = groups.map((a) => groups.map((b) => sequenceSimilarity(a.tokens, b.tokens)));
  const sub = agglomerate(sim, groups.map((g) => g.members), PATH_AT).clusters
    .map((idx) => {
      const rs = idx.flatMap((i) => groups[i]!.runs);
      const mode = idx.map((i) => groups[i]!).sort((a, b) => b.members - a.members)[0]!;
      const representative = [...mode.runs].sort((a, b) => b.start.getTime() - a.start.getTime())[0]!;
      return { runs: rs, tokens: mode.tokens, representative };
    })
    .sort((a, b) => b.runs.length - a.runs.length);
  const minRuns = Math.max(2, Math.ceil(VARIANT_SHARE * runs.length));
  const named = sub.filter((p, i) => i === 0 || p.runs.length >= minRuns).slice(0, 5);
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
  const variants: WorkflowVariant[] = paths.map((p) => ({
    key: p.key,
    name: p.key === 'A' ? 'Canonical path' : `Variant ${p.key}`,
    runs: p.runs.length,
    share: Math.round((p.runs.length / runs.length) * 1000) / 1000,
    steps_count: p.tokens.length,
    differs: p.key === 'A' ? [] : differingSteps(canonical.tokens, p.tokens),
    note: '',
  }));
  for (const v of variants.slice(1)) {
    const at = Math.max(0, Math.min(steps.length - 1, v.differs[0]! - 2));
    if (!steps[at]!.decision) steps[at]!.decision = { question: `the case calls for variant ${v.key}`, variant: v.key, share: v.share };
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
    apps: [...new Set(runs.flatMap((r) => r.steps.map((s) => s.app)).filter((a): a is string => !!a))],
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

function namePrompt(w: MinedWorkflow): string {
  const samples = w.runs.slice(-6).map((r) => `- ${r.label}: ${r.goal ?? ''} → ${r.outcome ?? ''}`).join('\n');
  const paths = w.paths.map((p) => `${p.key} (${p.runs.length} runs): ${describeRun(p.representative)}`).join('\n');
  return `These are runs of one procedure people repeat at work, mined from their recorded activity.

Sample runs (label: goal → outcome):
${samples}

Paths (A = the most common; others are variants):
${paths}

Name the procedure and its variants. "name": 3-7 words, imperative, generic (e.g. "Refund a damaged-order claim"). "goal" and "outcome": one sentence each. For each variant except A: "name" (2-5 words, the case it handles, e.g. "Outside the return window"), "note" (one sentence: what differs), "question" (the decision that leads to it, phrased as a condition, e.g. "the order is older than 30 days"). No literal values (names, numbers, emails).

Return ONLY JSON: {"name":"…","goal":"…","outcome":"…","variants":[{"key":"B","name":"…","note":"…","question":"…"}]}`;
}

function judgePrompt(pairs: Array<[MinedWorkflow, MinedWorkflow]>): string {
  const lines = pairs.map(([a, b], i) => `${i + 1}. X: ${describeRun(a.paths[0]!.representative)}\n   Y: ${describeRun(b.paths[0]!.representative)}`).join('\n');
  return `Each pair shows two recorded procedures. They are the same procedure when they pursue the same goal on the same kind of item, even if some steps differ (a variant of it). They differ when the goal differs.

${lines}

Return ONLY JSON: {"same":[<numbers of the pairs that are the same procedure>]}`;
}

export const MINE_QUEUE = 'capture.mine';

/** Re-mine one account. Returns how many workflows it holds after the run, and the model spend. */
export async function mineAccount(accountId: string, caller?: Caller, now = Date.now()): Promise<{ workflows: number; costUsd: number }> {
  if (!caller) {
    const [owner] = await db
      .select({ userId: captureEpisodes.userId })
      .from(captureEpisodes)
      .where(eq(captureEpisodes.accountId, accountId))
      .limit(1);
    if (!owner) return { workflows: 0, costUsd: 0 };
    return withCaptureGateway({ accountId, userId: owner.userId }, (gateway) =>
      mineAccount(accountId, gatewayCaller(gateway.authorization, config.KORTIX_CAPTURE_MODEL, gateway.url), now),
    );
  }
  const since = new Date(now - MINE_DAYS * 86_400_000);
  const episodes = await db
    .select()
    .from(captureEpisodes)
    .where(and(eq(captureEpisodes.accountId, accountId), eq(captureEpisodes.status, 'traced'), gte(captureEpisodes.startAt, since)))
    .orderBy(asc(captureEpisodes.startAt));
  const stepRows = episodes.length
    ? await db
        .select()
        .from(captureEpisodeSteps)
        .where(inArray(captureEpisodeSteps.episodeId, episodes.map((e) => e.episodeId)))
        .orderBy(asc(captureEpisodeSteps.episodeId), asc(captureEpisodeSteps.index))
    : [];
  const stepsOf = new Map<string, Run['steps']>();
  for (const s of stepRows) stepsOf.set(s.episodeId, [...(stepsOf.get(s.episodeId) ?? []), { verb: s.verb, app: s.app, object: s.object, params: s.params, variables: s.variables }]);
  const runs: Run[] = episodes
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

  // 1–2. Cluster the signature groups.
  const groups = groupRuns(runs);
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
  const real = mined.map((m, i) => ({ m, i })).filter(({ m }) => m.runs.length >= MIN_RUNS);
  const borderline: Array<[number, number, number]> = [];
  for (const a of real) for (const b of real) if (a.i < b.i && between(a.i, b.i) >= ASK_FROM) borderline.push([a.i, b.i, between(a.i, b.i)]);
  borderline.sort((x, y) => y[2] - x[2]);
  const asked = borderline.slice(0, MAX_JUDGEMENTS);
  if (asked.length) {
    let same: number[] = [];
    await spend(async (usage) => {
      same = (await caller.call(judgeZod, judgePrompt(asked.map(([i, j]) => [mined[i]!, mined[j]!])), [], usage)).same;
    });
    const parent = mined.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (const n of same) {
      const pair = asked[n - 1];
      if (pair) parent[find(pair[1])] = find(pair[0]);
    }
    const merged = new Map<number, Run[]>();
    for (const [i, m] of mined.entries()) merged.set(find(i), [...(merged.get(find(i)) ?? []), ...m.runs]);
    if (merged.size < mined.length) mined = [...merged.values()].map((rs) => describeCluster(rs, now));
  }

  // 3–5. Keep identities, name what is new or changed, write.
  const workflows = mined.filter((m) => m.runs.length >= MIN_RUNS);
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
    if (p.keep && (!p.changed || p.keep.status !== 'detected')) continue;
    await spend(async (usage) => {
      names.set(p.m, await caller.call(nameZod, namePrompt(p.m), [], usage));
    });
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
    for (const p of plan) {
      const named = names.get(p.m);
      const keepNames = p.keep && !named;
      const variants = p.m.variants.map((v) => {
        const n = named?.variants.find((x) => x.key === v.key);
        const old = (p.keep?.variants as unknown as WorkflowVariant[] | undefined)?.find((x) => x.key === v.key);
        return { ...v, name: v.key === 'A' ? 'Canonical path' : n?.name ?? old?.name ?? v.name, note: n?.note ?? old?.note ?? v.note };
      });
      const steps = p.m.steps.map((s) => {
        if (!s.decision) return s;
        const q = named?.variants.find((x) => x.key === s.decision!.variant)?.question;
        return { ...s, decision: { ...s.decision, question: q ?? s.decision.question } };
      });
      let signature = p.m.signature;
      for (let k = 2; used.has(signature); k++) signature = `${p.m.signature}#${k}`;
      used.add(signature);
      const values = {
        accountId,
        name: keepNames ? p.keep!.name : (named?.name ?? 'Unnamed workflow').slice(0, 200),
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
