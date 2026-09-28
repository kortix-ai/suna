#!/usr/bin/env bun
/**
 * Live, black-box CLI matrix using a real project+session-scoped agent PAT.
 *
 * The runner creates a confirmed Supabase user and a managed project, inserts a
 * real session row, then mints the token through the production
 * createAccountToken() path with session_id + agent_grant. Every CLI assertion
 * launches a child process. The token is never printed.
 *
 * Required:
 *   E2E_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 *   E2E_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   DATABASE_URL
 *   API_KEY_SECRET (normally loaded with dotenvx from apps/api/.env)
 *
 * Example for an isolated worktree:
 *   eval "$(supabase --workdir ~/.kortix/worktrees/<name>/sb status -o env)"
 *   E2E_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" E2E_ANON_KEY="$ANON_KEY" \
 *   DATABASE_URL="$DB_URL" E2E_API_URL=http://127.0.0.1:18908/v1 \
 *   E2E_SUPABASE_URL="$API_URL" \
 *   dotenvx run -f apps/api/.env -- bun apps/api/scripts/e2e-cli-agent-token.ts
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  accountTokens,
  connectionCredentials,
  connectorActions,
  connectorCalls,
  connectorConnections,
  connectors,
  creditAccounts,
  projectSessions,
  readStoredAgentGrant,
} from '@kortix/db';
import { db } from '../src/shared/db';
import { createAccountToken } from '../src/repositories/account-tokens';
import { ApiError, createKortix } from '@kortix/sdk';

const ROOT = resolve(import.meta.dir, '../../..');
const CLI_ENTRY = resolve(ROOT, 'apps/cli/src/index.ts');
const API = (process.env.E2E_API_URL ?? 'http://127.0.0.1:8008/v1').replace(/\/$/, '');
const SUPABASE = (process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');
const SERVICE_KEY = process.env.E2E_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.E2E_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const FIXTURE_SLUG = `agent-http-${Date.now().toString(36)}`;
export const PIPEDREAM_SLUG = `agent-github-${Date.now().toString(36)}`;

if (!SERVICE_KEY || !ANON_KEY || !process.env.DATABASE_URL || !process.env.API_KEY_SECRET) {
  throw new Error(
    'E2E_SERVICE_ROLE_KEY, E2E_ANON_KEY, DATABASE_URL, and API_KEY_SECRET are required',
  );
}

let passed = 0;
let failed = 0;
let jwt = '';
export let userId = '';
export let accountId = '';
export let projectId = '';
export let sessionId = '';
let agentToken = '';
export function getAgentToken(): string { return agentToken; }

function log(message: string): void {
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

interface CliResult {
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
  if (input !== undefined) {
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

async function setup(): Promise<void> {
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

  await fundAccount();
  await provisionSession();
}

async function fundAccount(): Promise<void> {
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

async function provisionSession(): Promise<void> {
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

async function deniedGrantBoundary(): Promise<void> {
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

async function cleanup(): Promise<void> {
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

try {
  await setup();
  const { commandMatrix } = await import('./e2e-cli/command-matrix');
  await commandMatrix();
  await deniedGrantBoundary();
} catch (error) {
  failed += 1;
  log(`FATAL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
}

log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
