#!/usr/bin/env -S node --experimental-strip-types

/**
 * Real provider PTY smoke:
 * auth -> project -> provider-pinned session -> sandbox -> stop -> resume the
 * same sandbox -> create PTY -> WebSocket attach -> command I/O -> reconnect
 * replay -> cleanup.
 *
 * Run with the isolated stack up:
 *   dotenvx run -f apps/api/.env -f apps/web/.env -- \
 *     node --experimental-strip-types tests/e2e/scripts/terminal-pty-smoke.ts platinum
 *
 * Set E2E_ASSERT_COMPUTE_BILLING=1 and DATABASE_URL to convert the disposable
 * account to the `credit` billing model and assert the persisted compute meter
 * plus matching ledger debits. This mode is intended for local/dev only.
 */

import { Client } from 'pg';
import { getProviderComputeRateCard } from '../../../apps/api/src/platform/providers/compute-rates.ts';

const provider = process.argv[2];
if (provider !== 'platinum' && provider !== 'daytona') {
  throw new Error('usage: terminal-pty-smoke.ts <platinum|daytona>');
}

const apiBase = process.env.E2E_API_URL ?? 'http://localhost:23308/v1';
const supabaseBase = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const assertComputeBilling = process.env.E2E_ASSERT_COMPUTE_BILLING === '1';
const databaseUrl = process.env.DATABASE_URL;

if (!serviceRoleKey || !anonKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY are required');
}
if (assertComputeBilling && !databaseUrl) {
  throw new Error('DATABASE_URL is required when E2E_ASSERT_COMPUTE_BILLING=1');
}

const authServiceRoleKey = serviceRoleKey;
const authAnonKey = anonKey;
const dbClient =
  assertComputeBilling && databaseUrl ? new Client({ connectionString: databaseUrl }) : null;
if (dbClient) await dbClient.connect();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (ms: number) => Date.now() + ms;
const marker = `KORTIX_PTY_${provider.toUpperCase()}_${Date.now()}`;
let token = '';
let workspaceId = '';
let sessionId = '';
let accountId = '';

interface ComputeRow {
  id: string;
  provider: string;
  state: string;
  started_at: Date;
  ended_at: Date | null;
  last_billed_at: Date;
  cost_usd: string;
  cpu_cores: number;
  memory_gb: number;
  disk_gb: number;
}

