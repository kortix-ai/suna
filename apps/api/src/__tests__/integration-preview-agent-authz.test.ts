/**
 * Integration test (real local DB, REAL IAM engine): the prompt path's per-agent
 * gate against actual `iam_resource_grants` rows.
 *
 * This suite owns the authorization decision, with nothing about it mocked: a
 * member scoped OUT of an agent is refused before the re-mint, an authorized
 * switch re-mints, and an account owner keeps the implicit-Manager bypass.
 * The sibling unit test
 * (http/sandbox-proxy/preview-agent-authz.test.ts) keeps only the no-gate paths
 * and the undeclared-agent drop, with a stubbed `authorize`.
 *
 * Only the sandbox/transport collaborators are stubbed: there is no box here.
 * The session and its `session_sandboxes` row ARE real: since 344717c09f the
 * prompt path writes the durable turn-lifecycle record to that row before the
 * first byte reaches OpenCode, and refuses the prompt (503
 * `sandbox_lifecycle_unavailable`) when no live row exists.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  projectMembers,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as realRequestContext from '../lib/request-context';
import * as realEnvSync from '../services/sandboxes/sandbox-env-sync';
import * as realGrant from '../services/sessions/session-token-grant';
import * as realSnapshot from '../services/sessions/opencode-session-snapshot';
// Spread the real modules and override only what this test must control: these
// modules have OTHER exports the surrounding graph imports, and a bare stub
// makes bun fail the whole file on a missing export.
import * as realBackend from '../services/sandbox-proxy/backend';
import * as realOwnership from '../services/sessions/preview-ownership';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION_AGENT = 'pipeline-hygiene';
const SCOPED_AGENT = 'nda-turnaround';
/** Scoped to `scopedOut` only: the member the other two agents ARE granted to. */
const OTHER_SCOPED_AGENT = 'release-notes';
const SESSION = crypto.randomUUID();
const SANDBOX = crypto.randomUUID();
/** The provider external id the proxy addresses the box by. */
const EXTERNAL_ID = `ext-${SANDBOX}`;

/** The agent the proxy sees the session bound to. `default` is the legacy non-binding sentinel. */
let boundAgent = SESSION_AGENT;
let remintCalls: string[] = [];
let envSyncCalls = 0;
let upstreamCalls = 0;

mock.module('../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../services/sessions/preview-ownership', () => ({
  ...realOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../services/sandboxes/sandbox-env-sync', () => ({
  ...realEnvSync,
  syncSandboxEnvForPrompt: async () => {
    envSyncCalls += 1;
  },
}));
mock.module('../services/sessions/session-token-grant', () => ({
  ...realGrant,
  // The project declares both agents. Since 86065cd21f (INC-2026-09-15) the
  // proxy drops a turn-start agent the project's manifest does not declare
  // BEFORE the authorization gate runs, and there is no manifest here: without
  // this, every prompt ran as SESSION_AGENT and the gate under test never saw
  // SCOPED_AGENT.
  agentLaunchableInProject: async (_projectId: string, agentName: string) =>
    agentName === SESSION_AGENT || agentName === SCOPED_AGENT || agentName === OTHER_SCOPED_AGENT,
  remintGrantForAgentSwitch: async (input: { requestedAgent: string | null }) => {
    remintCalls.push(input.requestedAgent ?? '(none)');
    return { action: 'skip' };
  },
}));
mock.module('../services/sessions/opencode-session-snapshot', () => ({
  ...realSnapshot,
  scheduleOpencodeSnapshotSync: () => {},
}));
mock.module('../services/sandbox-proxy/backend', () => ({
  ...realBackend,
  loadSandbox: async () => ({
    status: 'active',
    serviceKey: 'svc-key',
    sessionId: SESSION,
    projectId: PROJECT,
    accountId: ACCOUNT,
    externalId: EXTERNAL_ID,
    sandboxId: SANDBOX,
    agentName: boundAgent,
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

// `services/sessions/open/shared` is imported LAST, after every other stub is in
// place. Its graph evaluates `services/sandbox-proxy/forward/turn-start.ts`, which binds
// `REAL_PRE_PROMPT_DEPS` (the env sync and token re-mint) by VALUE at module
// evaluation. A static import here would evaluate it before `mock.module` ran,
// and every prompt would hit the real re-mint (a git read of a repo that does
// not exist → 503) instead of the stub.
const realShared = await import('../services/sessions/open/shared');
mock.module('../services/sessions/open/shared', () => ({
  ...realShared,
  resumeStoppedSandboxByExternalId: async () => true,
}));

const { db } = await import('../lib/db');
const { upsertResourceGrant } = await import('../services/iam');
const { forwardToSandbox } = await import('../http/sandbox-proxy/preview');
const { __resetPromptDedupe } = await import('../services/sandbox-proxy/prompt-dedupe');

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
    EXTERNAL_ID,
    8000,
    {
      kind: 'principal',
      userId,
      callerSessionId: null,
      boundCredentialSessionId: null,
      sandboxAuthored: false,
    },
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
  projectRole?: 'manager',
): Promise<string> {
  const userId = crypto.randomUUID();
  await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole });
  if (projectRole) {
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId, projectRole });
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
  // The live session + box the turn-lifecycle write claims (see header).
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: SESSION,
    agentName: SESSION_AGENT,
    status: 'running',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: SANDBOX,
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    externalId: EXTERNAL_ID,
    status: 'active',
  });
  scopedIn = await seedMember('member', 'manager');
  scopedOut = await seedMember('member', 'manager');
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
  // The session's own agent is scoped away from `scopedOut` too, so the
  // own-agent exemption is the only reason that member may still run it.
  await upsertResourceGrant({
    accountId: ACCOUNT,
    projectId: PROJECT,
    resourceType: 'agent',
    resourceId: SESSION_AGENT,
    principalType: 'member',
    principalId: scopedIn,
    grantedBy: owner,
  });
  // A third agent, scoped to `scopedOut` ONLY. `scopedIn` holds grants on both
  // other agents. The running-session switch guard rejects this request.
  await upsertResourceGrant({
    accountId: ACCOUNT,
    projectId: PROJECT,
    resourceType: 'agent',
    resourceId: OTHER_SCOPED_AGENT,
    principalType: 'member',
    principalId: scopedOut,
    grantedBy: owner,
  });
});

