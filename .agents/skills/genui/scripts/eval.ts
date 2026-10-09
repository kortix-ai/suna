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
