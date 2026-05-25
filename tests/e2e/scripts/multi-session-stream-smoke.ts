#!/usr/bin/env bun
/**
 * Live MULTI-SESSION concurrent-stream smoke test.
 *
 * Verifies the capability the frontend's SessionStreamKeeper relies on: several
 * project session sandboxes can be connected AND streaming SSE events AT THE
 * SAME TIME from one client — i.e. a backgrounded session never "stops".
 *
 *   user -> project (snapshot) -> 2 sessions -> 2 sandboxes active ->
 *   open 2 concurrent SSE streams -> prompt session A -> assert stream A gets
 *   events WHILE stream B stays connected -> prompt session B -> assert stream B
 *   gets events WHILE stream A stays connected -> cleanup.
 *
 * Run (dev stack up — `pnpm dev`):
 *   bun tests/e2e/scripts/multi-session-stream-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const API_ENV = resolve(REPO_ROOT, 'apps/api/.env');
const WEB_ENV = resolve(REPO_ROOT, 'apps/web/.env');

function fromEnvFile(file: string, key: string): string | null {
  try {
    const m = readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}
function need(v: string | null | undefined, what: string): string {
  if (!v) { console.error(`[multi] missing ${what}`); process.exit(2); }
  return v;
}

const API = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const SUPABASE = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = need(fromEnvFile(API_ENV, 'SUPABASE_SERVICE_ROLE_KEY'), 'SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = need(fromEnvFile(WEB_ENV, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'), 'anon key');
const OPENROUTER = need(fromEnvFile(API_ENV, 'OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY');
const MODEL = process.env.E2E_MODEL || 'openrouter/openai/gpt-4o-mini';
const [MODEL_PROVIDER, ...REST] = MODEL.split('/');
const MODEL_ID = REST.join('/');

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(`[${ts()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let JWT = '';
let PASS = 0, FAIL = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  cond ? PASS++ : FAIL++;
  log(`${cond ? '✅' : '❌'} ${label}${extra ? '  — ' + extra : ''}`);
  return cond;
};

async function api(method: string, path: string, body?: unknown, token = JWT) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

/** A live SSE consumer for one sandbox. Counts events; tracks connectivity. */
function openStream(ext: string, label: string) {
  const ctrl = new AbortController();
  const state = { label, ext, events: 0, lastType: '', connected: false, error: '' };
  (async () => {
    try {
      const res = await fetch(`${API}/p/${ext}/8000/event`, {
        headers: { Authorization: `Bearer ${JWT}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) { state.error = `HTTP ${res.status}`; return; }
      state.connected = true;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          state.events++;
          try {
            const e = JSON.parse(dataLine.slice(5).trim());
            const payload = e?.payload ?? e;
            if (payload?.type) state.lastType = payload.type;
          } catch { /* heartbeat / non-json */ }
        }
      }
    } catch (err: any) {
      if (!ctrl.signal.aborted) state.error = String(err?.message || err);
    } finally {
      state.connected = false;
    }
  })();
  return { state, close: () => ctrl.abort() };
}

async function waitSandbox(projectId: string, sessionId: string, label: string): Promise<string> {
  log(`Polling sandbox for ${label}...`);
  let ext = '', status = '';
  const end = Date.now() + 6 * 60_000;
  while (Date.now() < end) {
    const sb = await api('GET', `/projects/${projectId}/sessions/${sessionId}/sandbox`);
    if (sb.status === 404) { await sleep(4000); continue; }
    status = sb.json?.status ?? '';
    ext = sb.json?.external_id || '';
    if (status === 'active' || status === 'error' || status === 'failed') break;
    await sleep(5000);
  }
  ok(`${label} sandbox active`, status === 'active', `status=${status} ext=${ext || '—'}`);
  return status === 'active' ? ext : '';
}

async function probeOpenCode(ext: string, label: string): Promise<boolean> {
  const end = Date.now() + 2 * 60_000;
  let last = '';
  while (Date.now() < end) {
    const p = await api('GET', `/p/${ext}/8000/config`);
    last = `${p.status}`;
    if (p.status === 200) return ok(`${label} OpenCode reachable`, true);
    await sleep(5000);
  }
  return ok(`${label} OpenCode reachable`, false, last);
}

async function promptOC(ext: string): Promise<string> {
  const oc = await api('POST', `/p/${ext}/8000/session`, {});
  const ocId = oc.json?.id;
  if (!ocId) return '';
  await api('POST', `/p/${ext}/8000/session/${ocId}/prompt_async`, {
    parts: [{ type: 'text', text: 'Reply with exactly one word: PONG' }],
    model: { providerID: MODEL_PROVIDER, modelID: MODEL_ID },
  });
  return ocId;
}

async function main() {
  log(`=== multi-session concurrent stream smoke === API=${API}`);

  const email = `e2e-multistream-${Date.now()}@example.test`;
  const password = 'TestPass123!multi';
  const adminRes = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!ok('create user', adminRes.ok, `${adminRes.status}`)) return finish();
  JWT = (await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json()).access_token;
  if (!ok('JWT', !!JWT)) return finish();

  const accts = await api('GET', '/accounts');
  const accountId = Array.isArray(accts.json) ? (accts.json.find((a: any) => a.personal_account)?.account_id ?? accts.json[0]?.account_id) : null;
  if (!ok('account', !!accountId)) return finish();

  const prov = await api('POST', '/projects/provision', { account_id: accountId, name: `e2e multistream ${Date.now().toString().slice(-6)}`, seed_starter: true });
  const projectId = prov.json?.project_id || prov.json?.id;
  if (!ok('provision project', !!projectId, `${prov.status}`)) return finish();
  await api('POST', `/projects/${projectId}/secrets`, { name: 'OPENROUTER_API_KEY', value: OPENROUTER });

  log('Polling snapshot...');
  let snapReady = false;
  const snapEnd = Date.now() + 9 * 60_000;
  while (Date.now() < snapEnd) {
    const s = await api('GET', `/projects/${projectId}/snapshots`);
    const list = s.json?.items ?? s.json?.snapshots ?? (Array.isArray(s.json) ? s.json : []);
    if (list.some((x: any) => x.status === 'ready')) { snapReady = true; break; }
    if (list.length && list.every((x: any) => x.status === 'failed')) break;
    await sleep(10_000);
  }
  if (!ok('snapshot ready', snapReady)) return finish({ projectId });

  // Two sessions in parallel.
  const s1 = await api('POST', `/projects/${projectId}/sessions`, { name: 'session A' });
  const s2 = await api('POST', `/projects/${projectId}/sessions`, { name: 'session B' });
  const sid1 = s1.json?.session_id || s1.json?.id;
  const sid2 = s2.json?.session_id || s2.json?.id;
  if (!ok('two sessions created', !!sid1 && !!sid2, `${sid1} / ${sid2}`)) return finish({ projectId });

  const [ext1, ext2] = await Promise.all([
    waitSandbox(projectId, sid1, 'A'),
    waitSandbox(projectId, sid2, 'B'),
  ]);
  if (!ext1 || !ext2) return finish({ projectId, sessionIds: [sid1, sid2] });

  await Promise.all([probeOpenCode(ext1, 'A'), probeOpenCode(ext2, 'B')]);

  // ── The actual assertion: BOTH streams open and live at the same time ──
  log('Opening TWO concurrent SSE streams...');
  const A = openStream(ext1, 'A');
  const B = openStream(ext2, 'B');
  await sleep(3000);
  ok('both streams connected simultaneously', A.state.connected && B.state.connected,
    `A=${A.state.connected} B=${B.state.connected} ${A.state.error || B.state.error}`);

  const aBefore = A.state.events, bBefore = B.state.events;

  log('Prompting session A (B must stay connected)...');
  await promptOC(ext1);
  await sleep(20_000);
  ok('stream A received events from its agent', A.state.events > aBefore, `A events ${aBefore}->${A.state.events} (last=${A.state.lastType})`);
  ok('stream B still connected while A worked', B.state.connected, `B connected=${B.state.connected}`);

  const bMid = B.state.events;
  log('Prompting session B (A must stay connected)...');
  await promptOC(ext2);
  await sleep(20_000);
  ok('stream B received events from its agent', B.state.events > bMid, `B events ${bMid}->${B.state.events} (last=${B.state.lastType})`);
  ok('stream A still connected while B worked', A.state.connected, `A connected=${A.state.connected}`);

  ok('BOTH sandboxes streamed in parallel', A.state.events > aBefore && B.state.events > bBefore,
    `A=${A.state.events} B=${B.state.events}`);

  A.close(); B.close();
  return finish({ projectId, sessionIds: [sid1, sid2] });
}

async function finish(cleanup?: { projectId?: string; sessionIds?: string[] }) {
  try {
    for (const sid of cleanup?.sessionIds ?? []) {
      if (sid) await api('DELETE', `/projects/${cleanup!.projectId}/sessions/${sid}`);
    }
    if (cleanup?.projectId) await api('DELETE', `/projects/${cleanup.projectId}`);
  } catch { /* best effort */ }
  log('==============================');
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { log('FATAL', e?.message || e); process.exit(2); });
