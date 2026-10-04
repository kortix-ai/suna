import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  accountTokens,
  connectorActions,
  connectors,
  creditAccounts,
  projectSessions,
  readStoredAgentGrant,
  sessionLifecycleCommands,
  sessionSandboxes,
} from '@kortix/db';
import { ApiError, createKortix } from '@kortix/sdk';
import { and, eq } from 'drizzle-orm';
import { createAccountToken } from '../../src/repositories/account-tokens';
import { db } from '../../src/lib/db';

const ROOT = resolve(import.meta.dir, '../../..');
const CLI_ENTRY = resolve(ROOT, 'apps/cli/src/index.ts');
const API = (process.env.E2E_API_URL ?? 'http://127.0.0.1:8008/v1').replace(/\/$/, '');
const SUPABASE = (process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');
export const SERVICE_KEY = process.env.E2E_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
export const ANON_KEY = process.env.E2E_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const FIXTURE_SLUG = `agent-http-${Date.now().toString(36)}`;
export const PIPEDREAM_SLUG = `agent-github-${Date.now().toString(36)}`;

export let passed = 0;
export let failed = 0;
let jwt = '';
export let userId = '';
let accountId = '';
export let projectId = '';
export let sessionId = '';
export let agentToken = '';

export function log(message: string): void {
  process.stdout.write(`[cli-agent-e2e] ${message}\n`);
}

function safe(value: string): string {
  return value
    .replace(/kortix_pat_[A-Za-z0-9_-]+/g, '<agent-token>')
    .replace(/https?:\/\/\S+/g, '<url>');
}

export function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    log(`PASS ${name}`);
    return;
  }
  failed += 1;
  log(`FAIL ${name}${detail ? `: ${safe(detail).slice(0, 240)}` : ''}`);
}

export function fail(): void {
  failed += 1;
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

export async function api(
  path: string,
  init: RequestInit = {},
  token = jwt,
): Promise<{ status: number; body: any; text: string }> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return jsonRequest(`${API}${path}`, { ...init, headers });
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], input?: string): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: ROOT,
    env: {
      ...process.env,
      KORTIX_API_URL: API,
      KORTIX_TOKEN: agentToken,
      KORTIX_PROJECT_ID: projectId,
      KORTIX_SESSION_ID: sessionId,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export async function expectCli(
  name: string,
  args: string[],
  opts: { code?: number | number[]; stdout?: RegExp; stderr?: RegExp; input?: string } = {},
): Promise<CliResult> {
  const result = await cli(args, opts.input);
  const expected = Array.isArray(opts.code) ? opts.code : [opts.code ?? 0];
  const ok =
    expected.includes(result.code) &&
    (!opts.stdout || opts.stdout.test(result.stdout)) &&
    (!opts.stderr || opts.stderr.test(result.stderr));
  check(
    name,
    ok,
    `exit=${result.code} stdout=${JSON.stringify(result.stdout.slice(0, 120))} stderr=${JSON.stringify(result.stderr.slice(0, 120))}`,
  );
  return result;
}

async function waitForProjectFile(timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    const result = await api(`/projects/${projectId}/files/content?path=kortix.yaml`);
    last = `${result.status} ${result.text.slice(0, 120)}`;
    if (result.status === 200 && typeof result.body?.content === 'string') return;
    await Bun.sleep(2_000);
  }
  throw new Error(`project manifest did not become readable: ${last}`);
}

