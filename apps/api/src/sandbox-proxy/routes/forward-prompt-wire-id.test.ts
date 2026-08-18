// forwardToSandbox PLACES the client's wire `messageID` against the target
// session's actual transcript tip before delivering — for any target session,
// child sessions included. The 2026-08-18 Essentia incident: a steering prompt
// into a mid-turn child, minted by a tab whose store held none of that child's
// messages, sorted below the child's tip; OpenCode read it as answered and the
// turn looped on. See ../prompt-wire-id-repair.ts.
//
// Same mock topology as forward-prompt-dedupe.test.ts (own file: mock.module is
// process-global).
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';
import * as realKortixUserContext from '../../shared/kortix-user-context';
import { WIRE_MESSAGE_ID, mintWireMessageId, wireIdTime } from '../../projects/wire-message-id';

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
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
// The ledger identity the proxy begins the turn under — asserted below to be
// the EFFECTIVE id, so the daemon's exact-message probe matches what exists.
let begunTurns: Array<{ opencodeSessionId: string; messageId: string | null }> = [];
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async (_target: unknown, turn: { opencodeSessionId: string; messageId: string | null }) => {
    begunTurns.push({ opencodeSessionId: turn.opencodeSessionId, messageId: turn.messageId });
    return 'granted';
  },
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
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
let fetchLog: Array<{ url: string; method: string; body: string | null }> = [];

/** Route by URL: the transcript read answers with `transcript`, the delivery
 *  records its body and answers 200. */
function installFetch(transcript: unknown | 'unreachable') {
  fetchLog = [];
  (globalThis as { fetch: unknown }).fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    let body: string | null = null;
    if (init?.body instanceof ArrayBuffer) body = new TextDecoder().decode(init.body);
    else if (typeof init?.body === 'string') body = init.body;
    fetchLog.push({ url, method, body });
    if (method === 'GET' && url.includes('/message?limit=')) {
      if (transcript === 'unreachable') throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(transcript), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"info":{},"parts":[]}', { status: 200 });
  };
}

const NOW = Date.now();
const headers = () => new Headers({ 'content-type': 'application/json' });
const bodyOf = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
const principal = { kind: 'principal' as const, userId: 'u1', callerSessionId: null, sandboxAuthored: false };

beforeEach(() => {
  __resetPromptDedupe();
  begunTurns = [];
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('forwardToSandbox — wire id placement on the direct prompt path', () => {
  test('a STALE client id into a streaming CHILD session is re-minted above the tip, ledger + echo agree', async () => {
    const tip = mintWireMessageId({ nowMs: NOW - 500 });
    const stale = mintWireMessageId({ nowMs: NOW - 120_000 });
    installFetch([{ info: { id: tip.id, role: 'assistant' } }]);

    const res = await forwardToSandbox(
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/ses_child/prompt_async',
      '',
      headers(),
      bodyOf({ messageID: stale.id, parts: [{ type: 'text', text: 'stop looping' }] }),
      'http://app.local',
    );

    expect(res.status).toBe(200);
    // One bounded read of THE CHILD's transcript, then one delivery.
    expect(fetchLog.map((f) => f.method)).toEqual(['GET', 'POST']);
    expect(fetchLog[0].url).toBe('http://sandbox.local/session/ses_child/message?limit=8');
    const delivered = JSON.parse(fetchLog[1].body!) as { messageID: string; parts: unknown[] };
    expect(delivered.messageID).toMatch(WIRE_MESSAGE_ID);
    expect(delivered.messageID).not.toBe(stale.id);
    expect(wireIdTime(delivered.messageID)! > tip.time).toBe(true);
    expect(delivered.parts).toEqual([{ type: 'text', text: 'stop looping' }]);
    // The turn ledger was begun under the EFFECTIVE id, not the stale one.
    expect(begunTurns).toEqual([{ opencodeSessionId: 'ses_child', messageId: delivered.messageID }]);
    // And the sender can correlate.
    expect(res.headers.get('X-Kortix-Effective-Message-Id')).toBe(delivered.messageID);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Kortix-Effective-Message-Id');
  });

  test('a well-placed client id is forwarded byte-for-byte and echoed unchanged', async () => {
    const tip = mintWireMessageId({ nowMs: NOW - 60_000 });
    const client = mintWireMessageId({ nowMs: NOW });
    installFetch([{ info: { id: tip.id, role: 'assistant' } }]);
    const body = { messageID: client.id, parts: [{ type: 'text', text: 'ok' }] };

    const res = await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/message', '', headers(), bodyOf(body), 'http://app.local');

    expect(res.status).toBe(200);
    expect(fetchLog[1].body).toBe(JSON.stringify(body));
    expect(begunTurns[0]?.messageId).toBe(client.id);
    expect(res.headers.get('X-Kortix-Effective-Message-Id')).toBe(client.id);
  });

  test('a body with NO client id pays for no read at all — OpenCode mints', async () => {
    installFetch([]);
    await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', headers(), bodyOf({ parts: [{ type: 'text', text: 'hi' }] }), 'http://app.local');
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
  });

  test('an unreachable transcript read keeps the client id — repair needs positive evidence', async () => {
    const client = mintWireMessageId({ nowMs: NOW - 300_000 });
    installFetch('unreachable');
    const body = { messageID: client.id, parts: [{ type: 'text', text: 'hi' }] };
    const res = await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', headers(), bodyOf(body), 'http://app.local');
    expect(res.status).toBe(200);
    expect(fetchLog[1].body).toBe(JSON.stringify(body));
    expect(begunTurns[0]?.messageId).toBe(client.id);
  });

  test('a /command carries no client id and is never read for placement', async () => {
    installFetch([]);
    await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/command', '', headers(), bodyOf({ command: 'compact', arguments: '' }), 'http://app.local');
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
  });
});
