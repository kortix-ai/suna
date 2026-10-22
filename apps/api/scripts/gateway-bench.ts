// Kortix LLM gateway benchmark: each target measured through the Kortix gateway
// AND directly at its provider, so the difference is the gateway's own cost.
//
//   bun apps/api/scripts/gateway-bench.ts --config <targets.json> --out <dir> [--n 10] [--phases short,long,conc,tool,cache]
//   bun apps/api/scripts/gateway-bench.ts --report <dir>
//
// targets.json: [{ "name": "openrouter:deepseek", "via": "kortix"|"direct", "url": "<OpenAI-compatible base>",
//                  "keyEnv": "BENCH_KEY_X", "model": "<wire model>", "headers": {}, "extra": {} }]
// Keys come from the named env vars, never from argv or the config file.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

type Target = { name: string; via: string; url: string; keyEnv: string; model: string; headers?: Record<string, string>; extra?: Record<string, unknown> };
type Sample = {
  ts: string; test: string; target: string; via: string; model: string; conc: number; ok: boolean; status: number;
  ttftMs?: number; totalMs: number; outTok?: number; decodeTps?: number; promptTok?: number; cachedTok?: number;
  toolOk?: boolean; cost?: number; error?: string;
  /** Gaps between content chunks (ms): p50, p99, max. */
  gapP50?: number; gapP99?: number; gapMax?: number;
};

const { values } = parseArgs({ options: {
  config: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' },
  n: { type: 'string', default: '10' }, phases: { type: 'string', default: 'short,long,conc,tool,cache' },
} });

const FILLER = 'Kortix runs agents in sandboxes. Each session has a model, tools and a workspace. ';
const longPrompt = (tokens: number, nonce: string, prefix = '') =>
  `${prefix}[${nonce}] ${FILLER.repeat(Math.ceil((tokens * 4) / FILLER.length)).slice(0, tokens * 4)}\n\nIgnore the text above. In one sentence, what is a sandbox?`;
