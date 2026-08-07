// A mid-session PROMPT whose required connector has nothing usable connected to
// it must be refused before the sandbox sees it.
//
// The pre-flight existed only at session create and warm-claim. A follow-up
// prompt went straight through, so the founder's session answered "Still no
// active connectors. The Gmail connector is gone from the connector catalog." —
// the agent apologising mid-turn for something the platform knew before the
// first byte, after the user had already paid for the turn.
//
// The POSITION of the gate is as load-bearing as its existence, and the
// duplicate test below is the one that pins it: refuse after
// `claimPromptDelivery` and the Idempotency-Key is burned, so the retry the user
// makes AFTER connecting Gmail comes back `200 {status:'duplicate'}` with their
// message silently dropped — a worse bug than the one being fixed.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';
import * as realKortixUserContext from '../../shared/kortix-user-context';

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  sandboxId: 'sbx-1',
  agentName: 'inbox-triage',
  provider: 'daytona',
};

const GMAIL_CONNECTION = {
  id: '11111111-1111-4111-a111-111111111111',
  slug: 'gmail',
  name: 'Gmail',
  authorization_strategy: 'project' as const,
};

type Verdict =
  | { ok: true }
  | { ok: false; kind: 'authorization_required'; connections: unknown[] }
  | { ok: false; kind: 'unavailable'; aliases: string[] };

let verdict: Verdict = { ok: true };
let preflightThrows: Error | null = null;
let preflightCalls: Array<{ sessionAgent: string; requestedAgent: string | null }> = [];

class PromptConnectorPreflightUnresolved extends Error {}

// This file exercises an unrelated proxy contract with an ordinary session.
mock.module('../../projects/task-worker-prompt-admission', () => ({
  projectTaskWorkerPromptAdmission: async () => ({ state: 'not_worker' }),
  taskWorkerPromptIsAllowed: () => true,
}));

mock.module('../../config', () => ({ config: { KORTIX_ENFORCE_SESSION_AGENT_LOCK: false } }));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
let authorizeAllowed = true;
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async () =>
    authorizeAllowed
      ? { allowed: true, reason: 'project_role' }
      : { allowed: false, reason: 'resource_scope_insufficient' },
}));
mock.module('../../projects/lib/prompt-connector-preflight', () => ({
  PromptConnectorPreflightUnresolved,
  missingPromptConnectorConnections: async (input: {
    sessionAgent: string;
    requestedAgent: string | null;
  }) => {
    preflightCalls.push({ sessionAgent: input.sessionAgent, requestedAgent: input.requestedAgent });
    if (preflightThrows) throw preflightThrows;
    return verdict;
  },
}));

let envSyncCalls = 0;
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {
    envSyncCalls += 1;
  },
}));
let remintCalls = 0;
mock.module('../../projects/lib/session-token-grant', () => ({
  remintGrantForAgentSwitch: async () => {
    remintCalls += 1;
    return { action: 'skip' };
  },
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: () => ({ effectivePort: 8000 }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
let upstreamCalls = 0;
(globalThis as { fetch: unknown }).fetch = async () => {
  upstreamCalls += 1;
  return Response.json({ ok: true });
};

const ACCESS = {
  kind: 'principal' as const,
  userId: 'user-1',
  callerSessionId: null,
  sandboxAuthored: false,
};

function send(path: string, payload: Record<string, unknown>, port = 8000): Promise<Response> {
  return forwardToSandbox(
    'sbx-1',
    port,
    ACCESS,
    'POST',
    path,
    '',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
    'http://localhost:3000',
  );
}

let seq = 0;
function prompt(agent?: string): Promise<Response> {
  seq += 1;
  const payload: Record<string, unknown> = { parts: [{ type: 'text', text: `turn ${seq}` }] };
  if (agent !== undefined) payload.agent = agent;
  return send('/session/ses_1/prompt_async', payload);
}

beforeEach(() => {
  authorizeAllowed = true;
  verdict = { ok: true };
  preflightThrows = null;
  preflightCalls = [];
  envSyncCalls = 0;
  remintCalls = 0;
  upstreamCalls = 0;
  __resetPromptDedupe();
});

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  mock.restore();
});

test('a prompt needing an unconnected connector is refused 409 and never reaches the sandbox', async () => {
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const response = await prompt();

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'CONNECTOR_CONNECTION_REQUIRED',
    connector_connections: [GMAIL_CONNECTION],
  });
  // Nothing streamed, nothing spent, no side effect taken on a turn that did not run.
  expect(upstreamCalls).toBe(0);
  expect(envSyncCalls).toBe(0);
  expect(remintCalls).toBe(0);
});

test('the refusal carries `message` as well as `error`', async () => {
  // The SDK prefers `message` and otherwise substitutes a generic
  // "Failed to send message", which would bury the whole point of the refusal.
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const body = (await (await prompt()).json()) as Record<string, unknown>;

  expect(typeof body.message).toBe('string');
  expect(body.message).toBe(body.error);
});

