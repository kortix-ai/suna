// R2 (the turn-latency spec (PR #7840) §3) — the turn-start pre-flight gates that
// have no data dependency on each other must run CONCURRENTLY, not queue
// behind each other: `forwardToSandbox`'s model-catalog-converge
// (`convergeModelCatalogForTurnStart`) and the first-attempt provider-ingress
// resolve (`resolveSandboxIngress`). And the config gate
// (`convergeConfigIfBehind`) is not on the send path at all: it runs after a
// turn ends (2026-10-13). This file asserts both with timed fakes — a
// response-only assertion proves nothing about latency.
//
// `mock.module` is process-global; this file owns its module graph under
// `bun test --isolate` (same convention as forward.test.ts, which this file
// is a sibling of).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realKortixUserContext from '../../shared/kortix-user-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';

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

/** Delay (ms) each instrumented gate holds before resolving. */
const GATE_DELAY_MS = 40;
let gateLog: string[] = [];

function hold(label: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    gateLog.push(`${label}:start`);
    setTimeout(() => {
      gateLog.push(`${label}:end`);
      resolve();
    }, ms);
  });
}

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
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  agentLaunchableInProject: async () => true,
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/lib/turn-start-convergence', () => ({
  convergeConfigIfBehind: async () => {
    await hold('config-converge', GATE_DELAY_MS);
    return { decision: 'current', outcome: null, ms: GATE_DELAY_MS };
  },
  scheduleAssetConvergence: () => {},
  convergeModelCatalogForTurnStart: async () => {
    await hold('model-catalog-converge', GATE_DELAY_MS);
    return { decision: 'skipped' };
  },
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async () => 'granted',
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
}));
mock.module('../../projects/session-open', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: (_record: unknown, request: { port: number }) => ({
    effectivePort: request.port,
  }),
  resolveSandboxIngress: async () => {
    await hold('ingress', GATE_DELAY_MS);
    return { url: 'http://sandbox.local', headers: {} };
  },
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;

const principal = {
  kind: 'principal' as const,
  userId: 'u1',
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
};
const jsonHeaders = () => new Headers({ 'content-type': 'application/json' });
const bodyOf = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
// No `agent`, no `model` — skips the agent-switch gate and the model-catalog
// gate's own early-return-on-null-model path stays exercised through the
// mock above regardless (the mock always holds GATE_DELAY_MS).
const PROMPT_BODY = bodyOf({ parts: [{ type: 'text', text: 'hi' }] });

beforeEach(() => {
  __resetPromptDedupe();
  gateLog = [];
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response('{"info":{},"parts":[]}', { status: 200 });
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('forwardToSandbox — turn-start pre-flight runs concurrently (R2)', () => {
  test('model-catalog-converge and ingress overlap, and the config gate never runs', async () => {
    const res = await forwardToSandbox(
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders(),
      PROMPT_BODY,
      'http://app.local',
    );
    expect(res.status).toBe(200);

    // Concurrent means each gate's OWN start precedes the OTHER gate's end,
    // which only an overlapping schedule can produce. Event order, not wall
    // clock: a wall-clock bound re-flaked under load on a busy runner.
    const startIdx = (label: string) => gateLog.indexOf(`${label}:start`);
    const endIdx = (label: string) => gateLog.indexOf(`${label}:end`);
    expect(startIdx('model-catalog-converge')).toBeGreaterThanOrEqual(0);
    expect(startIdx('ingress')).toBeLessThan(endIdx('model-catalog-converge'));
    expect(startIdx('model-catalog-converge')).toBeLessThan(endIdx('ingress'));
    // The prompt never waits for a config convergence.
    expect(startIdx('config-converge')).toBe(-1);
  });
});
