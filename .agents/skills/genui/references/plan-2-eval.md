# Generative UI — plan 2: Phase 0 model evaluation (go/no-go)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, before any product surface ships, whether the 4 chosen models write valid OpenUI blocks when they should and prose when they should not, using the real prompt and validator from plan-1.

**Architecture:** A Bun script in the genui skill sends 46 synthetic cases to each model through the Kortix LLM gateway (`POST /v1/llm/chat/completions`), scores every reply with the SDK's own `splitGenui` + `parseGenui`, and appends a summary table to `references/eval-results.md`. Raw replies stay in the gitignored `output/genui-eval/`.

**Tech Stack:** Bun 1.3, `@kortix/sdk/genui` (source import), the Kortix LLM gateway.

**Spec:** `.agents/skills/genui/references/spec.md` §11 Phase 0, §13 Q3. Master plan: `plan.md` (delta D7).

**Provenance:** `score.ts` and its 5 tests ran green, and `eval.ts` typechecked, before this plan was written. The network run has not happened: it is this plan's job.

## Global Constraints

See `plan.md`. Specific to this plan:
- Models: `deepseek/deepseek-v4-pro`, `openai/gpt-5.5`, `openai/gpt-6-sol`, `openai/gpt-6-astra` (verified present in `packages/llm-catalog/src/catalog.generated.json`).
- Cases are synthetic. No customer data, no real company names.
- The script lives in `.agents/skills/genui/scripts/` (spec Q3): `tests/` forbids ad hoc harnesses.

## Review Focus

- A model that wraps the whole reply in one ```` ```openui ```` block with no prose → counts as a valid block but breaks prompt rule 1. The case list includes `ui-stats-and-tip`; check its raw reply by hand in Task 2 Step 4.

## Go/no-go gate (per model)

| Measure | Pass |
|---|---|
| Valid blocks ÷ blocks written | ≥ 97% |
| Prose cases that got a block (overuse) | ≤ 10% |
| UI cases that got no block (underuse) | ≤ 25% |
| Forbidden components (a chart or map with no data given) | ≤ 1 |

A model that fails the gate does not block the feature by itself. Report it; Jay decides between (a) a prompt change and a re-run, (b) shipping with that model excluded once per-model gating exists (spec R-P1-3, not built in v1), or (c) stopping.

---

### Task 1: Scoring and runner

**Files:**
- Create: `.agents/skills/genui/scripts/score.ts`, `.agents/skills/genui/scripts/score.test.ts`, `.agents/skills/genui/scripts/eval.ts`, `.agents/skills/genui/scripts/eval-prompts.json`
- Create: `.agents/skills/genui/references/eval-results.md`

**Interfaces:**
- Consumes: `splitGenui`, `parseGenui`, `buildGenuiPrompt`, `GENUI_PROMPT_VERSION` from `packages/sdk/src/genui/index.ts` (plan-1).
- Produces: `scoreReply(case, reply): CaseScore`, `summarize(model, cases, scores, tokens): ModelSummary`, `GATE`.

- [ ] **Step 1: Write the failing test**

`.agents/skills/genui/scripts/score.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { scoreReply, summarize, type EvalCase } from './score';

const UI: EvalCase = { id: 'u1', expect: 'ui', prompt: 'Compare A and B' };
const PROSE: EvalCase = { id: 'p1', expect: 'prose', prompt: 'hi' };
const NO_DATA: EvalCase = { id: 'n1', expect: 'either', prompt: 'Chart my revenue', forbid: ['BarChart', 'LineChart', 'PieChart'] };