test('an alias that is not a connector on the project refuses with the unavailable code', async () => {
  verdict = { ok: false, kind: 'unavailable', aliases: ['gmail', 'slack'] };

  const response = await prompt();

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: 'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
    connectors: ['gmail', 'slack'],
    // Plural list, plural verb.
    error: 'Required connections "gmail", "slack" are unavailable',
  });
  expect(upstreamCalls).toBe(0);
});

test('RETRYING AFTER CONNECTING IS NOT SWALLOWED AS A DUPLICATE', async () => {
  // The reason the gate sits above `claimPromptDelivery`. Refusing below it burns
  // the Idempotency-Key, so this second send — byte-identical, which is exactly
  // what a retry is — would come back 200 {status:'duplicate'} and the user's
  // message would vanish. This assertion is the only one that pins the position.
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };
  const refused = await send('/session/ses_1/prompt_async', {
    parts: [{ type: 'text', text: 'read my inbox' }],
  });
  expect(refused.status).toBe(409);

  verdict = { ok: true };
  const retried = await send('/session/ses_1/prompt_async', {
    parts: [{ type: 'text', text: 'read my inbox' }],
  });

  expect(retried.status).toBe(200);
  expect(await retried.json()).not.toMatchObject({ status: 'duplicate' });
  expect(upstreamCalls).toBe(1);
});

test('a transient lookup failure is 503, never a 409 telling the user to connect', async () => {
  // We could not ESTABLISH the answer. Saying "connect your Gmail" off a git blip
  // is a confident lie, and the client retries a 503 while it never retries a 4xx.
  preflightThrows = new PromptConnectorPreflightUnresolved('git mirror unavailable');

  const response = await prompt();

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'CONNECTOR_REQUIREMENTS_UNRESOLVED' });
  expect(upstreamCalls).toBe(0);
});

test('the gate reads the agent this prompt will actually RUN, not the boot agent', async () => {
  // A prompt may switch agents, and the agent that runs is the one whose manifest
  // says what it requires — the same rule the secret grant already follows.
  await prompt('nda-turnaround');

  expect(preflightCalls).toEqual([
    { sessionAgent: 'inbox-triage', requestedAgent: 'nda-turnaround' },
  ]);
});

test('every turn-start shape is gated, not just prompt_async', async () => {
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  for (const path of [
    '/session/ses_1/prompt_async',
    '/session/ses_1/message',
    '/session/ses_1/command',
  ]) {
    expect((await send(path, { parts: [] })).status).toBe(409);
  }
  expect(upstreamCalls).toBe(0);
});

test('summarize is NOT gated — compaction is not a user turn', async () => {
  // Refusing to compact a conversation because Gmail is disconnected would wedge
  // the session rather than protect it.
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const response = await send('/session/ses_1/summarize', {});

  expect(response.status).toBe(200);
  expect(preflightCalls).toEqual([]);
  expect(upstreamCalls).toBe(1);
});

test('a turn addressed straight to the other session-data port is gated too', async () => {
  // The env-sync predicate keys on the client-addressed port, so :4096 slips past
  // it. This gate is built on isTurnStartRequest, which covers both.
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const response = await send('/session/ses_1/prompt_async', { parts: [] }, 4096);

  expect(response.status).toBe(409);
  expect(upstreamCalls).toBe(0);
});

test('an ordinary turn with nothing required pays nothing and forwards', async () => {
  const response = await prompt();

  expect(response.status).toBe(200);
  expect(upstreamCalls).toBe(1);
  expect(envSyncCalls).toBe(1);
});

test('a non-turn request is never gated', async () => {
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const response = await forwardToSandbox(
    'sbx-1',
    8000,
    ACCESS,
    'GET',
    '/session/ses_1',
    '',
    new Headers(),
    undefined,
    'http://localhost:3000',
  );

  expect(response.status).toBe(200);
  expect(preflightCalls).toEqual([]);
});

test('an unauthorized agent switch is refused WITHOUT revealing that agent\'s connectors', async () => {
  // The gate reads the requested agent's manifest, and its refusal carries that
  // agent's connector ids, names and strategies. A caller who may not run agent B
  // must not be able to enumerate them by naming B in a prompt — so the
  // authorization decision has to come first, not after.
  authorizeAllowed = false;
  verdict = { ok: false, kind: 'authorization_required', connections: [GMAIL_CONNECTION] };

  const response = await prompt('nda-turnaround');

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
  expect(preflightCalls).toEqual([]);
  expect(upstreamCalls).toBe(0);
});

test('a refused agent switch does not burn the idempotency key either', async () => {
  // Same reasoning as the connector retry: the 403 used to sit below the dedupe
  // claim, so being granted access and retrying returned a silent duplicate.
  authorizeAllowed = false;
  const body = { parts: [{ type: 'text', text: 'run it' }], agent: 'nda-turnaround' };
  expect((await send('/session/ses_1/prompt_async', body)).status).toBe(403);

  authorizeAllowed = true;
  const retried = await send('/session/ses_1/prompt_async', body);

  expect(retried.status).toBe(200);
  expect(await retried.json()).not.toMatchObject({ status: 'duplicate' });
  expect(upstreamCalls).toBe(1);
});
