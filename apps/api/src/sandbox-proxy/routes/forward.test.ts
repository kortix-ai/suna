// forwardToSandbox on the prompt and daemon paths, through a fake network.
//
// - A prompt POST reaches the sandbox at most once: the proxy retries an
//   idempotent GET on 502/503/timeout, but a re-POSTed prompt enqueues the
//   user's message again. A duplicate inbound prompt under the same
//   Idempotency-Key short-circuits.
// - The client's wire `messageID` is PLACED against the target session's
//   transcript tip before delivery, child sessions included. On 2026-08-18 a
//   steering prompt into a mid-turn child, minted by a tab whose store held
//   none of that child's messages, sorted below the child's tip; OpenCode read
//   it as answered. See ../prompt-wire-id-repair.ts.
// - `POST /file/import` on the daemon port gets the long import timeout and is
//   never replayed: the daemon downloads the attachment and does not observe a
//   disconnect. On a user port it is ordinary traffic.
//
// The heavier ../backend, ownership and env-sync dependencies are inert stubs.
// `mock.module` is process-global; the `--isolate` runner gives this file its
// own module graph.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import { WIRE_MESSAGE_ID, mintWireMessageId, wireIdTime } from '../../projects/wire-message-id';
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
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every other one.
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
// The real grant re-mint fails a prompt CLOSED when it cannot read the session
// token, so an unmocked db turns every delivery case red for a reason that has
// nothing to do with delivery.
mock.module('../../projects/lib/session-token-grant', () => ({
  agentLaunchableInProject: async () => true,
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/lib/turn-start-convergence', () => ({
  // The C9 turn-start convergence gate reads the session's project row before
  // every prompt. There is no database in this file, so each call waits out the
  // driver's connect timeout — 5 s per prompt, which times these cases out.
  // This suite is about delivery dedupe and wire-id placement, so the gate is
  // stubbed to its no-op answer.
  convergeBeforeTurnStart: async () => ({ decision: 'skipped', outcome: null, ms: 0 }),
  // The runtime-asset lane beside the config gate. Void, never awaited — a
  // stub is enough here, and its absence is a module LINK error, not a skip.
  scheduleAssetConvergence: () => {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
// The ledger identity the proxy begins the turn under.
let begunTurns: Array<{ opencodeSessionId: string; messageId: string | null }> = [];
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async (
    _target: unknown,
    turn: { opencodeSessionId: string; messageId: string | null },
  ) => {
    begunTurns.push({ opencodeSessionId: turn.opencodeSessionId, messageId: turn.messageId });
    return 'granted';
  },
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
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

const principal = {
  kind: 'principal' as const,
  userId: 'u1',
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
};
const jsonHeaders = (extra?: Record<string, string>) =>
  new Headers({ 'content-type': 'application/json', ...(extra ?? {}) });
const bodyOf = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;
const PROMPT_BODY = bodyOf({ parts: [{ type: 'text', text: 'hi' }] });

/** A fetch that answers from a queue, in order, and counts its calls. */
let fetchCalls = 0;
function queueFetch(...responses: Response[]) {
  fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetchCalls += 1;
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return next;
  };
}

beforeEach(() => {
  __resetPromptDedupe();
  begunTurns = [];
});
// Restore per TEST: a case that fails before installing its own fetch would
// otherwise run against the previous case's exhausted queue.
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});

describe('forwardToSandbox — prompt delivery is never double-sent', () => {
  test('a prompt POST that 502s is delivered to the sandbox at most once', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }));
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
    // Exactly ONE upstream attempt — the 502 is passed straight through, never retried.
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(502);
  });

  test('a duplicate inbound prompt under the same Idempotency-Key short-circuits', async () => {
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const args = [
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders({ 'idempotency-key': 'dup-1' }),
      PROMPT_BODY,
      'http://app.local',
    ] as const;
    const first = await forwardToSandbox(...args);
    const second = await forwardToSandbox(...args);
    // Only the first reached the upstream; the second was deduped.
    expect(fetchCalls).toBe(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate', deduplicated: true });
  });

  // DEF-FLAGON-1. The SDK's `send()` posts `{parts}` to `/session/:id/message`
  // with no Idempotency-Key and no wire `messageID`, so `promptDeliveryKey`
  // falls to its content hash. Two deliberate sends of one sentence hash the
  // same. The proxy once answered the second with `{status:'duplicate'}`: no
  // turn ran, and the CLI crashed on a body with no `parts`.
  test('the same sentence sent twice with no client identity reaches the sandbox twice', async () => {
    const args = [
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders(),
      PROMPT_BODY,
      'http://app.local',
    ] as const;
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    expect((await forwardToSandbox(...args)).status).toBe(200);
    expect(fetchCalls).toBe(1);

    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const second = await forwardToSandbox(...args);
    expect(fetchCalls).toBe(1);
    expect(second.status).toBe(200);
    expect(await second.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
  });

  test('a resend that carries the same wire messageID still dedupes', async () => {
    const args = [
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders(),
      bodyOf({ messageID: 'msg_abc', parts: [{ type: 'text', text: 'hi' }] }),
      'http://app.local',
    ] as const;
    // One delivery costs two upstream calls: the wire-id placement read
    // (`promptTranscriptReadPath`), then the prompt.
    queueFetch(new Response('[]', { status: 200 }), new Response('{"info":{},"parts":[]}', { status: 200 }));
    expect((await forwardToSandbox(...args)).status).toBe(200);
    expect(fetchCalls).toBe(2);
    const second = await forwardToSandbox(...args);
    expect(fetchCalls).toBe(2);
    expect(await second.json()).toEqual({ status: 'duplicate', deduplicated: true });
  });
});

