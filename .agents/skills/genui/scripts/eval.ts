/**
 * Phase 0 evaluation: run every case in eval-prompts.json against each model through the Kortix LLM
 * gateway, score the replies, and append a summary to references/eval-results.md.
 *
 *   GENUI_EVAL_TOKEN=<kortix token> bun .agents/skills/genui/scripts/eval.ts
 *
 * Env: GENUI_EVAL_API_URL (default http://localhost:8008), GENUI_EVAL_MODELS (comma list),
 * GENUI_EVAL_CONCURRENCY (default 4). Each finished model is written at once to
 * output/genui-eval/ (gitignored). A failed model gets an ERROR row and the run continues.
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
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One chat call. Network errors, 429 and 5xx retry (3 attempts); other 4xx fail at once. */
async function ask(model: string, testCase: EvalCase): Promise<{ text: string; tokens: number }> {
  const user = testCase.context ? `${testCase.prompt}\n\nTool result:\n${testCase.context}` : testCase.prompt;
  let lastError = 'no attempt';
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API}/v1/llm/chat/completions`, {
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
    } catch (error) {
      lastError = `network: ${errorText(error)}`;
      await Bun.sleep(2000 * attempt);
      continue;
    }
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
    lastError = `HTTP ${response.status}`;
    await Bun.sleep(2000 * attempt);
  }
  throw new Error(`${model} ${testCase.id}: 3 attempts failed (${lastError})`);
}

interface ModelRun {
  summary: ModelSummary;
  scores: CaseScore[];
  replies: Record<string, string>;
}

/** Runs every case for one model. The first thrown case stops the model; the error propagates. */
async function runModel(model: string): Promise<ModelRun> {
  const scores: CaseScore[] = [];
  const tokens: number[] = [];
  const replies: Record<string, string> = {};
  const queue = [...cases];
  let failure: Error | undefined;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let next = queue.shift(); next && !failure; next = queue.shift()) {
        try {
          const { text, tokens: used } = await ask(model, next);
          replies[next.id] = text;
          tokens.push(used);
          scores.push(scoreReply(next, text));
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(errorText(error));
        }
      }
    }),
  );
  if (failure) throw failure;
  scores.sort((a, b) => a.id.localeCompare(b.id));
  return { summary: summarize(model, cases, scores, tokens), scores, replies };
}

type Outcome = { model: string; run: ModelRun } | { model: string; error: string };

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const stamp = new Date().toISOString();
const fileStamp = stamp.replace(/[:.]/g, '-');
const outDir = join(ROOT, 'output', 'genui-eval');
mkdirSync(outDir, { recursive: true });

const outcomes: Outcome[] = [];
for (const model of MODELS) {
  console.log(`running ${model} on ${cases.length} cases`);
  try {
    const run = await runModel(model);
    // Persist before the next model starts: a later failure cannot lose paid results.
    writeFileSync(
      join(outDir, `${fileStamp}-${model.replaceAll('/', '_')}.json`),
      JSON.stringify({ stamp, prompt: GENUI_PROMPT_VERSION, summary: run.summary, scores: run.scores, replies: run.replies }, null, 2),
    );
    outcomes.push({ model, run });
  } catch (error) {
    const message = errorText(error);
    console.error(`${model} failed: ${message}`);
    outcomes.push({ model, error: message });
  }
}

const row = (outcome: Outcome): string => {
  if (!('run' in outcome)) {
    // Table cells cannot hold a pipe or a newline.
    const message = outcome.error.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 120);
    return `| \`${outcome.model}\` | ERROR: ${message} | — | — | — | — | — | — | — | NO |`;
  }
  const s = outcome.run.summary;
  return `| \`${s.model}\` | ${s.cases} | ${s.blocks} | ${pct(s.validRate)} | ${pct(s.overuseRate)} | ${pct(s.underuseRate)} | ${s.forbiddenCount} | ${s.medianCompletionTokens} | ${s.errorCount} | ${s.go ? 'YES' : 'NO'} |`;
};

const lines = [
  `\n## Run ${stamp} — prompt ${GENUI_PROMPT_VERSION}`,
  '',
  `Gate: valid ≥ ${pct(GATE.validRate)}, overuse ≤ ${pct(GATE.overuseRate)}, underuse ≤ ${pct(GATE.underuseRate)}, forbidden ≤ ${GATE.forbiddenCount}, errors = 0.`,
  '',
  '| Model | Cases | Blocks | Valid | Overuse | Underuse | Forbidden | Median completion tokens | Errors | Go |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...outcomes.map(row),
  '',
  'Failing cases (issue codes only):',
  '',
  ...outcomes.flatMap((outcome) =>
    'run' in outcome
      ? outcome.run.scores
          .filter((s) => s.error || s.overuse || s.underuse || s.forbidden.length > 0 || s.validBlocks < s.blocks)
          .map((s) => `- \`${outcome.model}\` ${s.id}: ${[s.error, s.overuse && 'overuse', s.underuse && 'underuse', ...s.forbidden.map((f) => `forbidden ${f}`), ...s.issues].filter(Boolean).join(', ')}`)
      : [],
  ),
];
appendFileSync(join(import.meta.dir, '..', 'references', 'eval-results.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
if (outcomes.some((outcome) => !('run' in outcome))) process.exitCode = 1;
