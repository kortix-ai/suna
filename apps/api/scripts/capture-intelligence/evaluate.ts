/**
 * Score Capture Intelligence against the eval's ground truth. Reads the
 * account's episodes, steps and workflows through the real bulk export
 * (POST /capture/exports → poll → signed download) as its admin.
 *
 *   CAPTURE_EVAL_OUT=output/capture-eval SUPABASE_URL=… SUPABASE_ANON_KEY=… \
 *   bun apps/api/scripts/capture-intelligence/evaluate.ts
 *
 * Writes `$CAPTURE_EVAL_OUT/report.json` and prints the summary.
 */
import { join } from 'node:path';
import { WORKFLOWS, type TruthRun } from './synthetic';

// The same measure as mining.ts, inlined: importing the API module would load its config.
function sequenceSimilarity<T>(a: T[], b: T[]): number {
  if (!a.length && !b.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

const OUT = process.env.CAPTURE_EVAL_OUT ?? 'output/capture-eval';
const truthFile = await Bun.file(join(OUT, 'truth.json')).json();
const API: string = truthFile.api;
const accountId: string = truthFile.accountId;
const truth: TruthRun[] = truthFile.truth;
const people: Record<string, { userId: string; deviceId: string }> = truthFile.people;

const signIn: any = await (
  await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ email: truthFile.owner.email, password: truthFile.password }),
  })
).json();
const auth = { authorization: `Bearer ${signIn.access_token}`, 'content-type': 'application/json' };

// ── Read everything through the export ──────────────────────────────────────
const created: any = await (await fetch(`${API}/accounts/${accountId}/capture/exports`, { method: 'POST', headers: auth, body: JSON.stringify({ format: 'jsonl' }) })).json();
let exp: any = created;
for (let i = 0; i < 120 && exp.status !== 'done' && exp.status !== 'failed'; i++) {
  await Bun.sleep(1000);
  exp = await (await fetch(`${API}/accounts/${accountId}/capture/exports/${created.export_id}`, { headers: auth })).json();
}
if (exp.status !== 'done') throw new Error(`export ${created.export_id}: ${exp.status} ${exp.error ?? ''}`);
const lines = (await (await fetch(exp.download.url)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const workflows = lines.filter((l) => l.type === 'workflow');
const episodes = lines.filter((l) => l.type === 'episode' && l.source === 'detected');
const steps = new Map<string, any[]>();
for (const s of lines.filter((l) => l.type === 'step')) steps.set(s.episode_id, [...(steps.get(s.episode_id) ?? []), s]);

// ── L1: match each truth run to the episode on its device that overlaps it most ──
const tok = (verb: string, app: string | null) => `${verb.toLowerCase()}@${(app ?? '').toLowerCase()}`;
const byDevice = new Map<string, any[]>();
for (const e of episodes) byDevice.set(e.device_id, [...(byDevice.get(e.device_id) ?? []), e]);
const iou = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / (Math.max(a1, b1) - Math.min(a0, b0));
const matched = truth.map((run) => {
  const candidates = byDevice.get(people[run.person]!.deviceId) ?? [];
  let best: any = null;
  let score = 0;
  for (const e of candidates) {
    const v = iou(run.start, run.end, Date.parse(e.start_at), Date.parse(e.end_at));
    if (v > score) [best, score] = [e, v];
  }
  return { run, episode: score >= 0.5 ? best : null, iou: score };
});
const hits = matched.filter((m) => m.episode);
const traced = episodes.filter((e) => e.status === 'traced');
const tracedHit = new Set(hits.map((m) => m.episode.episode_id));
const ratio = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

// ── L2: step alignment of matched episodes ──────────────────────────────────
const alignment = hits.map((m) => {
  const predicted = (steps.get(m.episode.episode_id) ?? []).sort((a, b) => a.index - b.index);
  const truthTokens = m.run.path.map((p) => p.toLowerCase());
  const predTokens = predicted.map((s) => tok(s.verb, s.app));
  return {
    full: sequenceSimilarity(truthTokens, predTokens),
    apps: sequenceSimilarity(truthTokens.map((t) => t.split('@')[1]), predTokens.map((t) => t.split('@')[1])),
    exact: truthTokens.join(' ') === predTokens.join(' '),
    variables: predicted.some((s) => s.variables?.length),
  };
});
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);

// ── L3: workflow recovery ───────────────────────────────────────────────────
const truthOf = new Map(hits.map((m) => [m.episode.episode_id, m.run]));
const perWorkflow = workflows.map((w) => {
  const members = episodes.filter((e) => e.workflow_id === w.workflow_id);
  const labelled = members.map((e) => truthOf.get(e.episode_id)).filter(Boolean) as TruthRun[];
  const votes = new Map<string, number>();
  for (const r of labelled) votes.set(r.workflow, (votes.get(r.workflow) ?? 0) + 1);
  const [major, n] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? ['(none)', 0];
  // Variant recovery: which truth variant each mined path holds most of.
  const paths = new Map<string, Map<string, number>>();
  for (const e of members) {
    const r = truthOf.get(e.episode_id);
    if (!r || !e.variant_key) continue;
    const m = paths.get(e.variant_key) ?? new Map();
    m.set(r.variant, (m.get(r.variant) ?? 0) + 1);
    paths.set(e.variant_key, m);
  }
  const pathMajority = Object.fromEntries([...paths].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0]![0]]));
  const def = WORKFLOWS.find((x) => x.id === major);
  const canonical = (w.steps as any[]).map((s) => tok(s.verb, s.app));
  return {
    workflow_id: w.workflow_id,
    name: w.name,
    runs: w.runs_total,
    truth: major,
    purity: ratio(n, members.length),
    labelled: labelled.length,
    paths: pathMajority,
    canonical_similarity: def ? Math.round(sequenceSimilarity(def.steps.map((s) => tok(s.verb, s.app)), canonical) * 1000) / 1000 : null,
    runs_per_week: w.runs_per_week,
    p50_s: w.duration_p50_s,
    people: w.people_count,
    determinism: w.determinism,
    hours_per_week: w.automation_hours_per_week,
  };
});
const best = new Map<string, (typeof perWorkflow)[number]>();
for (const w of perWorkflow) if ((w.purity ?? 0) >= 0.8 && (!best.has(w.truth) || best.get(w.truth)!.labelled < w.labelled)) best.set(w.truth, w);
const truthIds = [...new Set(truth.map((r) => r.workflow))];
// Per truth workflow: of the runs in its best mined workflow, how many are its own (precision);
// of its runs found as episodes, how many landed there (recall).
const perTruth = Object.fromEntries(
  truthIds.map((id) => {
    const w = best.get(id);
    const own = hits.filter((m) => m.run.workflow === id);
    if (!w) return [id, { workflow: null, precision: 0, recall: 0, runs: own.length }];
    const inW = hits.filter((m) => m.episode.workflow_id === w.workflow_id);
    return [id, { workflow: w.name, precision: ratio(inW.filter((m) => m.run.workflow === id).length, inW.length), recall: ratio(own.filter((m) => m.episode.workflow_id === w.workflow_id).length, own.length), runs: own.length }];
  }),
);
const variantTruth = truthIds.flatMap((id) => {
  const counts = new Map<string, number>();
  for (const r of truth.filter((x) => x.workflow === id && !x.abandoned)) counts.set(r.variant, (counts.get(r.variant) ?? 0) + 1);
  return [...counts].filter(([, c]) => c >= 3).map(([v]) => ({ workflow: id, variant: v }));
});
const variantsFound = variantTruth.filter((v) => Object.values(best.get(v.workflow)?.paths ?? {}).includes(v.variant));

