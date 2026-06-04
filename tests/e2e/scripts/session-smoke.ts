#!/usr/bin/env bun
/**
 * Live session smoke test — drives the full Kortix session flow against a
 * running stack and asserts an agent actually replies.
 *
 *   CRUD project -> snapshot ready -> set provider secret -> CRUD session ->
 *   sandbox active -> OpenCode reachable -> prompt -> assistant reply -> cleanup
 *
 * Run (with the dev stack up — `pnpm dev`):
 *   bun tests/e2e/scripts/session-smoke.ts
 *
 * Config (all optional; sensible local defaults):
 *   E2E_API_URL            API base incl. /v1   (default http://localhost:8008/v1)
 *   E2E_SUPABASE_URL       GoTrue base           (default http://127.0.0.1:54321)
 *   E2E_SERVICE_ROLE_KEY   Supabase service key  (default: apps/api/.env)
 *   E2E_ANON_KEY           Supabase anon key     (default: apps/web/.env)
 *   E2E_OPENROUTER_API_KEY model key for the run (default: apps/api/.env OPENROUTER_API_KEY)
 *   E2E_MODEL              opencode model id     (default openrouter/openai/gpt-4o-mini)
 *
 * Exit code 0 = all assertions passed, non-zero = a failure (CI-friendly).
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
function need(value: string | null | undefined, what: string): string {
  if (!value) {
    console.error(`[smoke] missing ${what} — set it via env or the local .env files`);
    process.exit(2);
  }
  return value;
}

const API = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const SUPABASE = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = need(process.env.E2E_SERVICE_ROLE_KEY || fromEnvFile(API_ENV, 'SUPABASE_SERVICE_ROLE_KEY'), 'SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = need(process.env.E2E_ANON_KEY || fromEnvFile(WEB_ENV, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'), 'SUPABASE anon key');
const OPENROUTER = process.env.E2E_OPENROUTER_API_KEY || fromEnvFile(API_ENV, 'OPENROUTER_API_KEY');
const MODEL = process.env.E2E_MODEL || 'openrouter/openai/gpt-4o-mini';
const [MODEL_PROVIDER, ...MODEL_REST] = MODEL.split('/');
const MODEL_ID = MODEL_REST.join('/');

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

async function main() {
  log(`=== Kortix session smoke === API=${API}`);

  // 1. fresh confirmed user + JWT (GoTrue admin API)
  const email = `e2e-smoke-${Date.now()}@example.test`;
  const password = 'TestPass123!smoke';
  const adminRes = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!ok('create test user', adminRes.ok, `${adminRes.status}`)) return finish();
  const tok = await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  JWT = tok.access_token;
  if (!ok('password grant -> JWT', !!JWT)) return finish();

  // 2. account
  const accts = await api('GET', '/accounts');
  const accountId = Array.isArray(accts.json) ? (accts.json.find((a: any) => a.personal_account)?.account_id ?? accts.json[0]?.account_id) : null;
  if (!ok('personal account', !!accountId, accountId ?? accts.text.slice(0, 120))) return finish();

  // 3. project CRUD — provision (managed + seed starter; triggers snapshot build)
  const prov = await api('POST', '/projects/provision', { account_id: accountId, name: `e2e ${Date.now().toString().slice(-6)}`, seed_starter: true });
  const projectId = prov.json?.project_id || prov.json?.id;
  if (!ok('POST /projects/provision', !!projectId, `${prov.status} ${prov.text.slice(0, 160)}`)) return finish();
  ok('GET /projects/:id (read)', (await api('GET', `/projects/${projectId}`)).status === 200);
  ok('PATCH /projects/:id (rename)', (await api('PATCH', `/projects/${projectId}`, { name: 'e2e renamed' })).status === 200);

  // 4. provider key as a project secret (so opencode has a model)
  if (OPENROUTER) {
    ok('POST secret OPENROUTER_API_KEY', (await api('POST', `/projects/${projectId}/secrets`, { name: 'OPENROUTER_API_KEY', value: OPENROUTER })).status === 200);
  } else {
    log('⚠️  no OPENROUTER key — skipping secret + reply assertions (infra-only run)');
  }

  // 5. wait for a ready snapshot of the base branch
  log('Polling snapshot build...');
  let snapReady = false;
  const snapEnd = Date.now() + 9 * 60_000;
  while (Date.now() < snapEnd) {
    const s = await api('GET', `/projects/${projectId}/snapshots`);
    const list = s.json?.items ?? s.json?.snapshots ?? (Array.isArray(s.json) ? s.json : []);
    log('   snapshots:', list.map((x: any) => `${x.branch ?? '?'}:${x.status}`).join(',') || 'none');
    if (list.some((x: any) => x.status === 'ready')) { snapReady = true; break; }
    if (list.length && list.every((x: any) => x.status === 'failed')) { ok('snapshot build', false, list[0]?.error?.slice(0, 100)); break; }
    await sleep(10_000);
  }
  if (!ok('snapshot ready', snapReady)) return finish({ projectId });

  // 6. session CRUD — create / list / read / rename
  const sess = await api('POST', `/projects/${projectId}/sessions`, { name: 'e2e session' });
  const sessionId = sess.json?.session_id || sess.json?.id;
  if (!ok('POST /projects/:id/sessions', !!sessionId, `${sess.status} ${sess.text.slice(0, 160)}`)) return finish({ projectId });
  ok('GET sessions (list)', (await api('GET', `/projects/${projectId}/sessions`)).status === 200);
  ok('GET session (read)', (await api('GET', `/projects/${projectId}/sessions/${sessionId}`)).status === 200);
  ok('PATCH session (rename)', (await api('PATCH', `/projects/${projectId}/sessions/${sessionId}`, { name: 'e2e session 2' })).status === 200);

  // 7. wait for sandbox active
  log('Polling sandbox...');
  let ext = '', sbStatus = '';
  const sbEnd = Date.now() + 5 * 60_000;
  while (Date.now() < sbEnd) {
    const sb = await api('GET', `/projects/${projectId}/sessions/${sessionId}/sandbox`);
    if (sb.status === 404) { await sleep(4000); continue; }
    sbStatus = sb.json?.status ?? ''; ext = sb.json?.external_id || sb.json?.externalId || '';
    log(`   sandbox: status=${sbStatus} ext=${ext || '—'}`);
    if (sbStatus === 'active' || sbStatus === 'error' || sbStatus === 'failed') break;
    await sleep(5000);
  }
  if (!ok('sandbox active', sbStatus === 'active', `status=${sbStatus}`) || !ext) return finish({ projectId, sessionId });

  // 8. OpenCode reachable via preview proxy
  log('Probing OpenCode runtime...');
  let up = false, lastProbe = '';
  const pEnd = Date.now() + 2 * 60_000;
  while (Date.now() < pEnd) {
    const p = await api('GET', `/p/${ext}/8000/config`);
    lastProbe = `${p.status} ${String(p.text).slice(0, 100)}`;
    if (p.status === 200) { up = true; break; }
    await sleep(5000);
  }
  if (!ok('OpenCode runtime reachable', up, lastProbe)) return finish({ projectId, sessionId });

  // 9. create OpenCode session, prompt, assert a real assistant reply
  const oc = await api('POST', `/p/${ext}/8000/session`, {});
  const ocId = oc.json?.id;
  if (!ok('create OpenCode session', !!ocId, `${oc.status} ${oc.text.slice(0, 120)}`)) return finish({ projectId, sessionId });

  if (OPENROUTER) {
    const prompt = await api('POST', `/p/${ext}/8000/session/${ocId}/prompt_async`, {
      parts: [{ type: 'text', text: 'Reply with exactly one word: PONG' }],
      model: { providerID: MODEL_PROVIDER, modelID: MODEL_ID },
    });
    ok('POST prompt_async', prompt.status === 204 || prompt.status === 200, `${prompt.status} ${prompt.text.slice(0, 120)}`);

    log('Waiting for a real assistant reply...');
    let assistantText = '';
    const rEnd = Date.now() + 2 * 60_000;
    while (Date.now() < rEnd) {
      const m = await api('GET', `/p/${ext}/8000/session/${ocId}/message`);
      const items = Array.isArray(m.json) ? m.json : (m.json?.messages ?? []);
      for (const entry of items) {
        if ((entry?.info?.role ?? entry?.role) !== 'assistant') continue;
        const parts = entry?.parts ?? entry?.info?.parts ?? [];
        const txt = parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
        if (txt) assistantText = txt;
      }
      if (assistantText) break;
      await sleep(3000);
    }
    ok('assistant replied', !!assistantText, assistantText ? `"${assistantText.slice(0, 100)}"` : 'no assistant text in 2m');
    ok('reply contains PONG', /pong/i.test(assistantText), assistantText.slice(0, 60));
  }

  return finish({ projectId, sessionId });
}

async function finish(cleanup?: { projectId?: string; sessionId?: string }) {
  if (cleanup?.sessionId) ok('DELETE session', (await api('DELETE', `/projects/${cleanup.projectId}/sessions/${cleanup.sessionId}`)).status === 200);
  if (cleanup?.projectId) { const d = await api('DELETE', `/projects/${cleanup.projectId}`); ok('DELETE project', d.status === 200 || d.status === 204, `${d.status}`); }
  log('==============================');
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { log('FATAL', e?.message || e); process.exit(2); });
