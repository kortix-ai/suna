#!/usr/bin/env bun
/**
 * Prompt-path latency bench: the before/after number for every API performance change.
 *
 * Per session: POST /sessions, POST /start until `stage: ready`, the daemon's
 * `runtimeReady`, one GET /events stream, then BENCH_TURNS prompts through
 * POST /prompts (the web client's path). It records:
 *   - wall time of POST /sessions and POST /prompts, as the client sees it;
 *   - their `Server-Timing` stages (`db;dur=…;desc="n=…"` = DB wall time and
 *     statement count, see src/lib/server-timing.ts);
 *   - POST→busy and POST→idle per turn (`session.status` frames on /events);
 *   - delivery: `[provision-timeline] deliver|proxy … total=…ms` lines of this
 *     run's prompts and sessions (BENCH_API_LOG, a local API's stdout), and
 *     lifecycle command created_at→result.forwarded_at (BENCH_DB_URL).
 * One JSON line per session goes to BENCH_OUT; a p50/p90 table goes to stdout.
 *
 *   cd apps/api
 *   BENCH_API=http://localhost:14008/v1 BENCH_TOKEN=<jwt> BENCH_PROJECT=<project_id> \
 *     bun scripts/prompt-latency-bench.ts
 *   bun scripts/prompt-latency-bench.ts report <file.jsonl>…  # print the table again
 *     (with BENCH_API_LOG set, re-read the delivery lines from that log first)
 *
 * Env: BENCH_SESSIONS (6), BENCH_TURNS (3, max 3), BENCH_MODEL (kortix model id),
 * BENCH_PROVIDER (sandbox provider), BENCH_LABEL (run), BENCH_OUT
 * (<repo>/output/prompt-latency-<label>.jsonl), BENCH_API_LOG, BENCH_DB_URL,
 * BENCH_KEEP=1 (leave the sessions running, e.g. to open one in the web app).
 * Runbook and baseline: .agents/skills/testing/references/api-latency-baseline.md
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL } from 'bun';
import { mintWireMessageId } from '@kortix/sdk/wire-message-id';

const env = process.env;
const API = (env.BENCH_API ?? '').replace(/\/+$/, '');
const TOKEN = (env.BENCH_TOKEN ?? '').trim();
const PROJECT = env.BENCH_PROJECT ?? '';
const SESSIONS = Number(env.BENCH_SESSIONS ?? 6);
const LABEL = env.BENCH_LABEL ?? 'run';
// Default: the repo's gitignored output/ — the lines carry real session and prompt ids.
const OUT = env.BENCH_OUT ?? fileURLToPath(new URL(`../../../output/prompt-latency-${LABEL}.jsonl`, import.meta.url));
const BOOT_TIMEOUT_MS = 240_000;
const TURN_TIMEOUT_MS = 180_000;
const TURNS = [
  { label: 'T1-chat', text: 'Reply with exactly one word: pong' },
  { label: 'T2-tool', text: 'Use the bash tool to run `ls -1 | wc -l` in the current directory. Then reply with only the number it printed.' },
  { label: 'T3-chat', text: 'Reply with exactly one word: ping' },
].slice(0, Number(env.BENCH_TURNS ?? 3));

type Timing = Record<string, { dur: number; n?: number }>;
interface Timeline { kind: string; id: string; total: number; marks: Record<string, number> }
interface Turn {
  label: string; status: number; postMs: number; timing: Timing; promptId: string | null;
  busyMs: number | null; idleMs: number | null; text: string; model: string | null; error?: string;
  deliver?: Timeline | null; proxy?: Timeline | null; forwardedMs?: number | null;
  /** Frame types this turn saw, kept only when it failed. */
  seen?: string[];
}
interface Session {
  label: string; at: string; sessionId: string | null; externalId: string | null; provider: string | null;
  harness: string | null; createStatus: number | null; createMs: number | null; createTiming: Timing;
  readyMs: number | null; turns: Turn[]; error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `total;dur=412, db;dur=160;desc="n=11"` → { total: {dur: 412}, db: {dur: 160, n: 11} }. */
export function parseServerTiming(header: string | null): Timing {
  const out: Timing = {};
  for (const entry of (header ?? '').split(',')) {
    const [name, ...params] = entry.trim().split(';');
    if (!name) continue;
    const dur = params.find((p) => p.startsWith('dur='));
    const n = params.find((p) => p.startsWith('desc="n='));
    out[name] = { dur: Number(dur?.slice(4) ?? NaN), ...(n ? { n: Number(n.slice(8, -1)) } : {}) };
  }
  return out;
}

async function api(path: string, init: RequestInit = {}) {
  const t0 = performance.now();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ms, body, timing: parseServerTiming(res.headers.get('server-timing')) };
}

