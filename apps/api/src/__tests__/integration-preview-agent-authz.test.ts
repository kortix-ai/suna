/**
 * Integration test (real local DB, REAL IAM engine): the prompt path's per-agent
 * gate against actual `iam_resource_grants` rows.
 *
 * The sibling unit test (sandbox-proxy/routes/preview-agent-authz.test.ts) pins
 * the gate's shape and its ordering ahead of the re-mint with a stubbed
 * `authorize`. This one proves the shape is the one the engine actually consumes
 * — a member scoped OUT of an agent is refused, a member scoped IN is not, and an
 * account owner keeps the implicit-Manager bypass — with nothing about the
 * authorization decision mocked.
 *
 * Only the sandbox/transport collaborators are stubbed: there is no box here.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { accountMembers, accounts, projectMembers, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import * as realRequestContext from '../lib/request-context';
import * as realConnectorPreflight from '../projects/lib/prompt-connector-preflight';
import * as realEnvSync from '../projects/lib/sandbox-env-sync';
import * as realGrant from '../projects/lib/session-token-grant';
import * as realSnapshot from '../projects/opencode-session-snapshot';
import * as realShared from '../projects/routes/shared';
// Spread the real modules and override only what this test must control: these
// modules have OTHER exports the surrounding graph imports, and a bare stub
// makes bun fail the whole file on a missing export.
import * as realBackend from '../sandbox-proxy/backend';
import * as realOwnership from '../shared/preview-ownership';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION_AGENT = 'pipeline-hygiene';
const SCOPED_AGENT = 'nda-turnaround';

let remintCalls: string[] = [];
let envSyncCalls = 0;
let upstreamCalls = 0;

mock.module('../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../projects/lib/prompt-connector-preflight', () => ({
  ...realConnectorPreflight,
  missingPromptConnectorConnections: async () => ({ ok: true }),
}));
mock.module('../shared/preview-ownership', () => ({
  ...realOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../projects/lib/sandbox-env-sync', () => ({
  ...realEnvSync,
  syncSandboxEnvForPrompt: async () => {
    envSyncCalls += 1;
  },
}));
mock.module('../projects/lib/session-token-grant', () => ({
  ...realGrant,
  remintGrantForAgentSwitch: async (input: { requestedAgent: string | null }) => {
    remintCalls.push(input.requestedAgent ?? '(none)');
    return { action: 'skip' };
  },
}));
mock.module('../projects/opencode-session-snapshot', () => ({
  ...realSnapshot,
  scheduleOpencodeSnapshotSync: () => {},
}));
mock.module('../projects/routes/shared', () => ({
  ...realShared,
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../sandbox-proxy/backend', () => ({
  ...realBackend,
  loadSandbox: async () => ({
    status: 'active',
    serviceKey: 'svc-key',
    sessionId: 'sess-1',
    projectId: PROJECT,
    accountId: ACCOUNT,
    externalId: 'ext-1',
    sandboxId: 'sbx-1',
    agentName: SESSION_AGENT,
    provider: 'daytona',
  }),
  routeSandboxIngress: () => ({ effectivePort: 8000 }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { db } = await import('../shared/db');
const { upsertResourceGrant } = await import('../iam');
const { forwardToSandbox } = await import('../sandbox-proxy/routes/preview');
const { __resetPromptDedupe } = await import('../sandbox-proxy/prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async () => {
  upstreamCalls += 1;
  return Response.json({ ok: true });
};

let promptSeq = 0;

function promptAs(userId: string, agent: string): Promise<Response> {
  promptSeq += 1;
  const payload = JSON.stringify({ agent, parts: [{ type: 'text', text: `p${promptSeq}` }] });
  return forwardToSandbox(
    'sbx-1',
    8000,
    { kind: 'principal', userId, callerSessionId: null, sandboxAuthored: false },
    'POST',
    '/session/ses_1/prompt_async',
    '',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(payload).buffer as ArrayBuffer,
    'http://localhost:3000',
  );
}

async function seedMember(
  accountRole: 'owner' | 'member',
  projectRole?: 'editor',
): Promise<string> {
  const userId = crypto.randomUUID();
  await db.insert(accountMembers).values({ userId, accountId: ACCOUNT, accountRole });
  if (projectRole) {
    await db
      .insert(projectMembers)
      .values({ accountId: ACCOUNT, projectId: PROJECT, userId, projectRole });
  }
  return userId;
}

let scopedIn = '';
let scopedOut = '';
let owner = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'preview-agent-authz-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'p',
    repoUrl: 'https://example.com/p.git',
  });
  scopedIn = await seedMember('member', 'editor');
  scopedOut = await seedMember('member', 'editor');
  owner = await seedMember('owner');
  // Scope the agent to ONE member. An unscoped agent stays project-wide, so this
  // grant row is what makes `scopedOut` a non-principal for it.
  await upsertResourceGrant({
    accountId: ACCOUNT,
    projectId: PROJECT,
    resourceType: 'agent',
    resourceId: SCOPED_AGENT,
    principalType: 'member',
    principalId: scopedIn,
    grantedBy: owner,
  });
});

afterAll(async () => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  mock.restore();
});

beforeEach(() => {
  remintCalls = [];
  envSyncCalls = 0;
  upstreamCalls = 0;
  __resetPromptDedupe();
});

test('a member scoped OUT of the agent cannot prompt as it, and never reaches the re-mint', async () => {
  const response = await promptAs(scopedOut, SCOPED_AGENT);

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  expect(remintCalls).toEqual([]);
  expect(envSyncCalls).toBe(0);
  expect(upstreamCalls).toBe(0);
});

test('the member the agent IS scoped to prompts as it normally', async () => {
  const response = await promptAs(scopedIn, SCOPED_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([SCOPED_AGENT]);
  expect(upstreamCalls).toBe(1);
});

test('an account owner keeps the implicit-Manager bypass over resource scoping', async () => {
  const response = await promptAs(owner, SCOPED_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([SCOPED_AGENT]);
});

test('the scoped-out member can still run the session own agent', async () => {
  const response = await promptAs(scopedOut, SESSION_AGENT);

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
});