async function dbQuery<T extends Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  if (!dbClient) return [];
  let text = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1] ?? ''}`;
  }
  const result = await dbClient.query<T>(text, values);
  return result.rows;
}

function log(message: string, details?: unknown): void {
  console.log(`[terminal-pty:${provider}] ${message}`, details ?? '');
}

async function jsonRequest(
  url: string,
  init: RequestInit = {},
  // biome-ignore lint/suspicious/noExplicitAny: black-box API payload
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  // biome-ignore lint/suspicious/noExplicitAny: black-box API payload
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
    const response = await api(`/projects/${workspaceId}/sessions/${sessionId}/start?wait_ms=25000`, {
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

async function waitForStoredSessionStatus(expected: string): Promise<void> {
  const end = deadline(60_000);
  let last = '';
  while (Date.now() < end) {
    const response = await api(`/projects/${workspaceId}/sessions/${sessionId}`);
    const status = response.body?.status ?? '';
    last = `${response.status} ${status}`;
    if (response.status === 200 && status === expected) return;
    await sleep(500);
  }
  throw new Error(`stored session status did not become ${expected}: ${last}`);
}

async function computeRows(): Promise<ComputeRow[]> {
  if (!dbClient) return [];
  return dbQuery<ComputeRow>`
    SELECT id, provider, state, started_at, ended_at, last_billed_at,
           cost_usd, cpu_cores, memory_gb, disk_gb
    FROM kortix.sandbox_compute_sessions
    WHERE session_id = ${sessionId}
    ORDER BY started_at
  `;
}

async function waitForComputeRows(opts: {
  total: number;
  open: number;
  finalState?: string;
}): Promise<ComputeRow[]> {
  const end = deadline(30_000);
  let rows: ComputeRow[] = [];
  while (Date.now() < end) {
    rows = await computeRows();
    const open = rows.filter((row) => row.ended_at === null).length;
    if (
      rows.length === opts.total &&
      open === opts.open &&
      (!opts.finalState || rows.at(-1)?.state === opts.finalState)
    ) {
      return rows;
    }
    await sleep(250);
  }
  throw new Error(
    `compute rows did not converge: expected=${JSON.stringify(opts)} actual=${JSON.stringify(rows)}`,
  );
}

function expectedComputeCost(row: ComputeRow): number {
  const durationSeconds =
    (new Date(row.last_billed_at).getTime() - new Date(row.started_at).getTime()) / 1000;
  const rate = getProviderComputeRateCard(provider);
  return (
    row.cpu_cores * rate.cpuPerCoreSecond * durationSeconds +
    row.memory_gb * rate.memoryPerGbSecond * durationSeconds +
    row.disk_gb * rate.diskPerGbSecond * durationSeconds
  );
}

async function assertSettledWindow(row: ComputeRow): Promise<void> {
  if (!dbClient) return;
  const actualCost = Number(row.cost_usd);
  const expectedCost = expectedComputeCost(row);
  if (actualCost <= 0 || Math.abs(actualCost - expectedCost) > 0.000001) {
    throw new Error(
      `compute cost mismatch: meter=${row.id} actual=${actualCost} expected=${expectedCost}`,
    );
  }
  const ledger = await dbQuery<{
    count: number;
    debit: string;
    idempotency_key: string | null;
  }>`
    SELECT count(*)::int AS count,
           coalesce(sum(abs(amount_precise)), 0)::text AS debit,
           min(idempotency_key) AS idempotency_key
    FROM kortix.credit_ledger
    WHERE account_id = ${accountId}
      AND metadata->>'ledger_type' = 'compute_debit'
      AND idempotency_key LIKE ${`compute:${row.id}:%`}
  `;
  const debit = Number(ledger[0]?.debit ?? 0);
  if (ledger[0]?.count !== 1 || Math.abs(debit - expectedCost) > 0.0000001) {
    throw new Error(
      `compute ledger mismatch: meter=${row.id} rows=${ledger[0]?.count} debit=${debit} expected=${expectedCost}`,
    );
  }
}

async function attachAndCollect(
  wsUrl: string,
  input?: string,
): Promise<{ output: string; close?: { code: number; reason: string } }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(
        new Error(
          `timed out waiting for PTY output; received=${JSON.stringify(output.slice(-500))}`,
        ),
      );
    }, 20_000);

    ws.addEventListener('open', () => {
      log('websocket opened');
      if (input) ws.send(input);
    });
    ws.addEventListener('message', (event) => {
      output +=
        typeof event.data === 'string'
          ? event.data
          : Buffer.from(event.data as ArrayBuffer).toString();
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
      apikey: authServiceRoleKey,
      Authorization: `Bearer ${authServiceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (createdUser.status < 200 || createdUser.status >= 300) {
    throw new Error(`create user failed: ${createdUser.status} ${createdUser.text}`);
  }

  const grant = await jsonRequest(`${supabaseBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: authAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  token = grant.body?.access_token ?? '';
  if (!token) throw new Error(`password grant failed: ${grant.status} ${grant.text}`);

  const accounts = await api('/accounts');
  const account = Array.isArray(accounts.body)
    ? // biome-ignore lint/suspicious/noExplicitAny: black-box API payload
      (accounts.body.find((candidate: any) => candidate.personal_account) ?? accounts.body[0])
    : null;
  if (!account?.account_id) throw new Error(`personal account missing: ${accounts.text}`);
  accountId = account.account_id;
  if (dbClient) {
    const updated = await dbQuery<{ balance: string }>`
      UPDATE kortix.credit_accounts
      SET billing_model = 'credit', updated_at = now()
      WHERE account_id = ${accountId}
      RETURNING balance::text
    `;
    if (updated.length !== 1 || Number(updated[0]?.balance) <= 0) {
      throw new Error(`credit billing setup failed for account ${accountId}`);
    }
    log('credit billing enabled', { accountId, balance: Number(updated[0]?.balance) });
  }

  const project = await api('/projects/provision', {
    method: 'POST',
    body: JSON.stringify({
      account_id: account.account_id,
      name: `terminal pty ${provider} ${Date.now()}`,
      seed_starter: true,
    }),
  });
  workspaceId = project.body?.project_id ?? project.body?.id ?? '';
  if (!workspaceId) throw new Error(`project provision failed: ${project.status} ${project.text}`);
  log('project created', workspaceId);

  const sessionName = `terminal ${provider} ${Date.now()}`;
  let session = await api(`/projects/${workspaceId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ name: sessionName, provider }),
  });
  // The API's 25s request deadline can answer 503 while the async create keeps
  // running. Reconcile by unique name before retrying so the smoke never
  // creates a duplicate session after an ambiguous response.
  if (session.status === 503) {
    const reconcileEnd = deadline(45_000);
    while (Date.now() < reconcileEnd) {
      const listed = await api(`/projects/${workspaceId}/sessions`);
      const items = Array.isArray(listed.body) ? listed.body : (listed.body?.sessions ?? []);
      // biome-ignore lint/suspicious/noExplicitAny: black-box API payload
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
  if (dbClient) {
    const runningRows = await waitForComputeRows({ total: 1, open: 1 });
    if (runningRows[0]?.provider !== provider || runningRows[0]?.state !== 'active') {
      throw new Error(`initial compute meter mismatch: ${JSON.stringify(runningRows)}`);
    }
    log('initial compute meter open', { meterId: runningRows[0].id });
    await sleep(5_000);
  }

  const stopped = await api(`/projects/${workspaceId}/sessions/${sessionId}/stop`, {
    method: 'POST',
    body: '{}',
  });
  if (stopped.status !== 200 || stopped.body?.status !== 'stopped') {
    throw new Error(`session stop failed: ${stopped.status} ${stopped.text}`);
  }
  await waitForStoredSessionStatus('stopped');
  log('session stopped', { externalId });
  let stoppedRows: ComputeRow[] = [];
  if (dbClient) {
    stoppedRows = await waitForComputeRows({ total: 1, open: 0, finalState: 'stopped' });
    const stoppedRow = stoppedRows[0];
    if (!stoppedRow) throw new Error('stopped compute meter missing');
    await assertSettledWindow(stoppedRow);
    const stoppedSnapshot = JSON.stringify(stoppedRows);
    await sleep(5_000);
    const afterStoppedWait = await computeRows();
    if (JSON.stringify(afterStoppedWait) !== stoppedSnapshot) {
      throw new Error('compute meter changed while the session was stopped');
    }
    log('stopped compute meter is stable', {
      meterId: stoppedRow.id,
      costUsd: Number(stoppedRow.cost_usd),
    });
  }

  const resumed = await waitForSandbox();
  if (resumed.externalId !== externalId) {
    throw new Error(
      `resume replaced the sandbox identity: before=${externalId} after=${resumed.externalId}`,
    );
  }
  await waitForStoredSessionStatus('running');
  await waitForRuntime(externalId);
  log('session resumed in place', { externalId });
  if (dbClient) {
    const resumedRows = await waitForComputeRows({ total: 2, open: 1 });
    if (resumedRows[0]?.id !== stoppedRows[0]?.id || resumedRows[1]?.provider !== provider) {
      throw new Error(`resumed compute meter mismatch: ${JSON.stringify(resumedRows)}`);
    }
    log('resume opened one compute meter', { meterId: resumedRows[1]?.id });
    await sleep(5_000);
  }

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
    throw new Error(
      `first attach failed: close=${JSON.stringify(first.close)} output=${JSON.stringify(first.output)}`,
    );
  }

  const second = await attachAndCollect(wsUrl);
  if (!second.output.includes(marker)) {
    throw new Error(
      `reconnect replay failed: close=${JSON.stringify(second.close)} output=${JSON.stringify(second.output)}`,
    );
  }

  const listed = await api(`/p/${externalId}/8000/kortix/pty`);
  if (
    !Array.isArray(listed.body) ||
    // biome-ignore lint/suspicious/noExplicitAny: black-box API payload
    !listed.body.some((pty: any) => pty.id === ptyId && pty.status === 'running')
  ) {
    throw new Error(`PTY list lost running terminal: ${listed.status} ${listed.text}`);
  }

  const removed = await api(`/p/${externalId}/8000/kortix/pty/${encodeURIComponent(ptyId)}`, {
    method: 'DELETE',
  });
  if (removed.status !== 200)
    throw new Error(`PTY delete failed: ${removed.status} ${removed.text}`);
  if (dbClient) {
    const deleted = await api(`/projects/${workspaceId}/sessions/${sessionId}`, { method: 'DELETE' });
    if (deleted.status < 200 || deleted.status >= 300) {
      throw new Error(`session delete failed: ${deleted.status} ${deleted.text}`);
    }
    const closedRows = await waitForComputeRows({ total: 2, open: 0 });
    const closedRow = closedRows[1];
    if (!closedRow || !['stopped', 'finalized'].includes(closedRow.state)) {
      throw new Error(`closed compute meter missing: ${JSON.stringify(closedRows)}`);
    }
    await assertSettledWindow(closedRow);
    sessionId = '';
    log('delete closed compute billing', {
      meterId: closedRow.id,
      state: closedRow.state,
      costUsd: Number(closedRow.cost_usd),
    });
  }
  log('PASS', { provider, marker, ptyId });
}

async function cleanup(): Promise<void> {
  if (sessionId && workspaceId) {
    await api(`/projects/${workspaceId}/sessions/${sessionId}`, { method: 'DELETE' }).catch(
      () => null,
    );
  }
  if (workspaceId) {
    await api(`/projects/${workspaceId}`, { method: 'DELETE' }).catch(() => null);
  }
}

try {
  await main();
} finally {
  try {
    await cleanup();
  } finally {
    await dbClient?.end();
  }
}
