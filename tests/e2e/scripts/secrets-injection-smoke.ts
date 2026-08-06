#!/usr/bin/env -S node --experimental-strip-types

/**
 * Real provider secrets-delivery smoke:
 * auth -> disposable project + secret -> session without an explicit scope ->
 * sandbox boot injection -> verified sync replay -> deny-all scope -> restore
 * inherited scope -> delete + revocation -> cleanup.
 *
 * The script never prints the sentinel value. Every shell assertion emits only
 * PRESENT or ABSENT.
 *
 * Run with the isolated stack up:
 *   dotenvx run -f apps/api/.env -f apps/web/.env -- \
 *     node --experimental-strip-types tests/e2e/scripts/secrets-injection-smoke.ts platinum
 */

const provider = process.argv[2] ?? 'platinum';
if (provider !== 'platinum' && provider !== 'daytona') {
  throw new Error('usage: secrets-injection-smoke.ts <platinum|daytona>');
}

const apiBase = process.env.E2E_API_URL ?? 'http://localhost:21908/v1';
const supabaseBase = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secretName = `KE2E_SECRET_SENTINEL_${Date.now()}`;
const secretValue = `sentinel-${crypto.randomUUID()}`;

if (!serviceRoleKey || !anonKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (ms: number) => Date.now() + ms;
let token = '';
let userId = '';
let projectId = '';
let sessionId = '';
let externalId = '';

function log(message: string, details?: unknown): void {
  console.log(`[secrets-injection:${provider}] ${message}`, details ?? '');
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return jsonRequest(`${apiBase}${path}`, { ...init, headers });
}

function requireStatus(
  response: { status: number; text: string },
  expected: number,
  action: string,
): void {
  if (response.status !== expected) {
    throw new Error(`${action} failed: expected ${expected}, received ${response.status} ${response.text}`);
  }
}

async function waitForSandbox(): Promise<void> {
  const end = deadline(12 * 60_000);
  let last = '';
  while (Date.now() < end) {
    const response = await api(`/projects/${projectId}/sessions/${sessionId}/start?wait_ms=25000`, {
      method: 'POST',
      body: '{}',
    });
    const stage = response.body?.stage ?? `http-${response.status}`;
    externalId = response.body?.sandbox?.external_id ?? '';
    last = `${stage} ${externalId}`;
    log('session start poll', last);
    if (stage === 'ready' && externalId) return;
    if (stage === 'failed' || response.body?.retriable === false) {
      throw new Error(`session start failed: ${response.text}`);
    }
    await sleep(1_000);
  }
  throw new Error(`session did not become ready: ${last}`);
}

async function waitForRuntime(): Promise<void> {
  const end = deadline(3 * 60_000);
  let last = '';
  while (Date.now() < end) {
    const response = await api(`/p/${externalId}/8000/kortix/health`);
    last = `${response.status} ${response.text.slice(0, 160)}`;
    if (response.status === 200) return;
    await sleep(3_000);
  }
  throw new Error(`runtime did not become reachable: ${last}`);
}

async function shellSeesSecret(expected: 'PRESENT' | 'ABSENT', phase: string): Promise<void> {
  const created = await api(`/p/${externalId}/8000/kortix/pty`, {
    method: 'POST',
    body: JSON.stringify({ env: { TERM: 'xterm-256color' } }),
  });
  requireStatus(created, 200, `create PTY for ${phase}`);
  const ptyId = created.body?.id as string | undefined;
  if (!ptyId) throw new Error(`create PTY for ${phase} returned no id: ${created.text}`);

  const marker = `SECRET_${expected}_${crypto.randomUUID()}`;
  const command = expected === 'PRESENT'
    ? `if [ "\${${secretName}-}" = '${secretValue}' ]; then printf '${marker}\\n'; else printf 'SECRET_WRONG\\n'; fi\n`
    : `if [ -z "\${${secretName}-}" ]; then printf '${marker}\\n'; else printf 'SECRET_STILL_SET\\n'; fi\n`;
  const wsBase = apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const wsUrl = `${wsBase}/p/${externalId}/8000/kortix/pty/${encodeURIComponent(ptyId)}/connect?token=${encodeURIComponent(token)}`;

  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      let settled = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`${phase} timed out; output=${JSON.stringify(output.slice(-300))}`));
      }, 20_000);

      ws.addEventListener('open', () => ws.send(command));
      ws.addEventListener('message', (event) => {
        output += typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString();
        if (output.includes(marker) && !settled) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        if ((output.includes('SECRET_WRONG') || output.includes('SECRET_STILL_SET')) && !settled) {
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(new Error(`${phase} failed: ${expected} assertion did not hold`));
        }
      });
      ws.addEventListener('close', (event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${phase} websocket closed before proof: ${event.code} ${event.reason}`));
      });
    });
    log(`${phase}: ${expected}`);
  } finally {
    await api(`/p/${externalId}/8000/kortix/pty/${encodeURIComponent(ptyId)}`, {
      method: 'DELETE',
    }).catch(() => null);
  }
}

type SyncTarget = {
  session_id: string;
  status: 'synced' | 'failed';
  scope: 'inherit' | 'restricted' | 'none' | null;
  revision: string | null;
  exported: number;
  managed: number | null;
  withheld: number | null;
  agent_env_written: boolean;
  reason?: string;
};

async function syncAndAssert(
  scope: SyncTarget['scope'],
  exported: number,
  phase: string,
): Promise<SyncTarget> {
  const response = await api(`/projects/${projectId}/secrets/sync`, {
    method: 'POST',
    body: '{}',
  });
  requireStatus(response, 200, phase);
  if (response.body?.ok !== true || response.body?.failed !== 0) {
    throw new Error(`${phase} delivery failed: ${response.text}`);
  }
  const target = (response.body?.results as SyncTarget[] | undefined)?.find(
    (candidate) => candidate.session_id === sessionId,
  );
  if (!target) throw new Error(`${phase} returned no result for ${sessionId}: ${response.text}`);
  if (
    target.status !== 'synced' ||
    target.scope !== scope ||
    target.exported !== exported ||
    target.agent_env_written !== true ||
    !target.revision
  ) {
    throw new Error(`${phase} returned invalid delivery proof: ${JSON.stringify(target)}`);
  }
  log(`${phase}: verified`, {
    scope: target.scope,
    revision: target.revision,
    exported: target.exported,
    managed: target.managed,
    withheld: target.withheld,
    agent_env_written: target.agent_env_written,
  });
  return target;
}

async function main(): Promise<void> {
  const email = `secrets-injection-${provider}-${Date.now()}@example.test`;
  const password = 'SecretsInjection123!';
  const createdUser = await jsonRequest(`${supabaseBase}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  requireStatus(createdUser, 200, 'create test user');
  userId = createdUser.body?.id ?? '';

  const grant = await jsonRequest(`${supabaseBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  token = grant.body?.access_token ?? '';
  if (!token) throw new Error(`password grant failed: ${grant.status} ${grant.text}`);

  const accounts = await api('/accounts');
  const account = Array.isArray(accounts.body)
    ? accounts.body.find((candidate: any) => candidate.personal_account) ?? accounts.body[0]
    : null;
  if (!account?.account_id) throw new Error(`personal account missing: ${accounts.text}`);

  const project = await api('/projects/provision', {
    method: 'POST',
    body: JSON.stringify({
      account_id: account.account_id,
      name: `secrets injection ${provider} ${Date.now()}`,
      seed_starter: true,
    }),
  });
  projectId = project.body?.project_id ?? project.body?.id ?? '';
  if (!projectId) throw new Error(`project provision failed: ${project.status} ${project.text}`);
  log('project created', projectId);

  const setSecret = await api(`/projects/${projectId}/secrets`, {
    method: 'POST',
    body: JSON.stringify({ identifier: secretName, name: secretName, value: secretValue }),
  });
  requireStatus(setSecret, 200, 'set sentinel secret');

  const session = await api(`/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ name: `secrets ${provider} ${Date.now()}`, provider }),
  });
  sessionId = session.body?.session_id ?? session.body?.id ?? '';
  if (!sessionId) throw new Error(`session create failed: ${session.status} ${session.text}`);
  if (session.body?.secrets_allowlist !== null) {
    throw new Error(`omitted secrets scope did not persist as null: ${session.text}`);
  }
  log('session created with inherited scope', sessionId);

  await waitForSandbox();
  await waitForRuntime();

  await shellSeesSecret('PRESENT', 'boot injection');
  const initial = await syncAndAssert('inherit', 1, 'identical-revision sync replay');
  await shellSeesSecret('PRESENT', 'post-sync injection');

  const deny = await api(`/projects/${projectId}/sessions/${sessionId}/scope`, {
    method: 'PUT',
    body: JSON.stringify({ secrets: [] }),
  });
  requireStatus(deny, 200, 'set deny-all scope');
  await syncAndAssert('none', 0, 'deny-all sync');
  await shellSeesSecret('ABSENT', 'deny-all revocation');

  const restore = await api(`/projects/${projectId}/sessions/${sessionId}/scope`, {
    method: 'PUT',
    body: JSON.stringify({ secrets: null }),
  });
  requireStatus(restore, 200, 'restore inherited scope');
  const restored = await syncAndAssert('inherit', 1, 'restored-scope sync');
  if (restored.revision !== initial.revision) {
    throw new Error(`restored value revision changed unexpectedly: ${initial.revision} -> ${restored.revision}`);
  }
  await shellSeesSecret('PRESENT', 'restored injection');

  const removed = await api(`/projects/${projectId}/secrets/${encodeURIComponent(secretName)}`, {
    method: 'DELETE',
  });
  requireStatus(removed, 200, 'delete sentinel secret');
  const revoked = await syncAndAssert('inherit', 0, 'deleted-secret sync');
  if ((revoked.withheld ?? 0) < 1) {
    throw new Error(`deleted-secret sync did not retain revocation proof: ${JSON.stringify(revoked)}`);
  }
  await shellSeesSecret('ABSENT', 'deleted-secret revocation');

  log('PASS', { projectId, sessionId, externalId });
}

async function cleanup(): Promise<void> {
  if (sessionId && projectId) {
    await api(`/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => null);
  }
  if (projectId) {
    await api(`/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
  if (userId) {
    await jsonRequest(`${supabaseBase}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }).catch(() => null);
  }
}

try {
  await main();
} finally {
  await cleanup();
}
