#!/usr/bin/env bun
/**
 * Live file-upload smoke test — proves the full "upload files into a session
 * sandbox and reference them" flow works end-to-end against a running stack.
 *
 *   user/JWT -> provision project -> snapshot ready -> session -> sandbox active
 *   -> OpenCode reachable -> POST /file/upload (multipart) -> GET /file/content
 *   (read back, assert bytes match) -> field-name-as-path upload -> collision
 *   auto-suffix -> mkdir -> rename -> delete -> agent reads the uploaded file
 *
 * Run (with the dev stack up — `pnpm dev`, and after rebuilding the daemon
 * binary: `bun run build` in apps/kortix-sandbox-agent-server so the new
 * /file/* write routes are baked into the snapshot):
 *   bun tests/e2e/scripts/file-upload-smoke.ts
 *
 * Exit 0 = all assertions passed.
 */
import { resolve } from 'node:path';
import { optionalEnvValue } from '../helpers/env';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const API_ENV = resolve(REPO_ROOT, 'apps/api/.env');
const WEB_ENV = resolve(REPO_ROOT, 'apps/web/.env');

function need(value: string | null | undefined, what: string): string {
  if (!value) { console.error(`[upload] missing ${what}`); process.exit(2); }
  return value;
}

const API = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const SUPABASE = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = need(process.env.E2E_SERVICE_ROLE_KEY || optionalEnvValue('SUPABASE_SERVICE_ROLE_KEY', API_ENV), 'SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = need(process.env.E2E_ANON_KEY || optionalEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', WEB_ENV), 'SUPABASE anon key');
const OPENROUTER = process.env.E2E_OPENROUTER_API_KEY || optionalEnvValue('OPENROUTER_API_KEY', API_ENV);
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