async function provisionUserAndAccount(): Promise<void> {
  const email = `cli-agent-${Date.now()}@example.test`;
  const password = 'CliAgentE2E123!';
  const user = await jsonRequest(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  userId = user.body?.user?.id ?? user.body?.id ?? '';
  check('confirmed Supabase user created', user.status >= 200 && user.status < 300 && !!userId);

  const grant = await jsonRequest(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  jwt = grant.body?.access_token ?? '';
  check('password grant returned JWT', grant.status === 200 && !!jwt);

  const accounts = await api('/accounts');
  const account = Array.isArray(accounts.body)
    ? accounts.body.find((item: any) => item.personal_account) ?? accounts.body[0]
    : null;
  accountId = account?.account_id ?? '';
  check('personal account resolved', accounts.status === 200 && !!accountId);

  const credit = {
    tier: 'pro',
    billingModel: 'legacy',
    balance: '100',
    legacyBalance: '100',
    nonExpiringCredits: '100',
    legacyNonExpiringCredits: '100',
  } as const;
  const [fundedAccount] = await db
    .insert(creditAccounts)
    .values({ accountId, ...credit })
    .onConflictDoUpdate({
      target: creditAccounts.accountId,
      set: credit,
    })
    .returning({ accountId: creditAccounts.accountId, tier: creditAccounts.tier });
  check(
    'ephemeral account is funded for the real gateway request',
    fundedAccount?.accountId === accountId && fundedAccount.tier === 'pro',
  );
}

export async function setup(): Promise<void> {
  await provisionUserAndAccount();
  const project = await api('/projects/provision', {
    method: 'POST',
    body: JSON.stringify({
      account_id: accountId,
      name: `CLI agent token E2E ${Date.now()}`,
      seed_starter: true,
    }),
  });
  projectId = project.body?.project_id ?? project.body?.id ?? '';
  check('managed project provisioned', project.status >= 200 && project.status < 300 && !!projectId);
  if (!projectId) throw new Error(`project provision failed: ${project.status} ${project.text}`);
  await waitForProjectFile();
  check('kortix.yaml is readable through the live API', true);

  sessionId = randomUUID();
  await db.insert(projectSessions).values({
    sessionId,
    accountId,
    projectId,
    branchName: sessionId,
    createdBy: userId,
    agentName: 'kortix',
    status: 'running',
  });
  // A session credential is valid only while its sandbox lease is
  // provisioning/active (validateAccountToken). No box runs here, so the lease
  // row is seeded; the project DELETE in cleanup() removes it.
  await db.insert(sessionSandboxes).values({
    sandboxId: randomUUID(),
    sessionId,
    accountId,
    projectId,
    externalId: `cli-agent-e2e-${sessionId}`,
    status: 'active',
  });

  const minted = await createAccountToken({
    accountId,
    userId,
    projectId,
    sessionId,
    name: `Connector Session ${sessionId.slice(0, 8)}`,
    agentGrant: {
      agent: 'kortix',
      permissions: 'all',
      connectors: 'all',
      env: 'all',
    },
  });
  agentToken = minted.secretKey;
  const [stored] = await db
    .select({
      projectId: accountTokens.projectId,
      sessionId: accountTokens.sessionId,
      agentGrant: accountTokens.agentGrant,
    })
    .from(accountTokens)
    .where(eq(accountTokens.tokenId, minted.tokenId))
    .limit(1);
  check(
    'production token mint stored project_id + session_id + agent_grant',
    stored?.projectId === projectId &&
      stored?.sessionId === sessionId &&
      stored?.agentGrant?.agent === 'kortix' &&
      readStoredAgentGrant(stored?.agentGrant)?.permissions === 'all' &&
      stored?.agentGrant?.connectors === 'all',
  );
}

export async function seedCallableAction(): Promise<void> {
  const [connector] = await db
    .select({ id: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, FIXTURE_SLUG)))
    .limit(1);
  if (!connector) throw new Error(`connector ${FIXTURE_SLUG} was not materialized`);
  await db.delete(connectorActions).where(eq(connectorActions.connectorId, connector.id));
  await db.insert(connectorActions).values({
    connectorId: connector.id,
    path: 'get',
    name: `${FIXTURE_SLUG}.get`,
    description: 'Call Postman Echo and echo one query value',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', 'x-in': 'query' } },
    },
    risk: 'read',
    binding: { kind: 'http', method: 'GET', path: '/get' },
  });
}

export async function driveConnectorSdk(): Promise<void> {
  const client = createKortix({
    backendUrl: API,
    getToken: async () => agentToken,
  }).project(projectId).connectors;
  const catalog = await client.catalog();
  check(
    'connector SDK live catalog uses the agent token',
    catalog.some((connector) => connector.slug === FIXTURE_SLUG),
  );
  const tools = await client.tools();
  check(
    'connector SDK live tools flatten the fixture action',
    tools.some((tool) => tool.tool === `${FIXTURE_SLUG}.get`),
  );
  const called = await client.call<{ args?: { q?: string } }>(`${FIXTURE_SLUG}.get`, {
    q: 'sdk-agent-token',
  });
  check(
    '@kortix/sdk live call reaches the real upstream',
    called.ok === true && called.data?.args?.q === 'sdk-agent-token',
  );
  let badActionError: unknown;
  try {
    await client.call(`${FIXTURE_SLUG}.definitely_not_a_real_action`);
  } catch (error) {
    badActionError = error;
  }
  check(
    'connector SDK live bad action raises ApiError',
    badActionError instanceof ApiError,
  );
}

export async function driveExistingSessionGrantRefresh(): Promise<void> {
  const stale = await createAccountToken({
    accountId,
    userId,
    projectId,
    sessionId,
    name: `Connector Session stale grant ${sessionId.slice(0, 8)}`,
    agentGrant: {
      agent: 'kortix',
      permissions: 'all',
      connectors: [],
      env: 'all',
    },
  });
  const originalToken = agentToken;
  agentToken = stale.secretKey;
  try {
    await expectCli(
      'existing session catalog reconciles a stale same-agent grant without a new session',
      ['connectors', 'ls', '--session', sessionId],
      { stdout: new RegExp(FIXTURE_SLUG) },
    );
    await expectCli(
      'existing session calls the newly granted connector with the unchanged token',
      ['connectors', 'call', `${FIXTURE_SLUG}.get`, '{"q":"hot-grant-agent-token"}'],
      { stdout: /hot-grant-agent-token/ },
    );
  } finally {
    agentToken = originalToken;
    await db.delete(accountTokens).where(eq(accountTokens.tokenId, stale.tokenId));
  }
}