/** Runtime frames are the daemon's envelopes: { type, payload (OpenCode properties), seq }. */
interface Frame { t: number; type: string; payload: any }
function openEvents(sessionId: string, frames: Frame[]): AbortController {
  const ac = new AbortController();
  void (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${API}/projects/${PROJECT}/sessions/${sessionId}/events`, {
          headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' }, signal: ac.signal,
        });
        if (!res.ok || !res.body) { await sleep(500); continue; }
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            buf = buf.slice(i + 2);
            try {
              const f = JSON.parse(data);
              if (typeof f.type === 'string') frames.push({ t: performance.now(), type: f.type, payload: f.payload ?? f.properties ?? {} });
            } catch { /* comment or keepalive */ }
          }
        }
      } catch { if (!ac.signal.aborted) await sleep(500); }
    }
  })();
  return ac;
}

async function runTurn(sessionId: string, spec: { label: string; text: string }, frames: Frame[], sent: string[]): Promise<Turn> {
  const messageId = mintWireMessageId({ after: sent });
  sent.push(messageId);
  const model = env.BENCH_MODEL ? { model: { providerID: 'kortix', modelID: env.BENCH_MODEL } } : {};
  const from = frames.length;
  const t0 = performance.now();
  const r = await api(`/projects/${PROJECT}/sessions/${sessionId}/prompts`, {
    method: 'POST',
    // `client_sent_at_ms` as the web composer sends it: the prompt route reads it to
    // tell a lone send from a possible burst.
    body: JSON.stringify({ client_message_id: crypto.randomUUID(), message_id: messageId, parts: [{ type: 'text', text: spec.text }], overrides: model, client_sent_at_ms: Date.now() }),
  });
  const turn: Turn = {
    label: spec.label, status: r.status, postMs: r.ms, timing: r.timing, promptId: r.body?.prompt_id ?? null,
    busyMs: null, idleMs: null, text: '', model: null,
  };
  if (r.status !== 202 && r.status !== 200) return { ...turn, error: `prompt ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` };
  // Text parts by part id, kept only for assistant messages: a delivery may re-mint the
  // user message's wire id, so "not our message id" does not exclude the prompt itself.
  const texts = new Map<string, { messageId: string; text: string }>();
  const assistant = new Set<string>();
  let i = from;
  while (turn.idleMs === null && performance.now() - t0 < TURN_TIMEOUT_MS) {
    await sleep(25);
    for (; i < frames.length; i++) {
      const { t, type, payload } = frames[i];
      const at = Math.round(t - t0);
      if (type === 'session.status' && payload.status?.type === 'busy') turn.busyMs ??= at;
      if (type === 'message.updated' && payload.info?.role === 'assistant') {
        assistant.add(payload.info.id);
        turn.model = payload.info.modelID ?? turn.model;
      }
      if (type === 'message.part.updated' && payload.part?.type === 'text') texts.set(payload.part.id, { messageId: payload.part.messageID, text: payload.part.text ?? '' });
      if (type === 'session.error') turn.error = `session.error: ${JSON.stringify(payload.error ?? payload).slice(0, 300)}`;
      const idle = type === 'session.idle' || (type === 'session.status' && payload.status?.type === 'idle');
      if (idle && turn.busyMs !== null) { turn.idleMs = at; break; }
    }
  }
  turn.text = [...texts.values()].filter((p) => assistant.has(p.messageId)).map((p) => p.text).join(' ').trim().slice(0, 80);
  if (turn.idleMs === null) turn.error ??= 'no idle before timeout';
  if (!turn.text) turn.error ??= 'idle with no assistant text';
  if (turn.error) turn.seen = frames.slice(from, i).map((f) => (f.type === 'session.status' ? `${f.type}:${f.payload.status?.type}` : f.type)).slice(0, 60);
  return turn;
}

async function runSession(round: number): Promise<Session> {
  const s: Session = {
    label: LABEL, at: new Date().toISOString(), sessionId: null, externalId: null, provider: null, harness: null,
    createStatus: null, createMs: null, createTiming: {}, readyMs: null, turns: [],
  };
  const t0 = performance.now();
  const frames: Frame[] = [];
  let events: AbortController | null = null;
  try {
    const created = await api(`/projects/${PROJECT}/sessions`, {
      method: 'POST', body: JSON.stringify(env.BENCH_PROVIDER ? { provider: env.BENCH_PROVIDER } : {}),
    });
    Object.assign(s, { createStatus: created.status, createMs: created.ms, createTiming: created.timing });
    s.sessionId = created.body?.session_id ?? created.body?.id ?? null;
    if (!s.sessionId) throw new Error(`create ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
    let runtimeUrl: string | null = null;
    while (!s.externalId) {
      if (performance.now() - t0 > BOOT_TIMEOUT_MS) throw new Error('start never reached ready');
      const st = await api(`/projects/${PROJECT}/sessions/${s.sessionId}/start`, { method: 'POST' });
      if (st.body?.stage === 'ready') {
        s.externalId = st.body.sandbox?.external_id ?? null;
        s.provider = st.body.sandbox?.provider ?? null;
        runtimeUrl = st.body.runtime_url ?? null;
      } else if (st.body?.stage === 'failed' && st.body?.retriable === false) {
        throw new Error(`start failed: ${JSON.stringify(st.body).slice(0, 300)}`);
      } else await sleep(500);
    }
    const daemon = runtimeUrl ? runtimeUrl.replace(/^\/v1/, '') : `/p/${s.externalId}/8000`;
    while (s.readyMs === null) {
      if (performance.now() - t0 > BOOT_TIMEOUT_MS) throw new Error('runtimeReady never true');
      const h = await api(`${daemon}/kortix/health`).catch(() => null);
      if (h?.body?.runtimeReady === true) {
        s.readyMs = Math.round(performance.now() - t0);
        s.harness = h.body.harness ?? 'opencode';
      } else await sleep(250);
    }
    events = openEvents(s.sessionId, frames);
    await sleep(1000); // attach the stream before the first prompt
    const sent: string[] = [];
    for (const spec of TURNS) {
      const turn = await runTurn(s.sessionId, spec, frames, sent);
      s.turns.push(turn);
      console.error(`  ${turn.label} post=${turn.postMs}ms db=${turn.timing.db?.dur ?? '-'}ms/n=${turn.timing.db?.n ?? '-'} busy=${turn.busyMs} idle=${turn.idleMs} model=${turn.model} ${JSON.stringify(turn.text)} ${turn.error ?? ''}`);
      if (turn.error) break;
      await sleep(1000);
    }
  } catch (err) {
    s.error = err instanceof Error ? err.message : String(err);
  } finally {
    events?.abort();
    if (s.sessionId && env.BENCH_KEEP !== '1') await api(`/projects/${PROJECT}/sessions/${s.sessionId}`, { method: 'DELETE' }).catch(() => {});
  }
  console.error(`[${LABEL}] session ${round}/${SESSIONS}: create=${s.createMs}ms ready=${s.readyMs}ms provider=${s.provider} harness=${s.harness} ${s.error ?? ''}`);
  return s;
}

