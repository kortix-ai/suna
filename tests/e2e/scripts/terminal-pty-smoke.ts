#!/usr/bin/env bun

/**
 * Real provider PTY smoke:
 * auth -> project -> provider-pinned session -> sandbox -> create PTY ->
 * WebSocket attach -> command I/O -> reconnect replay -> cleanup.
 *
 * Run with the isolated stack up:
 *   dotenvx run -f apps/api/.env -f apps/web/.env -- \
 *     bun tests/e2e/scripts/terminal-pty-smoke.ts platinum
 */

const provider = process.argv[2];
if (provider !== 'platinum' && provider !== 'daytona') {
  throw new Error('usage: terminal-pty-smoke.ts <platinum|daytona>');
}

const apiBase = process.env.E2E_API_URL ?? 'http://localhost:23308/v1';
const supabaseBase = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!serviceRoleKey || !anonKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (ms: number) => Date.now() + ms;
const marker = `KORTIX_PTY_${provider.toUpperCase()}_${Date.now()}`;
let token = '';
let projectId = '';
let sessionId = '';

function log(message: string, details?: unknown): void {
  console.log(`[terminal-pty:${provider}] ${message}`, details ?? '');
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

async function waitForSandbox(): Promise<{ externalId: string }> {
  const end = deadline(7 * 60_000);
  let last = '';
  while (Date.now() < end) {
    const response = await api(`/projects/${projectId}/sessions/${sessionId}/start?wait_ms=25000`, {
      method: 'POST',
      body: '{}',
    });
    const stage = response.body?.stage ?? `http-${response.status}`;
    const externalId = response.body?.sandbox?.external_id ?? '';
    last = `${stage} ${externalId}`;
    log('session start poll', last);
    if (stage === 'ready' && externalId) return { externalId };
    if (stage === 'failed' || response.body?.retriable === false) {
      throw new Error(`session start failed: ${response.text}`);
    }
    await sleep(1_000);
  }
  throw new Error(`session did not become ready: ${last}`);
}

async function waitForRuntime(externalId: string): Promise<void> {
  const end = deadline(2 * 60_000);
  let last = '';
  while (Date.now() < end) {
    const response = await api(`/p/${externalId}/8000/kortix/health`);
    last = `${response.status} ${response.text.slice(0, 160)}`;
    if (response.status === 200) return;
    await sleep(3_000);
  }
  throw new Error(`runtime did not become reachable: ${last}`);
}

async function attachAndCollect(wsUrl: string, input?: string): Promise<{ output: string; close?: { code: number; reason: string } }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`timed out waiting for PTY output; received=${JSON.stringify(output.slice(-500))}`));
    }, 20_000);

    ws.addEventListener('open', () => {
      log('websocket opened');
      if (input) ws.send(input);
    });
    ws.addEventListener('message', (event) => {
      output += typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString();
      if (output.includes(marker) && !settled) {
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve({ output });
      }
    });
    ws.addEventListener('close', (event) => {
      log('websocket closed', { code: event.code, reason: event.reason });
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, close: { code: event.code, reason: event.reason } });
    });
    ws.addEventListener('error', () => {
      log('websocket error');
    });
  });
}

async function main(): Promise<void> {
  const email = `terminal-pty-${provider}-${Date.now()}@example.test`;
  const password = 'TerminalPty123!';
  const createdUser = await jsonRequest(`${supabaseBase}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (createdUser.status < 200 || createdUser.status >= 300) {
    throw new Error(`create user failed: ${createdUser.status} ${createdUser.text}`);
  }

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
      name: `terminal pty ${provider} ${Date.now()}`,
      seed_starter: true,
    }),
  });
  projectId = project.body?.project_id ?? project.body?.id ?? '';
  if (!projectId) throw new Error(`project provision failed: ${project.status} ${project.text}`);
  log('project created', projectId);

  const sessionName = `terminal ${provider} ${Date.now()}`;
  let session = await api(`/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ name: sessionName, provider }),
  });
  // The API's 25s request deadline can answer 503 while the async create keeps
  // running. Reconcile by unique name before retrying so the smoke never
  // creates a duplicate session after an ambiguous response.
  if (session.status === 503) {
    const reconcileEnd = deadline(45_000);
    while (Date.now() < reconcileEnd) {
      const listed = await api(`/projects/${projectId}/sessions`);
      const items = Array.isArray(listed.body) ? listed.body : (listed.body?.sessions ?? []);
      const created = items.find((item: any) => item.name === sessionName);
      if (created) {
        session = { status: 201, body: created, text: JSON.stringify(created) };
        break;
      }
      await sleep(2_000);
    }
  }
  sessionId = session.body?.session_id ?? session.body?.id ?? '';
  if (!sessionId) throw new Error(`session create failed: ${session.status} ${session.text}`);
  if (session.body?.sandbox_provider !== provider) {
    throw new Error(`provider mismatch: expected=${provider} body=${session.text}`);
  }
  log('session created', sessionId);

  const { externalId } = await waitForSandbox();
  await waitForRuntime(externalId);

  const createdPty = await api(`/p/${externalId}/8000/kortix/pty`, {
    method: 'POST',
    body: JSON.stringify({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } }),
  });
  if (createdPty.status !== 200 || !createdPty.body?.id) {
    throw new Error(`PTY create failed: ${createdPty.status} ${createdPty.text}`);
  }
  const ptyId = createdPty.body.id as string;
  log('PTY created', { ptyId, pid: createdPty.body.pid });

  const wsBase = apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const wsUrl = `${wsBase}/p/${externalId}/8000/kortix/pty/${encodeURIComponent(ptyId)}/connect?token=${encodeURIComponent(token)}`;
  const first = await attachAndCollect(wsUrl, `printf '${marker}\\n'\n`);
  if (!first.output.includes(marker)) {
    throw new Error(`first attach failed: close=${JSON.stringify(first.close)} output=${JSON.stringify(first.output)}`);
  }

  const second = await attachAndCollect(wsUrl);
  if (!second.output.includes(marker)) {
    throw new Error(`reconnect replay failed: close=${JSON.stringify(second.close)} output=${JSON.stringify(second.output)}`);
  }

  const listed = await api(`/p/${externalId}/8000/kortix/pty`);
  if (!Array.isArray(listed.body) || !listed.body.some((pty: any) => pty.id === ptyId && pty.status === 'running')) {
    throw new Error(`PTY list lost running terminal: ${listed.status} ${listed.text}`);
  }

  const removed = await api(`/p/${externalId}/8000/kortix/pty/${encodeURIComponent(ptyId)}`, { method: 'DELETE' });
  if (removed.status !== 200) throw new Error(`PTY delete failed: ${removed.status} ${removed.text}`);
  log('PASS', { provider, marker, ptyId });
}

async function cleanup(): Promise<void> {
  if (sessionId && projectId) {
    await api(`/projects/${projectId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => null);
  }
  if (projectId) {
    await api(`/projects/${projectId}`, { method: 'DELETE' }).catch(() => null);
  }
}

try {
  await main();
} finally {
  await cleanup();
}