describe('forwardToSandbox — idempotent GET retry is unchanged', () => {
  test('a GET that 502s then 200s is retried and returns the eventual success', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }), new Response('ok', { status: 200 }));
    const res = await forwardToSandbox(
      'sb-1',
      8000,
      principal,
      'GET',
      '/session',
      '',
      new Headers(),
      undefined,
      'http://app.local',
    );
    expect(fetchCalls).toBe(2);
    expect(res.status).toBe(200);
  });
});

describe('forwardToSandbox — a sandbox-down 400 on the LAST attempt releases the claim', () => {
  const sandboxDown = () =>
    new Response('failed to get runner info: no IP address found', { status: 400 });

  test('the retry re-delivers instead of getting a bogus 200 duplicate', async () => {
    // The reviewer's catch on this PR. The Daytona sandbox-down branch used to be
    // `if (status === 400 && attempt < MAX_RETRIES)`, so on the FINAL attempt it
    // fell through and returned the 400 to the client with the dedupe claim still
    // held. The client's retry under the same Idempotency-Key then short-circuited
    // to `{status:'duplicate'}` and the user's prompt was silently lost — the very
    // message-loss this PR exists to stop, surviving in the one path it missed.
    //
    // Daytona rejects this BEFORE opencode ("no IP address found" means the box has
    // no runner at all), so delivery is provably not-delivered and releasing is safe.
    const args = [
      'sb-1',
      8000,
      principal,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders({ 'idempotency-key': 'down-1' }),
      PROMPT_BODY,
      'http://app.local',
    ] as const;

    // MAX_RETRIES = 3 → four attempts, every one sandbox-down.
    queueFetch(sandboxDown(), sandboxDown(), sandboxDown(), sandboxDown());
    const first = await forwardToSandbox(...args);
    expect(first.status).toBe(400);

    // THE ASSERTION: the retry must actually reach the sandbox again. Before the
    // fix this was 0 fetches and a 200 "duplicate".
    queueFetch(new Response('{"ok":true}', { status: 200 }));
    const retry = await forwardToSandbox(...args);
    expect(fetchCalls).toBe(1);
    expect(retry.status).toBe(200);
    expect(await retry.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
  });
});

// ── wire id placement ──
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
      jsonHeaders(),
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

    const res = await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/message', '', jsonHeaders(), bodyOf(body), 'http://app.local');

    expect(res.status).toBe(200);
    expect(fetchLog[1].body).toBe(JSON.stringify(body));
    expect(begunTurns[0]?.messageId).toBe(client.id);
    expect(res.headers.get('X-Kortix-Effective-Message-Id')).toBe(client.id);
  });

  test('a body with NO client id pays for no read at all — OpenCode mints', async () => {
    installFetch([]);
    await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', jsonHeaders(), bodyOf({ parts: [{ type: 'text', text: 'hi' }] }), 'http://app.local');
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
  });

  test('an unreachable transcript read keeps the client id — repair needs positive evidence', async () => {
    const client = mintWireMessageId({ nowMs: NOW - 300_000 });
    installFetch('unreachable');
    const body = { messageID: client.id, parts: [{ type: 'text', text: 'hi' }] };
    const res = await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', jsonHeaders(), bodyOf(body), 'http://app.local');
    expect(res.status).toBe(200);
    expect(fetchLog[1].body).toBe(JSON.stringify(body));
    expect(begunTurns[0]?.messageId).toBe(client.id);
  });

  test('a /command carries no client id and is never read for placement', async () => {
    installFetch([]);
    await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/command', '', jsonHeaders(), bodyOf({ command: 'compact', arguments: '' }), 'http://app.local');
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
  });

  test('the "already placed" header cannot carry a far-future id past the repair', async () => {
    // Any client can send `X-Kortix-Wire-Id-Placed: 1`; the inbox drain is the
    // only intended sender. A far-future id (the pre-fix CLI's high-bits
    // mint) is re-minted on the id alone, without the transcript read.
    const farFuture = `msg_${((BigInt(NOW) * BigInt(0x1000)) >> BigInt(8)).toString(16).slice(0, 12)}SyntheticCli07`;
    installFetch([]);
    const placedHeaders = jsonHeaders();
    placedHeaders.set('X-Kortix-Wire-Id-Placed', '1');
    const res = await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', placedHeaders, bodyOf({ messageID: farFuture, parts: [{ type: 'text', text: 'hi' }] }), 'http://app.local');
    expect(res.status).toBe(200);
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
    const delivered = JSON.parse(fetchLog[0].body!) as { messageID: string };
    expect(delivered.messageID).not.toBe(farFuture);
    expect(delivered.messageID).toMatch(WIRE_MESSAGE_ID);
    expect(res.headers.get('X-Kortix-Effective-Message-Id')).toBe(delivered.messageID);
  });

  test('the "already placed" header still skips the read for an id near the clock', async () => {
    const client = mintWireMessageId({ nowMs: NOW });
    installFetch([]);
    const placedHeaders = jsonHeaders();
    placedHeaders.set('X-Kortix-Wire-Id-Placed', '1');
    const body = { messageID: client.id, parts: [{ type: 'text', text: 'hi' }] };
    await forwardToSandbox('sb-1', 8000, principal, 'POST', '/session/ses_1/prompt_async', '', placedHeaders, bodyOf(body), 'http://app.local');
    expect(fetchLog.map((f) => f.method)).toEqual(['POST']);
    expect(fetchLog[0].body).toBe(JSON.stringify(body));
  });
});

// ── daemon import route ──
let timerDelays: number[] = [];

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
    principal,
    'POST',
    '/file/import',
    '',
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode('{}').buffer,
    'http://app.local',
  );
}

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