/** One `ProvisionTimeline.log()` line: `[provision-timeline] <kind> <id8> total=Xms a=+Nms(@T) …`. */
export function parseTimelineLine(line: string): Timeline | null {
  const m = line.match(/\[provision-timeline\] (\S+) (\S+) total=(\d+)ms(.*)/);
  if (!m) return null;
  const marks = Object.fromEntries([...m[4].matchAll(/([\w:.-]+)=\+(\d+)ms\(@\d+\)/g)].map((x) => [x[1], Number(x[2])]));
  return { kind: m[1], id: m[2], total: Number(m[3]), marks };
}

/**
 * `deliver` lines carry the prompt id (= lifecycle command id). `proxy` lines carry
 * only a sandbox id prefix, which Platinum boxes share (`sbx_01M3…`). The proxy call
 * runs inside the delivery and the bench sends one turn at a time, so a delivery's
 * proxy line is the last one printed before its deliver line.
 */
function attachLogTimelines(sessions: Session[], logPath: string): void {
  const byPrompt = new Map<string, { deliver: Timeline; proxy: Timeline | null }>();
  let proxy: Timeline | null = null;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const tl = parseTimelineLine(line);
    if (tl?.kind === 'proxy') proxy = tl;
    if (tl?.kind !== 'deliver') continue;
    if (!byPrompt.has(tl.id)) byPrompt.set(tl.id, { deliver: tl, proxy });
    proxy = null;
  }
  for (const t of sessions.flatMap((s) => s.turns)) {
    const hit = t.promptId ? byPrompt.get(t.promptId.slice(0, 8)) : undefined;
    t.deliver = hit?.deliver ?? null;
    t.proxy = hit?.proxy ?? null;
  }
}

async function attachForwarded(sessions: Session[], dbUrl: string): Promise<void> {
  const ids = sessions.flatMap((s) => s.turns.map((t) => t.promptId).filter((id): id is string => !!id));
  if (!ids.length) return;
  const sql = new SQL(dbUrl);
  const rows: Array<{ id: string; ms: number | null }> = await sql`select command_id::text as id,
      round(extract(epoch from ((result->>'forwarded_at')::timestamptz - created_at)) * 1000)::int as ms
    from kortix.session_lifecycle_commands where command_id::text in ${sql(ids)}`;
  await sql.close();
  const byId = new Map(rows.map((r) => [r.id, r.ms]));
  for (const s of sessions) for (const t of s.turns) t.forwardedMs = t.promptId ? byId.get(t.promptId) ?? null : null;
}