const TOOL = [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function call(t: Target, test: string, conc: number, body: Record<string, unknown>): Promise<Sample> {
  const key = process.env[t.keyEnv] ?? '';
  const started = performance.now();
  const base: Sample = { ts: new Date().toISOString(), test, target: t.name, via: t.via, model: t.model, conc, ok: false, status: 0, totalMs: 0 };
  try {
    const res = await fetch(`${t.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(t.headers ?? {}) },
      body: JSON.stringify({ model: t.model, stream: true, stream_options: { include_usage: true }, ...t.extra, ...body }),
    });
    base.status = res.status;
    if (!res.ok || !res.body) {
      base.error = (await res.text()).slice(0, 200);
      base.totalMs = performance.now() - started;
      return base;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', first = 0, last = 0, usage: any, toolName = '', toolArgs = '';
    const gaps: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = ev.split('\n').find((l) => l.startsWith('data:'));
        if (!line || line.includes('[DONE]')) continue;
        let j: any; try { j = JSON.parse(line.slice(5)); } catch { continue; }
        const d = j.choices?.[0]?.delta ?? {};
        if (d.content || d.reasoning_content || d.reasoning || d.tool_calls) {
          const now = performance.now(); if (!first) first = now; else gaps.push(now - last); last = now;
        }
        for (const tc of d.tool_calls ?? []) { if (tc.function?.name) toolName = tc.function.name; toolArgs += tc.function?.arguments ?? ''; }
        if (j.usage) usage = j.usage;
      }
    }
    const end = performance.now();
    const outTok = usage?.completion_tokens;
    Object.assign(base, {
      ok: true, totalMs: end - started, ttftMs: first ? first - started : undefined, outTok,
      decodeTps: outTok && first && last > first ? outTok / ((last - first) / 1000) : undefined,
      promptTok: usage?.prompt_tokens, cachedTok: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens,
      cost: typeof usage?.cost === 'number' ? usage.cost : undefined,
    });
    if (test === 'tool') base.toolOk = toolName === 'get_weather' && /paris/i.test(toolArgs);
    if (gaps.length > 10) {
      gaps.sort((a, b) => a - b);
      base.gapP50 = gaps[Math.floor(gaps.length * 0.5)]; base.gapP99 = gaps[Math.floor(gaps.length * 0.99)]; base.gapMax = gaps.at(-1);
    }
    return base;
  } catch (e) {
    return { ...base, totalMs: performance.now() - started, error: (e as Error).message.slice(0, 200) };
  }
}

async function run(): Promise<void> {
  const targets = JSON.parse(readFileSync(values.config!, 'utf8')) as Target[];
  const out = values.out!; mkdirSync(out, { recursive: true });
  const file = `${out}/samples.jsonl`;
  const n = Number(values.n);
  const phases = new Set(values.phases!.split(','));
  const write = (s: Sample) => { appendFileSync(file, `${JSON.stringify(s)}\n`); console.log(`${s.target} ${s.via} ${s.test} c${s.conc} ${s.ok ? 'ok' : `ERR ${s.status}`} ttft=${s.ttftMs?.toFixed(0) ?? '-'} tps=${s.decodeTps?.toFixed(0) ?? '-'}`); };
  for (const t of targets) {
    if (!process.env[t.keyEnv]) { console.log(`skip ${t.name} ${t.via}: ${t.keyEnv} unset`); continue; }
    const nonce = () => crypto.randomUUID().slice(0, 8);
    if (phases.has('short')) for (let i = 0; i < n; i++) write(await call(t, 'short', 1, { max_tokens: 300, messages: [{ role: 'user', content: `[${nonce()}] Write 5 short tips for reliable shell scripts.` }] }));
    if (phases.has('long')) for (let i = 0; i < 2; i++) write(await call(t, 'long30k', 1, { max_tokens: 100, messages: [{ role: 'user', content: longPrompt(30_000, nonce()) }] }));
    for (const c of [8, 32, 100]) {
      if (!phases.has(`conc${c}`) && !(c === 8 && phases.has('conc'))) continue;
      for (const s of await Promise.all(Array.from({ length: c }, () => call(t, `conc${c}`, c, { max_tokens: 200, messages: [{ role: 'user', content: `[${nonce()}] Write 5 short tips for reliable shell scripts.` }] })))) write(s);
    }
    if (phases.has('longstream')) for (let i = 0; i < 3; i++) write(await call(t, 'longstream', 1, { max_tokens: 3000, messages: [{ role: 'user', content: `[${nonce()}] Write a detailed 1500-word essay on the history of the shell.` }] }));
    if (phases.has('long120k')) write(await call(t, 'long120k', 1, { max_tokens: 100, messages: [{ role: 'user', content: longPrompt(120_000, nonce()) }] }));
    if (phases.has('tool')) for (let i = 0; i < 3; i++) write(await call(t, 'tool', 1, { max_tokens: 800, tools: TOOL, messages: [{ role: 'user', content: `[${nonce()}] What is the weather in Paris? Use the tool.` }] }));
    if (phases.has('cache')) {
      const prefix = longPrompt(20_000, `cache-${nonce()}`);
      write(await call(t, 'cache-cold', 1, { max_tokens: 50, messages: [{ role: 'user', content: prefix }] }));
      write(await call(t, 'cache-warm', 1, { max_tokens: 50, messages: [{ role: 'user', content: prefix }] }));
    }
  }
}

function report(dir: string): void {
  const rows = readFileSync(`${dir}/samples.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Sample);
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN; };
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '-');
  const groups = new Map<string, Sample[]>();
  for (const r of rows) { const k = `${r.target}|${r.via}|${r.test}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  console.log('| target | via | test | n | ok | TTFT p50 | p90 | p99 | decode tok/s p50 | total p50 ms | cached tok | tool ok | chunk gap p50/p99/max |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [k, rs] of [...groups].sort()) {
    const [target, via, test] = k.split('|');
    const ok = rs.filter((r) => r.ok);
    const tt = ok.map((r) => r.ttftMs!).filter((x) => x !== undefined);
    console.log(`| ${target} | ${via} | ${test} | ${rs.length} | ${ok.length} | ${f(q(tt, 0.5))} | ${f(q(tt, 0.9))} | ${f(q(tt, 0.99))} | ${f(q(ok.map((r) => r.decodeTps!).filter(Boolean), 0.5))} | ${f(q(ok.map((r) => r.totalMs), 0.5))} | ${f(q(ok.map((r) => r.cachedTok ?? 0), 0.5))} | ${test === 'tool' ? `${ok.filter((r) => r.toolOk).length}/${ok.length}` : ''} | ${ok.some((r) => r.gapP50 !== undefined) ? `${f(q(ok.map((r) => r.gapP50!).filter((x) => x !== undefined), 0.5))}/${f(q(ok.map((r) => r.gapP99!).filter((x) => x !== undefined), 0.5))}/${f(Math.max(...ok.map((r) => r.gapMax ?? 0)))}` : ''} |`);
  }
  // Overhead vs direct: TTFT p50 and p95 per route on the short test, minus the direct route's.
  console.log('\n| target | via | TTFT p50 | p95 | overhead p50 vs direct | overhead p95 vs direct |\n|---|---|---|---|---|---|');
  for (const target of [...new Set(rows.map((r) => r.target))].sort()) {
    const tt = (via: string, p: number) => q(rows.filter((r) => r.target === target && r.via === via && r.test === 'short' && r.ok && r.ttftMs).map((r) => r.ttftMs!), p);
    for (const via of [...new Set(rows.filter((r) => r.target === target).map((r) => r.via))].sort()) {
      const d50 = tt('direct', 0.5), d95 = tt('direct', 0.95), v50 = tt(via, 0.5), v95 = tt(via, 0.95);
      const diff = (a: number, b: number) => (Number.isFinite(a) && Number.isFinite(b) && via !== 'direct' ? f(a - b) : '-');
      console.log(`| ${target} | ${via} | ${f(v50)} | ${f(v95)} | ${diff(v50, d50)} | ${diff(v95, d95)} |`);
    }
  }
}

if (values.report) report(values.report);
else await run();