const GOOD = 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```';
const BAD = 'Here.\n\n```openui\nroot = Stack([l])\nl = Link("x", "javascript:alert(1)")\n```';
const CHART = '```openui\nroot = Stack([c])\nc = BarChart(["a"], [s], "made up")\ns = Series("S", [1])\n```';

describe('scoreReply', () => {
  test('counts valid blocks and components', () => {
    expect(scoreReply(UI, GOOD)).toMatchObject({ blocks: 1, validBlocks: 1, components: ['Badge', 'Stack'], underuse: false });
  });
  test('an invalid block is counted but not valid, with its issue codes', () => {
    const score = scoreReply(UI, BAD);
    expect(score.validBlocks).toBe(0);
    expect(score.issues).toContain('url:Link');
  });
  test('UI on a prose case is overuse; no UI on a UI case is underuse', () => {
    expect(scoreReply(PROSE, GOOD).overuse).toBe(true);
    expect(scoreReply(UI, 'Just text.').underuse).toBe(true);
  });
  test('a chart without data is a forbidden component', () => {
    expect(scoreReply(NO_DATA, CHART).forbidden).toEqual(['BarChart']);
  });
});

describe('summarize', () => {
  test('applies the go/no-go gate', () => {
    const cases = [UI, PROSE];
    const pass = summarize('m', cases, [scoreReply(UI, GOOD), scoreReply(PROSE, 'Hello!')], [100, 300]);
    expect(pass).toMatchObject({ validRate: 1, overuseRate: 0, underuseRate: 0, go: true, medianCompletionTokens: 300 });
    const fail = summarize('m', cases, [scoreReply(UI, BAD), scoreReply(PROSE, GOOD)], [100]);
    expect(fail.go).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test .agents/skills/genui/scripts/score.test.ts`
Expected: FAIL — `Cannot find module './score'`.

- [ ] **Step 3: Write the scorer**

`.agents/skills/genui/scripts/score.ts`:

```ts
import { parseGenui, splitGenui } from '../../../../packages/sdk/src/genui/index';

export interface EvalCase {
  id: string;
  /** `ui`: a block is the right answer. `prose`: no block. `either`: both are fine. */
  expect: 'ui' | 'prose' | 'either';
  prompt: string;
  /** Tool output given to the model as context, when the case has data. */
  context?: string;
  /** Block names that must not appear (e.g. charts when no data was given). */
  forbid?: string[];
}

export interface CaseScore {
  id: string;
  blocks: number;
  validBlocks: number;
  components: string[];
  overuse: boolean;
  underuse: boolean;
  forbidden: string[];
  issues: string[];
}

function collect(node: { type: string; props: Record<string, unknown> } | null, into: Set<string>): Set<string> {
  if (!node) return into;
  into.add(node.type);
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) collect(child as never, into);
      }
    }
  }
  return into;
}

/** Score one model reply against its case. Pure: no network, no clock. */
export function scoreReply(testCase: EvalCase, reply: string): CaseScore {
  const blocks = splitGenui(reply).filter((segment) => segment.kind === 'genui');
  const components = new Set<string>();
  const issues: string[] = [];
  let validBlocks = 0;
  for (const block of blocks) {
    if (block.kind !== 'genui') continue;
    const result = parseGenui(block.code, block.version);
    collect(result.root, components);
    issues.push(...result.issues.map((issue) => `${issue.code}:${issue.component ?? ''}`));
    if (result.root && result.issues.length === 0) validBlocks++;
  }
  const names = [...components].sort();
  return {
    id: testCase.id,
    blocks: blocks.length,
    validBlocks,
    components: names,
    overuse: testCase.expect === 'prose' && blocks.length > 0,
    underuse: testCase.expect === 'ui' && blocks.length === 0,
    forbidden: names.filter((name) => testCase.forbid?.includes(name)),
    issues,
  };
}

export interface ModelSummary {
  model: string;
  cases: number;
  blocks: number;
  validRate: number;
  overuseRate: number;
  underuseRate: number;
  forbiddenCount: number;
  medianCompletionTokens: number;
  go: boolean;
}

/** Go/no-go thresholds from plan-2. */
export const GATE = { validRate: 0.97, overuseRate: 0.1, underuseRate: 0.25, forbiddenCount: 1 } as const;

export function summarize(model: string, cases: EvalCase[], scores: CaseScore[], completionTokens: number[]): ModelSummary {
  const blocks = scores.reduce((sum, s) => sum + s.blocks, 0);
  const valid = scores.reduce((sum, s) => sum + s.validBlocks, 0);
  const proseCases = cases.filter((c) => c.expect === 'prose').length;
  const uiCases = cases.filter((c) => c.expect === 'ui').length;
  const sorted = [...completionTokens].sort((a, b) => a - b);
  const summary = {
    model,
    cases: scores.length,
    blocks,
    validRate: blocks === 0 ? 0 : valid / blocks,
    overuseRate: proseCases === 0 ? 0 : scores.filter((s) => s.overuse).length / proseCases,
    underuseRate: uiCases === 0 ? 0 : scores.filter((s) => s.underuse).length / uiCases,
    forbiddenCount: scores.reduce((sum, s) => sum + s.forbidden.length, 0),
    medianCompletionTokens: sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!,
  };
  return {
    ...summary,
    go:
      summary.validRate >= GATE.validRate &&
      summary.overuseRate <= GATE.overuseRate &&
      summary.underuseRate <= GATE.underuseRate &&
      summary.forbiddenCount <= GATE.forbiddenCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test .agents/skills/genui/scripts/score.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the cases and the runner**

`.agents/skills/genui/scripts/eval-prompts.json` (46 cases: 26 `ui`, 16 `prose`, 4 `either`; every value is a placeholder):

```json
[
  { "id": "ui-compare-phones", "expect": "ui", "prompt": "Which of these three phones should I buy for photography?", "context": "Phone A: price 799, camera score 92, battery 4500 mAh. Phone B: price 699, camera score 88, battery 5000 mAh. Phone C: price 999, camera score 95, battery 4300 mAh." },
  { "id": "ui-rank-hotels", "expect": "ui", "prompt": "Recommend the best hotel for a family trip from these options.", "context": "Hotel North: 4.6 stars, 180 per night, pool, 2 km to beach. Hotel South: 4.8 stars, 240 per night, kids club, on the beach. Hotel East: 4.2 stars, 120 per night, no pool, 5 km to beach." },
  { "id": "ui-revenue-quarters", "expect": "ui", "prompt": "Show me revenue by quarter.", "context": "Billing export: Q1 120000, Q2 150000, Q3 170000, Q4 210000 (USD)." },
  { "id": "ui-signups-monthly", "expect": "ui", "prompt": "How did signups trend this year?", "context": "Signups per month: Jan 320, Feb 410, Mar 390, Apr 520, May 610, Jun 700." },
  { "id": "ui-market-share", "expect": "ui", "prompt": "What is the market share breakdown?", "context": "Survey of 1000 users: Product X 420, Product Y 310, Product Z 180, Other 90." },
  { "id": "ui-places-map", "expect": "ui", "prompt": "Where are these offices?", "context": "Places tool: Office One at 52.5200, 13.4050; Office Two at 48.1351, 11.5820; Office Three at 50.1109, 8.6821." },
  { "id": "ui-kpi-summary", "expect": "ui", "prompt": "Give me this week's key numbers.", "context": "Active users 12400 (+6%), revenue 48200 USD (+3%), churn 2.1% (-0.4 pts), tickets 312 (-12%)." },
  { "id": "ui-compare-plans", "expect": "ui", "prompt": "Compare the Basic and Pro plans.", "context": "Basic: 10 USD/month, 3 projects, email support. Pro: 30 USD/month, unlimited projects, priority support, SSO." },
  { "id": "ui-rank-libraries", "expect": "ui", "prompt": "Rank the top 5 TypeScript validation libraries with one reason each." },
  { "id": "ui-countries-table", "expect": "ui", "prompt": "Put these countries in a table.", "context": "Country A: capital Alpha, population 5.1M. Country B: capital Beta, population 12.4M. Country C: capital Gamma, population 3.3M. Country D: capital Delta, population 8.9M." },
  { "id": "ui-service-status", "expect": "ui", "prompt": "What is the status of our services?", "context": "api: healthy, p95 120 ms. web: healthy, p95 340 ms. worker: degraded, queue 4200. db: healthy, CPU 41%." },
  { "id": "ui-explicit-chart", "expect": "ui", "prompt": "Show this as a chart: costs were 400 in Jan, 520 in Feb, 610 in Mar." },
  { "id": "ui-explicit-table", "expect": "ui", "prompt": "Compare these in a table: Tool One is free and open source; Tool Two costs 20 a month and has support; Tool Three costs 5 a month and is hosted." },
  { "id": "ui-itinerary-tabs", "expect": "ui", "prompt": "Plan a 3-day city itinerary, one view per day.", "context": "Day 1: old town walk, museum, river dinner. Day 2: market, park, concert. Day 3: day trip to the lake." },
  { "id": "ui-pros-cons", "expect": "ui", "prompt": "Pros and cons of Framework One versus Framework Two for a small team." },
  { "id": "ui-expenses", "expect": "ui", "prompt": "Break down my expenses this week.", "context": "Rent 600, food 180, transport 60, fun 90, other 40 (EUR)." },
  { "id": "ui-restaurants-map", "expect": "ui", "prompt": "Recommend these restaurants and show where they are.", "context": "Restaurant Red: 4.7 stars, 40.7128, -74.0060. Restaurant Blue: 4.5 stars, 40.7306, -73.9866. Restaurant Green: 4.4 stars, 40.7580, -73.9855." },
  { "id": "ui-four-products", "expect": "ui", "prompt": "Which laptop is best for a student?", "context": "Laptop 1: 899, 16 GB, 1.3 kg, 12 h. Laptop 2: 1199, 16 GB, 1.1 kg, 15 h. Laptop 3: 649, 8 GB, 1.6 kg, 9 h. Laptop 4: 999, 32 GB, 1.8 kg, 10 h." },
  { "id": "ui-latency-24h", "expect": "ui", "prompt": "How did latency change over the last 24 hours?", "context": "p95 ms by 4-hour window: 00h 180, 04h 150, 08h 240, 12h 310, 16h 290, 20h 210." },
  { "id": "ui-survey-pie", "expect": "ui", "prompt": "Summarize the survey answers.", "context": "Would you recommend us? Yes 640, Maybe 230, No 130." },
  { "id": "ui-route-map", "expect": "ui", "prompt": "Show the delivery route.", "context": "Route stops in order: Depot 51.5074, -0.1278; Stop A 51.5155, -0.0922; Stop B 51.5033, -0.1196; Stop C 51.4975, -0.1357." },
  { "id": "ui-vendor-ranking", "expect": "ui", "prompt": "Rank these vendors for us.", "context": "Vendor Q: price 8/10, support 9/10, security 7/10. Vendor R: price 6/10, support 8/10, security 9/10. Vendor S: price 9/10, support 5/10, security 6/10." },
  { "id": "ui-sales-region", "expect": "ui", "prompt": "Sales by region, please.", "context": "North 340, South 280, East 410, West 190 (units)." },
  { "id": "ui-stats-and-tip", "expect": "ui", "prompt": "Summarize this campaign and tell me what to do next.", "context": "Emails sent 20000, open rate 31%, click rate 4.2%, unsubscribes 0.3%. Best subject line: short question." },
  { "id": "prose-greeting", "expect": "prose", "prompt": "hi" },
  { "id": "prose-thanks", "expect": "prose", "prompt": "thanks, that helped" },
  { "id": "prose-explain-recursion", "expect": "prose", "prompt": "Explain recursion to a beginner." },
  { "id": "prose-mutex", "expect": "prose", "prompt": "What is a mutex?" },
  { "id": "prose-python-function", "expect": "prose", "prompt": "Write a Python function that reverses a string." },
  { "id": "prose-fix-bug", "expect": "prose", "prompt": "Why does this throw? const x = undefined; x.length" },
  { "id": "prose-install-steps", "expect": "prose", "prompt": "How do I install Node.js on macOS? Step by step." },
  { "id": "prose-opinion", "expect": "prose", "prompt": "Tabs or spaces? Give me your opinion in two sentences." },
  { "id": "prose-short-fact", "expect": "prose", "prompt": "What is the capital of France?" },
  { "id": "prose-summarize", "expect": "prose", "prompt": "Summarize this in one sentence: The meeting moved to Thursday because two people were traveling, and the agenda now includes the budget review." },
  { "id": "prose-translate", "expect": "prose", "prompt": "Translate to Spanish: Good morning, see you soon." },
  { "id": "prose-joke", "expect": "prose", "prompt": "Tell me a short joke." },
  { "id": "prose-how-are-you", "expect": "prose", "prompt": "how are you today?" },
  { "id": "prose-define-latency", "expect": "prose", "prompt": "Define latency in one paragraph." },
  { "id": "edge-plain-text", "expect": "prose", "prompt": "Plain text only, no UI: compare Phone A and Phone B.", "context": "Phone A: price 799, camera 92. Phone B: price 699, camera 88." },
  { "id": "edge-chart-no-data", "expect": "either", "prompt": "Chart my revenue for last year.", "forbid": ["BarChart", "LineChart", "PieChart"] },
  { "id": "edge-map-no-coords", "expect": "either", "prompt": "Where are the best cafes in Lisbon?", "forbid": ["Map"] },
  { "id": "edge-rank-fifteen", "expect": "ui", "prompt": "Rank these 15 options.", "context": "Options 1 to 15, each scored: 1:71, 2:64, 3:88, 4:59, 5:92, 6:77, 7:81, 8:45, 9:66, 10:73, 11:90, 12:52, 13:84, 14:69, 15:58." },
  { "id": "edge-big-table", "expect": "ui", "prompt": "Show all 80 rows in a table.", "context": "Rows r1 to r80 with value equal to the row number." },
  { "id": "edge-faq", "expect": "either", "prompt": "Write a short FAQ with 5 questions about password resets." },
  { "id": "edge-json-output", "expect": "prose", "prompt": "Return the three primary colors as a JSON array." },
  { "id": "edge-markdown-table", "expect": "either", "prompt": "Give me a markdown table of 3 fruits and their colors." }
]
```

`.agents/skills/genui/scripts/eval.ts`:

```ts
/**
 * Phase 0 evaluation: run every case in eval-prompts.json against each model through the Kortix LLM
 * gateway, score the replies, and append a summary to references/eval-results.md.
 *
 *   GENUI_EVAL_TOKEN=<kortix token> bun .agents/skills/genui/scripts/eval.ts
 *
 * Env: GENUI_EVAL_API_URL (default http://localhost:8008), GENUI_EVAL_MODELS (comma list),
 * GENUI_EVAL_CONCURRENCY (default 4). Raw replies go to output/genui-eval/ (gitignored).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildGenuiPrompt, GENUI_PROMPT_VERSION } from '../../../../packages/sdk/src/genui/index';
import { GATE, scoreReply, summarize, type CaseScore, type EvalCase, type ModelSummary } from './score';

const API = process.env.GENUI_EVAL_API_URL ?? 'http://localhost:8008';
const TOKEN = process.env.GENUI_EVAL_TOKEN;
const MODELS = (
  process.env.GENUI_EVAL_MODELS ?? 'deepseek/deepseek-v4-pro,openai/gpt-5.5,openai/gpt-6-sol,openai/gpt-6-astra'
).split(',');
const CONCURRENCY = Number(process.env.GENUI_EVAL_CONCURRENCY ?? 4);
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const SYSTEM = `You are Kortix, a helpful agent. Answer the user directly.\n\n${buildGenuiPrompt()}`;

if (!TOKEN) throw new Error('Set GENUI_EVAL_TOKEN to a Kortix API key or access token');

const cases: EvalCase[] = JSON.parse(readFileSync(join(import.meta.dir, 'eval-prompts.json'), 'utf8'));

async function ask(model: string, testCase: EvalCase): Promise<{ text: string; tokens: number }> {
  const user = testCase.context ? `${testCase.prompt}\n\nTool result:\n${testCase.context}` : testCase.prompt;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${API}/v1/llm/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { completion_tokens?: number };
      };
      return { text: body.choices?.[0]?.message?.content ?? '', tokens: body.usage?.completion_tokens ?? 0 };
    }
    // 4xx other than 429 will not fix itself: fail fast with the server's message.
    if (response.status < 500 && response.status !== 429) {
      throw new Error(`${model} ${testCase.id}: HTTP ${response.status} ${await response.text()}`);
    }
    await Bun.sleep(2000 * attempt);
  }
  throw new Error(`${model} ${testCase.id}: 3 attempts failed`);
}

async function runModel(model: string): Promise<{ summary: ModelSummary; scores: CaseScore[]; replies: Record<string, string> }> {
  const scores: CaseScore[] = [];
  const tokens: number[] = [];
  const replies: Record<string, string> = {};
  const queue = [...cases];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { text, tokens: used } = await ask(model, next);
        replies[next.id] = text;
        tokens.push(used);
        scores.push(scoreReply(next, text));
      }
    }),
  );
  scores.sort((a, b) => a.id.localeCompare(b.id));
  return { summary: summarize(model, cases, scores, tokens), scores, replies };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const stamp = new Date().toISOString();
const results = [];
for (const model of MODELS) {
  console.log(`running ${model} on ${cases.length} cases`);
  results.push(await runModel(model));
}

const outDir = join(ROOT, 'output', 'genui-eval');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${stamp.replace(/[:.]/g, '-')}.json`), JSON.stringify({ stamp, prompt: GENUI_PROMPT_VERSION, results }, null, 2));

const lines = [
  `\n## Run ${stamp} — prompt ${GENUI_PROMPT_VERSION}`,
  '',
  `Gate: valid ≥ ${pct(GATE.validRate)}, overuse ≤ ${pct(GATE.overuseRate)}, underuse ≤ ${pct(GATE.underuseRate)}, forbidden ≤ ${GATE.forbiddenCount}.`,
  '',
  '| Model | Cases | Blocks | Valid | Overuse | Underuse | Forbidden | Median completion tokens | Go |',
  '|---|---|---|---|---|---|---|---|---|',
  ...results.map(({ summary: s }) =>
    `| \`${s.model}\` | ${s.cases} | ${s.blocks} | ${pct(s.validRate)} | ${pct(s.overuseRate)} | ${pct(s.underuseRate)} | ${s.forbiddenCount} | ${s.medianCompletionTokens} | ${s.go ? 'YES' : 'NO'} |`,
  ),
  '',
  'Failing cases (issue codes only):',
  '',
  ...results.flatMap(({ summary, scores }) =>
    scores
      .filter((s) => s.overuse || s.underuse || s.forbidden.length > 0 || s.validBlocks < s.blocks)
      .map((s) => `- \`${summary.model}\` ${s.id}: ${[s.overuse && 'overuse', s.underuse && 'underuse', ...s.forbidden.map((f) => `forbidden ${f}`), ...s.issues].filter(Boolean).join(', ')}`),
  ),
];
appendFileSync(join(import.meta.dir, '..', 'references', 'eval-results.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
```

`.agents/skills/genui/references/eval-results.md`:

```md
# Generative UI — Phase 0 evaluation results

Each run appends one section: the gate, one row per model, and the failing cases (issue codes only).
Raw replies are in `output/genui-eval/<timestamp>.json` (gitignored). Script: `scripts/eval.ts`.
```

- [ ] **Step 6: Typecheck the script against the SDK source**

Run: `cd packages/sdk && bunx tsc --noEmit --strict --module esnext --moduleResolution bundler --target es2022 --skipLibCheck --types bun ../../.agents/skills/genui/scripts/eval.ts`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add .agents/skills/genui/scripts .agents/skills/genui/references/eval-results.md
git commit -m "feat(genui): Phase 0 evaluation script and 46 synthetic cases"
```

---

### Task 2: Run the evaluation and record the decision

**Files:**
- Modify: `.agents/skills/genui/references/eval-results.md` (the script appends)
- Modify: `.agents/skills/genui/SKILL.md` (one line: the decision)

- [ ] **Step 1: Verify gateway access with one call**

Mint a token per CLAUDE.md "Authenticating to the live API" (local stack running: `curl -s localhost:8008/v1/health`), then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8008/v1/llm/chat/completions \
  -H "authorization: Bearer $GENUI_EVAL_TOKEN" -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5.5","messages":[{"role":"user","content":"Say ok"}]}'
```

Expected: `200`. If `401`/`403`: read the auth middleware for `/v1/llm` in `apps/api/src/llm-gateway/wire.ts` and use the token type it expects (API key vs user JWT); if `402`: the account needs managed-model credits — use a local account with credits. Record which token type worked in the commit body.

- [ ] **Step 2: Run all 4 models**

Run: `GENUI_EVAL_TOKEN=$GENUI_EVAL_TOKEN bun .agents/skills/genui/scripts/eval.ts`
Expected: 4 × `running <model> on 46 cases`, then a summary table printed and appended to `eval-results.md`. Duration: about 46 × 4 calls at concurrency 4.

- [ ] **Step 3: Read the failures**

For every model with `Go: NO`, open `output/genui-eval/<timestamp>.json` and read 3 failing replies. Classify each failure as: invalid syntax, limit breach, overuse, underuse, or invented data. Add the classification under the run's section in `eval-results.md`.

- [ ] **Step 4: Spot-check rule 1 and visual sense**

Open `output/genui-eval/<timestamp>.json`, case `ui-rank-hotels` and `ui-stats-and-tip`, for each model. Check: at least one sentence of prose before the block; components fit the content (RankedList for a ranking, not a Table). Note deviations in `eval-results.md`.

- [ ] **Step 5: Decide and record**

If all 4 models pass: add `Phase 0: GO (<date>, prompt <GENUI_PROMPT_VERSION>)` to `.agents/skills/genui/SKILL.md` under the status line, and continue with plans 3–5.
If any model fails: stop. Report the table and classifications to Jay with the 3 options from the gate section; do not start plans 3–5 until he chooses.

- [ ] **Step 6: Commit**

```bash
git add .agents/skills/genui/references/eval-results.md .agents/skills/genui/SKILL.md
git commit -m "docs(genui): Phase 0 evaluation results"
```