// Pairwise run clustering over matched, traced runs: same truth workflow vs same mined workflow.
const pairs = hits.filter((m) => m.episode.status === 'traced');
let tp = 0;
let fp = 0;
let fn = 0;
for (let i = 0; i < pairs.length; i++) {
  for (let j = i + 1; j < pairs.length; j++) {
    const same = pairs[i]!.run.workflow === pairs[j]!.run.workflow;
    const together = !!pairs[i]!.episode.workflow_id && pairs[i]!.episode.workflow_id === pairs[j]!.episode.workflow_id;
    if (same && together) tp++;
    else if (together) fp++;
    else if (same) fn++;
  }
}

const report = {
  account: accountId,
  data: { people: Object.keys(people).length, workdays: new Set(truth.map((r) => new Date(r.start).toISOString().slice(0, 10))).size, truth_runs: truth.length, truth_workflows: truthIds.length, truth_variants_3plus: variantTruth.length },
  episodes: {
    detected: episodes.length,
    traced: traced.length,
    run_recall: ratio(hits.length, truth.length),
    traced_precision: ratio(traced.filter((e) => tracedHit.has(e.episode_id)).length, traced.length),
    mean_iou_of_hits: mean(hits.map((m) => m.iou)),
    interrupted_recall: ratio(hits.filter((m) => m.run.interrupted).length, truth.filter((r) => r.interrupted).length),
    abandoned_flagged: ratio(hits.filter((m) => m.run.abandoned && m.episode.outcome_status === 'abandoned').length, hits.filter((m) => m.run.abandoned).length),
  },
  steps: {
    verb_app_similarity: mean(alignment.map((a) => a.full)),
    app_sequence_similarity: mean(alignment.map((a) => a.apps)),
    exact_path_rate: ratio(alignment.filter((a) => a.exact).length, alignment.length),
    with_variables: ratio(alignment.filter((a) => a.variables).length, alignment.length),
  },
  workflows: {
    mined: workflows.length,
    precision: ratio(best.size, workflows.length),
    recall: ratio(best.size, truthIds.length),
    variant_recall: ratio(variantsFound.length, variantTruth.length),
    pairwise: { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn) },
    canonical_similarity: mean([...best.values()].map((w) => w.canonical_similarity ?? 0)),
    per_truth_workflow: perTruth,
    list: perWorkflow.sort((a, b) => b.runs - a.runs),
  },
  model_cost_usd: { episodes: Math.round(episodes.reduce((s, e) => s + Number(e.cost_usd || 0), 0) * 1e4) / 1e4 },
};
await Bun.write(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const { list, ...summary } = report.workflows;
console.log(JSON.stringify({ ...report, workflows: summary }, null, 2));
for (const w of list) console.log(`${String(w.runs).padStart(4)} runs  purity ${w.purity}  truth ${w.truth.padEnd(9)} paths ${JSON.stringify(w.paths)}  ${w.hours_per_week} h/wk  ${w.name}`);