function pct(values: number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] : null;
}

export function table(sessions: Session[]): string {
  const ok = sessions.filter((s) => !s.error);
  const turns = sessions.flatMap((s) => s.turns.filter((t) => !t.error));
  const rows: Array<[string, number[]]> = [
    ['POST /sessions wall', ok.map((s) => s.createMs!)],
    ['POST /sessions server total', ok.map((s) => s.createTiming.total?.dur ?? NaN)],
    ['POST /sessions db dur', ok.map((s) => s.createTiming.db?.dur ?? NaN)],
    ['POST /sessions db n', ok.map((s) => s.createTiming.db?.n ?? NaN)],
    ['POST /sessions git dur', ok.map((s) => s.createTiming.git?.dur ?? NaN)],
    ['POST /sessions git n', ok.map((s) => s.createTiming.git?.n ?? NaN)],
    ['session ready (create→runtimeReady)', ok.map((s) => s.readyMs!)],
    ['POST /prompts wall', turns.map((t) => t.postMs)],
    ['POST /prompts server total', turns.map((t) => t.timing.total?.dur ?? NaN)],
    ['POST /prompts db dur', turns.map((t) => t.timing.db?.dur ?? NaN)],
    ['POST /prompts db n', turns.map((t) => t.timing.db?.n ?? NaN)],
    ['delivery: log deliver total', turns.map((t) => t.deliver?.total ?? NaN)],
    ['delivery: log proxy total', turns.map((t) => t.proxy?.total ?? NaN)],
    ['delivery: created→forwarded (DB)', turns.map((t) => t.forwardedMs ?? NaN)],
    ['POST→busy', turns.map((t) => t.busyMs ?? NaN)],
    ['POST→idle', turns.map((t) => t.idleMs ?? NaN)],
  ];
  // Per-stage deltas of the two log lines, in first-seen order: the row an R1 change moves.
  for (const kind of ['deliver', 'proxy'] as const) {
    const stages = new Map<string, number[]>();
    for (const t of turns) for (const [label, ms] of Object.entries(t[kind]?.marks ?? {})) stages.set(label, [...(stages.get(label) ?? []), ms]);
    for (const [label, values] of stages) rows.push([`  ${kind} ${label}`, values]);
  }
  const lines = [
    `label=${[...new Set(sessions.map((s) => s.label))].join(',')} sessions ok ${ok.length}/${sessions.length}, turns ok ${turns.length}/${sessions.flatMap((s) => s.turns).length}` +
      `, providers ${[...new Set(ok.map((s) => s.provider))].join(',')}, harness ${[...new Set(ok.map((s) => s.harness))].join(',')}` +
      `, models ${[...new Set(turns.map((t) => t.model))].join(',')}`,
    `${'metric (ms; n = count)'.padEnd(38)}${'n'.padStart(5)}${'p50'.padStart(8)}${'p90'.padStart(8)}`,
  ];
  for (const [name, values] of rows) {
    const n = values.filter(Number.isFinite).length;
    lines.push(`${name.padEnd(38)}${String(n).padStart(5)}${String(pct(values, 50) ?? '-').padStart(8)}${String(pct(values, 90) ?? '-').padStart(8)}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'report') {
    const sessions = process.argv.slice(3).flatMap((f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Session));
    if (env.BENCH_API_LOG) attachLogTimelines(sessions, env.BENCH_API_LOG);
    console.log(table(sessions));
    return;
  }
  if (!API || !TOKEN || !PROJECT) throw new Error('BENCH_API, BENCH_TOKEN and BENCH_PROJECT are required');
  const sessions: Session[] = [];
  for (let round = 1; round <= SESSIONS; round++) sessions.push(await runSession(round));
  if (env.BENCH_API_LOG) {
    await sleep(2000); // the last delivery line flushes after its turn ends
    attachLogTimelines(sessions, env.BENCH_API_LOG);
  }
  if (env.BENCH_DB_URL) await attachForwarded(sessions, env.BENCH_DB_URL);
  mkdirSync(dirname(OUT), { recursive: true });
  for (const s of sessions) appendFileSync(OUT, `${JSON.stringify(s)}\n`);
  console.log(table(sessions));
  console.error(`wrote ${sessions.length} sessions to ${OUT}`);
}

if (import.meta.main) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}
