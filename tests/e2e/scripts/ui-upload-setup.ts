#!/usr/bin/env bun
/**
 * Setup helper for the browser-driven upload check: creates a confirmed user,
 * seeds credits, provisions a project (waits for a ready snapshot), creates a
 * session and waits for the sandbox to go active. Prints JSON the browser
 * driver consumes: { email, password, projectId, sessionId, ext, url }.
 */
import { resolve } from 'node:path';
import { optionalEnvValue } from '../helpers/env';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const API_ENV = resolve(REPO_ROOT, 'apps/api/.env');
const WEB_ENV = resolve(REPO_ROOT, 'apps/web/.env');
const API = 'http://localhost:8008/v1';
const SUPABASE = 'http://127.0.0.1:54321';
const SERVICE_KEY = optionalEnvValue('SUPABASE_SERVICE_ROLE_KEY', API_ENV)!;
const ANON_KEY = optionalEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', WEB_ENV)!;
const OPENROUTER = optionalEnvValue('OPENROUTER_API_KEY', API_ENV);
const DB_URL = optionalEnvValue('DATABASE_URL', API_ENV) || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (m: string) => { console.error(JSON.stringify({ error: m })); process.exit(1); };

let JWT = '';
async function rfetch(url: string, init?: RequestInit, attempts = 5): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fetch(url, init); } catch (e) { last = e; await sleep(500 * (i + 1)); }
  }
  throw last;
}
async function api(method: string, path: string, body?: unknown) {
  const res = await rfetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${JWT}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

const email = `e2e-ui-${Date.now()}@example.test`;
const password = 'TestPass123!ui';
await fetch(`${SUPABASE}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
const tok = await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
JWT = tok.access_token; if (!JWT) err('no JWT');

const accts = await api('GET', '/accounts');
const accountId = Array.isArray(accts.json) ? (accts.json.find((a: any) => a.personal_account)?.account_id ?? accts.json[0]?.account_id) : null;
if (!accountId) err('no account');
{
  const sql = `INSERT INTO kortix.credit_accounts (account_id, balance, tier) VALUES ('${accountId}', 1000, 'free') ON CONFLICT (account_id) DO UPDATE SET balance = 1000;`;
  const p = Bun.spawn(['psql', DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdout: 'ignore', stderr: 'pipe' });
  if (await p.exited !== 0) err('credit seed failed: ' + (await new Response(p.stderr).text()).slice(0, 200));
}

const prov = await api('POST', '/projects/provision', { account_id: accountId, name: `e2e ui ${Date.now().toString().slice(-6)}`, seed_starter: true });
const projectId = prov.json?.project_id || prov.json?.id; if (!projectId) err('provision failed: ' + prov.text.slice(0, 200));
if (OPENROUTER) await api('POST', `/projects/${projectId}/secrets`, { name: 'OPENROUTER_API_KEY', value: OPENROUTER });

const snapEnd = Date.now() + 11 * 60_000; let ready = false;
while (Date.now() < snapEnd) {
  const s = await api('GET', `/projects/${projectId}/snapshots`);
  const templates: any[] = s.json?.templates ?? []; const builds: any[] = s.json?.builds ?? [];
  if (templates.some((t) => t.ready) || builds.some((b) => b.status === 'ready')) { ready = true; break; }
  if (builds.length && builds.every((b) => b.status === 'failed')) err('snapshot build failed');
  await sleep(8000);
}
if (!ready) err('snapshot not ready in time');

const sess = await api('POST', `/projects/${projectId}/sessions`, { name: 'ui upload session' });
const sessionId = sess.json?.session_id || sess.json?.id; if (!sessionId) err('session create failed: ' + sess.text.slice(0, 200));

let ext = '', sbStatus = ''; const sbEnd = Date.now() + 5 * 60_000;
while (Date.now() < sbEnd) {
  const sb = await api('GET', `/projects/${projectId}/sessions/${sessionId}/sandbox`);
  if (sb.status === 404) { await sleep(4000); continue; }
  sbStatus = sb.json?.status ?? ''; ext = sb.json?.external_id || sb.json?.externalId || '';
  if (sbStatus === 'active' || sbStatus === 'error' || sbStatus === 'failed') break;
  await sleep(4000);
}
if (sbStatus !== 'active') err('sandbox not active: ' + sbStatus);

// warm the opencode runtime so the UI connects fast
const pEnd = Date.now() + 2 * 60_000;
while (Date.now() < pEnd) { const p = await api('GET', `/p/${ext}/8000/config`); if (p.status === 200) break; await sleep(4000); }

console.log(JSON.stringify({ email, password, accountId, projectId, sessionId, ext, url: `http://localhost:3000/projects/${projectId}/sessions/${sessionId}` }));
