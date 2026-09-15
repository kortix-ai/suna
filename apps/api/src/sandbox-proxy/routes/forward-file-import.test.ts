// `POST /file/import` is a daemon route. On :8000 it gets the long import
// attempt timeout and is never replayed: the daemon downloads the attachment and
// does not observe a disconnect, so a replay downloads it again. The same path on
// the user's own server (any other port) is ordinary user traffic and keeps the
// generic attempt timeout and 5xx retries.
//
// The heavier ../backend + ownership + env-sync deps are mocked to inert stubs.
// `bun:test`'s mock.module is process-global, so this lives in its own file (run
// per-file) — same caveat as forward-prompt-dedupe.test.ts.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realKortixUserContext from '../../shared/kortix-user-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';
import { PROXY_ATTEMPT_TIMEOUT_MS, PROXY_IMPORT_ATTEMPT_TIMEOUT_MS } from '../preview-retry-budget';

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  agentName: 'default',
  provider: 'daytona',
};

mock.module('../../config', () => ({ config: {} }));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../../projects/lib/prompt-connector-preflight', () => ({
  PromptConnectorPreflightUnresolved: class PromptConnectorPreflightUnresolved extends Error {},
  missingPromptConnectorConnections: async () => ({ ok: true }),
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
  // The proxy's declared-agent guard; this suite exercises import forwarding.
  agentLaunchableInProject: async () => true,
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async () => 'granted',
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
// Daytona ingress is a pass-through: the effective port is the addressed port.
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: (_record: unknown, request: { port: number }) => ({
    effectivePort: request.port,
  }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
let fetchCalls = 0;
let timerDelays: number[] = [];

function queueFetch(...responses: Response[]) {
  fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetchCalls += 1;
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return next;
  };
}

// The per-attempt connect timer is the only observable of the attempt timeout.
function recordTimerDelays() {
  timerDelays = [];
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timerDelays.push(Number(timeout));
    return ORIGINAL_SET_TIMEOUT(handler, timeout, ...args);
  }) as typeof setTimeout;
}

function importOn(port: number) {
  return forwardToSandbox(
    'sb-1',
    port,
    {
      kind: 'principal',
      userId: 'u1',
      callerSessionId: null,
      boundCredentialSessionId: null,
      sandboxAuthored: false,
    },
    'POST',
    '/file/import',
    '',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode('{}').buffer,
    'http://app.local',
  );
}

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});

describe('forwardToSandbox — POST /file/import', () => {
  test('on the daemon port: one attempt, import timeout, a 502 is not replayed', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }));
    recordTimerDelays();
    const res = await importOn(8000);
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(502);
    expect(timerDelays).toContain(PROXY_IMPORT_ATTEMPT_TIMEOUT_MS);
  });

  test('on a user port: generic attempt timeout, and a 502 retries like any request', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }), new Response('ok', { status: 200 }));
    recordTimerDelays();
    const res = await importOn(3000);
    expect(fetchCalls).toBe(2);
    expect(res.status).toBe(200);
    expect(timerDelays).toContain(PROXY_ATTEMPT_TIMEOUT_MS);
    expect(timerDelays).not.toContain(PROXY_IMPORT_ATTEMPT_TIMEOUT_MS);
  });
});
