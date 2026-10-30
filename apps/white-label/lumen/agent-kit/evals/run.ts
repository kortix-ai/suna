// The eval runner: drives Lumen's real engine (the same run mutations the UI
// uses, as the firm owner) against real Kortix sessions, then scores Lumen's
// rows with score.ts. Writes output/legal/evals/<timestamp>.{json,md} (gitignored).
//   pnpm --filter @kortix/white-label-lumen eval -- [--suite extraction,citations,qa,refusal] [--firm <id>] [--runs <runId,...>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminClient } from '../../scripts/convex-admin';
import { seed } from '../../scripts/seed-demo';
import { type AnswerOut, type Case, type CellOut, scoreAnswers, scoreCitations, scoreExtraction } from './score';

const HERE = import.meta.dir;
const OUT = join(HERE, '..', '..', '..', '..', '..', 'output', 'legal', 'evals');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const suites = new Set((arg('suite') ?? 'extraction,citations,qa,refusal').split(','));
const key = JSON.parse(readFileSync(join(HERE, 'expected.json'), 'utf8'));
const cases: Case[] = readFileSync(join(HERE, 'cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const KIT = JSON.parse(readFileSync(join(HERE, '..', 'kit.json'), 'utf8'));

type Result = { runId: string; kind: string; status: string; question: string | null; startedAt: number | null; finishedAt: number | null;
  attempts: Array<{ repair: number; nudge: number; relaunch: number }>; cells: CellOut[];
  answer: { addressed: boolean; answerMd: string; citations: AnswerOut['citations'] } | null };

const c = adminClient();
const t0 = Date.now();
let runIds = arg('runs')?.split(',') ?? [];
const caseOfRun = new Map<string, Case>();
if (!runIds.length) {
  const { firm, matters } = await seed(arg('firm'));
  console.log(`firm ${firm._id}; dataset seeded`);
  if (suites.has('extraction') || suites.has('citations')) {
    for (const m of Object.values(matters)) runIds.push((await c.mutation<{ runId: string }>('runs:startReviewAsOwner', { matterId: m.matterId })).runId);
  }
  for (const k of cases) {
    if (!suites.has(k.suite)) continue;
    const matterId = matters[(k as Case & { matter: string }).matter].matterId;
    const runId = await c.mutation<string>('runs:askAsOwner', { matterId, question: k.question });
    caseOfRun.set(runId, k);
    runIds.push(runId);
  }
  writeFileSync(join(OUT_DIR(), 'last-runs.json'), JSON.stringify({ runIds, cases: Object.fromEntries([...caseOfRun].map(([r, k]) => [r, k.id])) }));
} else {
  const saved = JSON.parse(readFileSync(join(OUT_DIR(), 'last-runs.json'), 'utf8'));
  for (const [r, id] of Object.entries(saved.cases as Record<string, string>)) caseOfRun.set(r, cases.find((k) => k.id === id)!);
}
console.log(`${runIds.length} runs`);

function OUT_DIR() {
  mkdirSync(OUT, { recursive: true });
  return OUT;
}

let results: Result[] = [];
for (;;) {
  results = await c.query<Result[]>('seed:results', { runIds });
  const open = results.filter((r) => !['succeeded', 'partial', 'failed', 'canceled'].includes(r.status));
  process.stdout.write(`\r${((Date.now() - t0) / 1000).toFixed(0)} s: ${results.length - open.length}/${results.length} runs finished   `);
  if (!open.length) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log();

const cells = results.flatMap((r) => r.cells);
const answers: AnswerOut[] = results
  .filter((r) => r.answer && caseOfRun.get(r.runId))
  .map((r) => ({ id: caseOfRun.get(r.runId)!.id, suite: caseOfRun.get(r.runId)!.suite, ...r.answer! }));
const allCitations = [...cells.flatMap((x) => x.citations), ...answers.flatMap((a) => a.citations)];
const extraction = cells.length ? scoreExtraction(cells, key.documents) : null;
const citations = scoreCitations(allCitations);
const qa = answers.length ? scoreAnswers(cases.filter((k) => [...caseOfRun.values()].includes(k)), answers) : null;
const durations = results.filter((r) => r.startedAt && r.finishedAt).map((r) => (r.finishedAt! - r.startedAt!) / 1000);
const report = {
  at: new Date().toISOString(), kit: `${KIT.version} (${KIT.hash})`, wallSeconds: Math.round((Date.now() - t0) / 1000),
  runs: results.map((r) => ({ runId: r.runId, kind: r.kind, status: r.status, seconds: r.startedAt && r.finishedAt ? Math.round((r.finishedAt - r.startedAt) / 1000) : null, attempts: r.attempts })),
  runSeconds: { min: Math.round(Math.min(...durations)), max: Math.round(Math.max(...durations)) },
  extraction, citations, qa,
};
const stamp = report.at.replace(/[:.]/g, '-');
writeFileSync(join(OUT_DIR(), `${stamp}.json`), JSON.stringify(report, null, 2));
const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const md = [
  `| Suite | Metric | Result |`, `|---|---|---|`,
  ...(extraction ? [
    `| extraction | cell accuracy | ${extraction.correct}/${extraction.cells} = ${pct(extraction.accuracy)} |`,
    `| extraction | planted absences found | ${extraction.absent.correct}/${extraction.absent.total} |`,
    `| extraction | correct values with a source-checked citation | ${extraction.citedCorrectValues.cited}/${extraction.citedCorrectValues.total} |`,
  ] : []),
  `| citations | raw precision (quote at the cited anchor) | ${citations.verified}/${citations.total} = ${pct(citations.rawPrecision)} |`,
  `| citations | in the source (verified + relocated) | ${citations.verified + citations.relocated}/${citations.total} = ${pct(citations.inSourceRate)} |`,
  `| citations | shown as support and in the source | ${pct(citations.shownAsSupportedPrecision)} (unverified ones are marked, never shown as support) |`,
  ...(qa ? [
    `| qa | fact recall | ${pct(qa.qa.factRecall)} of ${qa.qa.cases} |`,
    `| qa | cited-document recall | ${pct(qa.qa.citedDocRecall)} of ${qa.qa.cases} |`,
    `| refusal | correct refusals | ${qa.refusal.passed}/${qa.refusal.cases} |`,
  ] : []),
].join('\n');
const failures = [...(extraction?.failures ?? []), ...(qa?.failures ?? [])];
writeFileSync(join(OUT_DIR(), `${stamp}.md`), `${md}\n\nFailures:\n${failures.map((f) => `- ${f}`).join('\n') || '- none'}\n`);
console.log(md);
console.log(`\nkit ${report.kit}; ${results.length} runs; run time ${report.runSeconds.min}-${report.runSeconds.max} s; wall ${report.wallSeconds} s`);
console.log(`failures (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
console.log(`report: ${join(OUT_DIR(), `${stamp}.json`)}`);