afterAll(async () => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  await db.execute(sql`delete from kortix.session_turns where session_id = ${SESSION}`);
  // The identity-immutability trigger refuses to delete an established box
  // unless its session is marked deleted first.
  await db.execute(sql`
    update kortix.project_sessions
       set metadata = coalesce(metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
     where session_id = ${SESSION}`);
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, SANDBOX));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, SESSION));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  mock.restore();
});

beforeEach(() => {
  boundAgent = SESSION_AGENT;
  remintCalls = [];
  envSyncCalls = 0;
  upstreamCalls = 0;
  __resetPromptDedupe();
});

// KRTX-1290: a concrete-bound session switches agents again, so the IAM agent
// gate is reached by every switch — a member runs another agent exactly when
// that agent is granted to them.
test('a member scoped OUT of the agent cannot prompt as it, and never reaches the re-mint', async () => {
  boundAgent = 'default';
  const response = await promptAs(scopedOut, SCOPED_AGENT);

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  expect(remintCalls).toEqual([]);
  expect(envSyncCalls).toBe(0);
  expect(upstreamCalls).toBe(0);
});

test('the member an agent IS scoped to passes the gate on a default-bound session and re-mints for it', async () => {
  boundAgent = 'default';
  const response = await promptAs(scopedIn, SCOPED_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([SCOPED_AGENT]);
  expect(upstreamCalls).toBe(1);
});

test('the member the switched-to agent IS scoped to switches a running session and re-mints', async () => {
  const response = await promptAs(scopedOut, OTHER_SCOPED_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([OTHER_SCOPED_AGENT]);
  expect(upstreamCalls).toBe(1);
});

test('a member with no grant on the switched-to agent is refused with 403 before any grant work', async () => {
  const response = await promptAs(scopedIn, OTHER_SCOPED_AGENT);

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  expect(remintCalls).toEqual([]);
  expect(envSyncCalls).toBe(0);
  expect(upstreamCalls).toBe(0);
});

// Same-agent turns re-point the token's grant at the running agent, so a
// manifest that narrowed it is enforced from the first call of the turn.
test('the member the session agent IS scoped to prompts as it normally', async () => {
  const response = await promptAs(scopedIn, SESSION_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([SESSION_AGENT]);
  expect(upstreamCalls).toBe(1);
});

test('an account owner keeps the implicit-Manager bypass over resource scoping', async () => {
  boundAgent = 'default';
  const response = await promptAs(owner, SCOPED_AGENT);

  expect(response.status).toBe(200);
  expect(remintCalls).toEqual([SCOPED_AGENT]);
});

test('the scoped-out member can still run the session own agent, though it is scoped away', async () => {
  const response = await promptAs(scopedOut, SESSION_AGENT);

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
});