// fetch that survives transient socket closes / tunnel blips (the cloudflared
// quick tunnel + Daytona proxy can drop a long-poll connection). Retries a
// handful of times with short backoff before giving up.
async function rfetch(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

async function api(method: string, path: string, body?: unknown, token = JWT) {
  const res = await rfetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

// Proxy a raw request to the sandbox daemon (port 8000) through the API.
async function proxy(ext: string, method: string, path: string, init?: RequestInit) {
  const res = await rfetch(`${API}/p/${ext}/8000${path}`, {
    method,
    ...init,
    headers: { Authorization: `Bearer ${JWT}`, ...(init?.headers || {}) },
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

const DB_URL = process.env.E2E_DATABASE_URL || optionalEnvValue('DATABASE_URL', API_ENV) || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// Seed a funded credit account for the given account so billing-gated session
// creation passes in dev. Idempotent (upsert). Uses psql against the local DB.
async function seedCredits(accountId: string): Promise<boolean> {
  const sql = `INSERT INTO kortix.credit_accounts (account_id, balance, tier) VALUES ('${accountId}', 1000, 'free') ON CONFLICT (account_id) DO UPDATE SET balance = 1000;`;
  const proc = Bun.spawn(['psql', DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) log('   seedCredits stderr:', (await new Response(proc.stderr).text()).slice(0, 200));
  return code === 0;
}

async function main() {
  log(`=== Kortix file-upload smoke === API=${API}`);

  // 1. user + JWT
  const email = `e2e-upload-${Date.now()}@example.test`;
  const password = 'TestPass123!upload';
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

  // 2b. seed a credit account (billing is enabled in dev; sessions 402 without
  //     one). Direct DB insert into the local Postgres — a dev-env requirement,
  //     unrelated to the upload flow under test.
  ok('seed credit account', await seedCredits(accountId), '');

  // 3. provision project (managed + starter -> snapshot build)
  const prov = await api('POST', '/projects/provision', { account_id: accountId, name: `e2e upload ${Date.now().toString().slice(-6)}`, seed_starter: true });
  const projectId = prov.json?.project_id || prov.json?.id;
  if (!ok('POST /projects/provision', !!projectId, `${prov.status} ${prov.text.slice(0, 160)}`)) return finish();
  if (OPENROUTER) await api('POST', `/projects/${projectId}/secrets`, { name: 'OPENROUTER_API_KEY', value: OPENROUTER });

  // 4. snapshot ready — the refactored endpoint returns { templates, builds }.
  //    A template is usable when `ready: true` (image present on the provider).
  log('Polling snapshot build (rebuilds with the new daemon binary on first build)...');
  let snapReady = false;
  const snapEnd = Date.now() + 11 * 60_000;
  while (Date.now() < snapEnd) {
    const s = await api('GET', `/projects/${projectId}/snapshots`);
    const templates: any[] = s.json?.templates ?? [];
    const builds: any[] = s.json?.builds ?? [];
    const tStates = templates.map((t) => `${t.slug}:${t.ready ? 'ready' : t.daytona_state || t.provider_state || '?'}`).join(',');
    const bStates = builds.map((b) => b.status).join(',');
    log(`   templates:[${tStates || 'none'}] builds:[${bStates || 'none'}]`);
    if (templates.some((t) => t.ready) || builds.some((b) => b.status === 'ready')) { snapReady = true; break; }
    if (builds.length && builds.every((b) => b.status === 'failed')) { ok('snapshot build', false, builds[0]?.error?.slice(0, 200)); break; }
    await sleep(10_000);
  }
  if (!ok('snapshot ready', snapReady)) return finish({ projectId });

  // 5. session
  const sess = await api('POST', `/projects/${projectId}/sessions`, { name: 'upload session' });
  const sessionId = sess.json?.session_id || sess.json?.id;
  if (!ok('POST session', !!sessionId, `${sess.status} ${sess.text.slice(0, 160)}`)) return finish({ projectId });

  // 6. sandbox active
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

  // 7. OpenCode reachable
  log('Probing OpenCode runtime...');
  let up = false, lastProbe = '';
  const pEnd = Date.now() + 2 * 60_000;
  while (Date.now() < pEnd) {
    const p = await proxy(ext, 'GET', '/config');
    lastProbe = `${p.status} ${String(p.text).slice(0, 100)}`;
    if (p.status === 200) { up = true; break; }
    await sleep(5000);
  }
  if (!ok('OpenCode runtime reachable', up, lastProbe)) return finish({ projectId, sessionId });

  // ===== THE ACTUAL FILE-UPLOAD ASSERTIONS =====

  const fileBody = `hello from e2e upload ${Date.now()}\nline2\n`;
  const fileName = 'e2e-note.txt';

  // 8. upload via `path` + `file` convention (matches apps/web uploadFile())
  const form = new FormData();
  form.append('path', '/workspace/uploads');
  form.append('file', new File([fileBody], fileName, { type: 'text/plain' }));
  const up1 = await proxy(ext, 'POST', '/file/upload', { body: form });
  const uploadedPath = Array.isArray(up1.json) ? up1.json[0]?.path : undefined;
  if (!ok('POST /file/upload (path+file)', up1.status === 200 && !!uploadedPath, `${up1.status} ${up1.text.slice(0, 200)}`)) return finish({ projectId, sessionId });
  ok('uploaded path under /workspace/uploads', String(uploadedPath).startsWith('/workspace/uploads/'), String(uploadedPath));
  ok('upload reports correct byte size', Array.isArray(up1.json) && up1.json[0]?.size === Buffer.byteLength(fileBody), `${up1.json?.[0]?.size} vs ${Buffer.byteLength(fileBody)}`);

  // 9. read the bytes back through OpenCode's /file/content (proves it landed
  //    on the sandbox filesystem and the read path still works through the proxy)
  const readBack = await proxy(ext, 'GET', `/file/content?path=${encodeURIComponent('uploads/' + fileName)}`);
  const content = readBack.json?.content ?? readBack.json?.text;
  ok('GET /file/content reads it back', readBack.status === 200, `${readBack.status} ${readBack.text.slice(0, 120)}`);
  ok('read-back content matches uploaded bytes', typeof content === 'string' && content.includes('hello from e2e upload'), String(content).slice(0, 80));

  // 10. collision: upload the same name again -> server auto-suffixes
  const form2 = new FormData();
  form2.append('path', '/workspace/uploads');
  form2.append('file', new File(['second version'], fileName, { type: 'text/plain' }));
  const up2 = await proxy(ext, 'POST', '/file/upload', { body: form2 });
  const path2 = Array.isArray(up2.json) ? up2.json[0]?.path : undefined;
  ok('collision upload succeeds', up2.status === 200 && !!path2, `${up2.status}`);
  ok('collision auto-suffixed (no overwrite)', !!path2 && path2 !== uploadedPath, `${path2} vs ${uploadedPath}`);

  // 11. field-name-as-path convention (used by copyFile/createFile in apps/web)
  const form3 = new FormData();
  form3.append('/workspace/uploads/sub/dir/deep.md', new File(['# deep'], 'deep.md'), 'deep.md');
  const up3 = await proxy(ext, 'POST', '/file/upload', { body: form3 });
  const path3 = Array.isArray(up3.json) ? up3.json[0]?.path : undefined;
  ok('field-name-as-path upload', up3.status === 200 && path3 === '/workspace/uploads/sub/dir/deep.md', `${up3.status} ${path3}`);

  // 12. mkdir
  const mk = await proxy(ext, 'POST', '/file/mkdir', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/workspace/uploads/madedir' }) });
  ok('POST /file/mkdir', mk.status === 200, `${mk.status} ${mk.text.slice(0, 120)}`);

  // 13. rename/move the uploaded file
  const rn = await proxy(ext, 'POST', '/file/rename', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: uploadedPath, to: '/workspace/uploads/madedir/renamed.txt' }) });
  ok('POST /file/rename', rn.status === 200, `${rn.status} ${rn.text.slice(0, 120)}`);
  const readMoved = await proxy(ext, 'GET', `/file/content?path=${encodeURIComponent('uploads/madedir/renamed.txt')}`);
  ok('renamed file readable at new path', readMoved.status === 200 && String(readMoved.json?.content ?? readMoved.json?.text).includes('hello from e2e upload'), `${readMoved.status}`);

  // 14. delete it
  const del = await proxy(ext, 'DELETE', '/file', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/workspace/uploads/madedir/renamed.txt' }) });
  ok('DELETE /file', del.status === 200, `${del.status} ${del.text.slice(0, 120)}`);
  const readGone = await proxy(ext, 'GET', `/file/content?path=${encodeURIComponent('uploads/madedir/renamed.txt')}`);
  ok('deleted file no longer readable', readGone.status !== 200 || !String(readGone.json?.content ?? readGone.json?.text ?? '').includes('hello from e2e upload'), `${readGone.status}`);

  // 15. the end-to-end purpose: the agent can reference an uploaded file.
  if (OPENROUTER) {
    // upload a file with a known marker word and ask the agent to read it
    const marker = `KORTIX_MARKER_${Date.now().toString(36).toUpperCase()}`;
    const f = new FormData();
    f.append('path', '/workspace/uploads');
    f.append('file', new File([`The secret word is ${marker}.\n`], 'secret.txt', { type: 'text/plain' }));
    const upS = await proxy(ext, 'POST', '/file/upload', { body: f });
    const secretPath = Array.isArray(upS.json) ? upS.json[0]?.path : undefined;
    ok('upload secret file for agent', upS.status === 200 && !!secretPath, `${upS.status}`);

    const oc = await proxy(ext, 'POST', '/session', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const ocId = oc.json?.id;
    if (ok('create OpenCode session', !!ocId, `${oc.status}`)) {
      // Mirror the apps/web convention: a <file ...> XML ref pointing at the path.
      const promptText = `Read the file at ${secretPath} and reply with ONLY the secret word it contains.\n\n<file path="${secretPath}" mime="text/plain" filename="secret.txt">\nThis file has been uploaded and is available at the path above.\n</file>`;
      const prompt = await proxy(ext, 'POST', `/session/${ocId}/prompt_async`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: promptText }], model: { providerID: MODEL_PROVIDER, modelID: MODEL_ID } }),
      });
      ok('POST prompt_async (agent reads file)', prompt.status === 200 || prompt.status === 204, `${prompt.status} ${prompt.text.slice(0, 120)}`);

      log('Waiting for the agent to read the uploaded file...');
      let assistantText = '';
      const rEnd = Date.now() + 3 * 60_000;
      while (Date.now() < rEnd) {
        const m = await proxy(ext, 'GET', `/session/${ocId}/message`);
        const items = Array.isArray(m.json) ? m.json : (m.json?.messages ?? []);
        for (const entry of items) {
          if ((entry?.info?.role ?? entry?.role) !== 'assistant') continue;
          const parts = entry?.parts ?? entry?.info?.parts ?? [];
          const txt = parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
          if (txt) assistantText = txt;
        }
        if (assistantText.includes(marker)) break;
        await sleep(3000);
      }
      ok('agent read uploaded file content', assistantText.includes(marker), assistantText ? `"${assistantText.slice(0, 120)}"` : 'no reply in 3m');
    }
  } else {
    log('⚠️  no OPENROUTER key — skipping agent-reads-file assertion (file I/O still fully verified)');
  }

  return finish({ projectId, sessionId });
}

async function finish(cleanup?: { projectId?: string; sessionId?: string }) {
  if (cleanup?.sessionId) await api('DELETE', `/projects/${cleanup.projectId}/sessions/${cleanup.sessionId}`);
  if (cleanup?.projectId) await api('DELETE', `/projects/${cleanup.projectId}`);
  log('==============================');
  log(`RESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => { log('FATAL', e?.message || e); process.exit(2); });