export async function driveMcp(): Promise<void> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
    cwd: ROOT,
    env: {
      ...process.env,
      KORTIX_API_URL: API,
      KORTIX_TOKEN: agentToken,
      KORTIX_PROJECT_ID: projectId,
      KORTIX_SESSION_ID: sessionId,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function rpc(id: number, method: string, params?: unknown): Promise<any> {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    while (!buffer.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('MCP process closed before a response');
      buffer += decoder.decode(chunk.value);
    }
    const newline = buffer.indexOf('\n');
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const response = JSON.parse(line);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }
  try {
    const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    check('MCP initialize identifies kortix-connectors', initialized?.serverInfo?.name === 'kortix-connectors');
    const listed = await rpc(2, 'tools/list');
    const names = (listed.tools ?? []).map((tool: any) => tool.name);
    check(
      'MCP exposes the complete connector meta-tool surface',
      ['connectors', 'discover', 'describe', 'call', 'connect', 'request_secret', 'add_connector', 'remove_connector']
        .every((name) => names.includes(name)),
    );
    const called = await rpc(3, 'tools/call', {
      name: 'call',
      arguments: { connector: FIXTURE_SLUG, action: 'get', args: { q: 'mcp-agent-token' } },
    });
    const payload = JSON.parse(called.content?.[0]?.text ?? '{}');
    check('MCP connector call uses the agent token', called.isError === false && payload.ok === true);
    const requested = await rpc(4, 'tools/call', {
      name: 'request_secret',
      arguments: { names: ['CLI_AGENT_E2E_REQUESTED'], scope: 'connector' },
    });
    const requestPayload = JSON.parse(requested.content?.[0]?.text ?? '{}');
    check(
      'MCP request_secret mints a connection-scoped setup link',
      requested.isError === false && requestPayload.ok === true && /^https?:\/\//.test(requestPayload.url ?? ''),
    );
  } finally {
    proc.kill();
    await proc.exited;
  }
}

export async function deniedGrantBoundary(): Promise<void> {
  const denied = await createAccountToken({
    accountId,
    userId,
    projectId,
    sessionId,
    name: `Connector Session denied ${sessionId.slice(0, 8)}`,
    agentGrant: { agent: 'locked', permissions: [], connectors: [], env: [] },
  });
  const allowedToken = agentToken;
  agentToken = denied.secretKey;
  try {
    const secretList = await expectCli('denied agent grant filters secret metadata', ['secrets', 'ls']);
    check(
      'denied agent grant hides the configured secret identifier',
      !secretList.stdout.includes('CLI_AGENT_E2E'),
      secretList.stdout,
    );
    await expectCli('denied agent grant hides connector catalog', ['connectors', 'ls', '--session', sessionId], {
      stdout: /"connectors"\s*:\s*\[\s*\]/,
    });
  } finally {
    agentToken = allowedToken;
    await db.delete(accountTokens).where(eq(accountTokens.tokenId, denied.tokenId));
    await expectCli('secrets unset removes the fixture', ['secrets', 'unset', 'CLI_AGENT_E2E']);
  }
}

/**
 * No box runs in this matrix. Anything that tries to wake the session (a
 * `sessions status` probe, an approval callback) finds none at the provider
 * and withdraws the session lease, which is the product working. Restore the
 * seeded lease so the next step still holds a live session credential.
 */
export async function restoreLease(afterCommand?: string): Promise<void> {
  // A decision's resume command drains asynchronously; restoring before it
  // settles loses the race and the lease is withdrawn again.
  for (let i = 0; afterCommand && i < 60; i += 1) {
    const [row] = await db
      .select({ status: sessionLifecycleCommands.status })
      .from(sessionLifecycleCommands)
      .where(eq(sessionLifecycleCommands.idempotencyKey, afterCommand));
    if (row && row.status !== 'running' && row.status !== 'queued') break;
    if (row?.status === 'queued' && i > 10) break;
    await Bun.sleep(500);
  }
  await db
    .update(sessionSandboxes)
    .set({ status: 'active' })
    .where(eq(sessionSandboxes.sessionId, sessionId));
}

export async function cleanup(): Promise<void> {
  if (projectId && jwt) {
    await api(`/projects/${projectId}`, { method: 'DELETE' }, jwt).catch(() => null);
  }
  if (userId) {
    await fetch(`${SUPABASE}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    }).catch(() => null);
  }
  agentToken = '';
  jwt = '';
}
