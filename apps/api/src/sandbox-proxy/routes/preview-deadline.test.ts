// What the proxy treats as lifecycle authority for a sandbox.
//
// Three defects review found in the first cut of the deadline model, all of them
// user-visible:
//
//  1. A human clicking through the dev server their agent just built extended
//     NOTHING, so the live preview died 15 minutes after the last AGENT turn
//     while the user was still using it — a worse regression than the zombie
//     boxes the model exists to kill.
//  2. Passive traffic on the session-data ports must STILL not count — that
//     resurrection is what produced 1,597 phantom-active compute rows.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
// The real module namespaces: `mock.module` replaces a module WHOLESALE, so a
// stub that lists exports by hand deletes every export it omits — the failure
// lands in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.

const ACTIVE_RECORD = {
  sandboxId: 'sb-1',
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  agentName: 'default',
  provider: 'daytona',
};

/** Every deadline write the proxy attempts, with the grant it asked for. */
let extends_: Array<{ target: unknown; grantMs: number | undefined }> = [];
let turnStartObservation: 'granted' | 'no_box' = 'granted';

let begunTurns: Array<{ target: unknown; turn: Record<string, unknown> }> = [];
let acceptedTurns: Array<{ target: unknown; token: string }> = [];
let abandonedTurns: Array<{ target: unknown; token: string }> = [];
let turnBeginError: Error | null = null;
let turnAcceptError: Error | null = null;
let turnAbandonError: Error | null = null;

let upstreamPort = 3000;

// The real module namespaces, captured the way this file captures its other real
// modules (top-level await): `mock.module` does not override a module that a
// static import already evaluated, so these MUST stay dynamic — a static import
// here silently turns every mock below into a dead no-op. The spreads keep each
// stub wholesale-complete: an omitted export deletes the name for every later
// importer in this worker and the failure lands elsewhere, attributed to no test.
const realRequestContext = await import('../../lib/request-context');
const realConfig = await import('../../config');
const realSharedDb = await import('../../shared/db');
const realProxyBackend = await import('../backend');
const realSandboxEnvSync = await import('../../projects/lib/sandbox-env-sync');
const realSessionTokenGrant = await import('../../projects/lib/session-token-grant');
const realSessionActivity = await import('../../projects/session-activity');
const realKortixUserContext = await import('../../shared/kortix-user-context');
const realPreviewOwnership = await import('../../shared/preview-ownership');
mock.module('../../config', () => ({
  ...realConfig,
  config: {},
}));
// Importing the real lifecycle export surface must not initialize the actual
// database module. The route under test replaces every lifecycle write below.
mock.module('../../shared/db', () => ({
  ...realSharedDb,
  db: { execute: async () => [] },
}));
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
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  ...realSandboxEnvSync,
  // Env sync is silenced wholesale in this suite (it talks to the database and
  // to sandboxes; the deadline flow under test must not depend on it): every
  // push/propagate entry point is an explicit no-op, not an omitted export.
  syncSandboxEnvForPrompt: async () => {},
  propagateProjectSecretsToActiveSandboxes: async () => {},
  syncSessionSecretsToSandbox: async () => {},
  propagateLlmGatewayModeToActiveSandboxes: async () => {},
  pushSessionAgentConfigToSandbox: async () => {},
  pushSessionModelToSandbox: async () => {},
  pushSessionScopeToSandbox: async () => {},
  daemonHasConfigReleases: async () => false,
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  ...realSessionTokenGrant,
  // The proxy's declared-agent guard; these suites exercise other behavior.
  agentLaunchableInProject: async () => true,
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/session-activity', () => ({
  ...realSessionActivity,
  recordSessionActivity: async () => {},
}));
// `session-open` is imported LAST, after every other mock above is registered:
// its module graph evaluates `forward/turn-start.ts`, whose deps object captures
// `syncSandboxEnvForPrompt` and the token-grant remint at evaluation time — an
// early import here would freeze the REAL collaborators into the route's deps
// and silently bypass the mocks below.
const realSessionOpen = await import('../../projects/session-open');
mock.module('../../projects/session-open', () => ({
  ...realSessionOpen,
  // The sandbox under test is already live (`backend.loadSandbox` returns the
  // active record): every runtime-opening path below is an explicit no-op —
  // the real functions read the database, which this suite stubs away
  // wholesale (their omitted exports would otherwise break unrelated files).
  openSession: async () => undefined,
  resumeStoppedSandbox: async () => undefined,
  resumeStoppedSandboxByExternalId: async () => true,
  retryTransientProvisionFailure: async () => undefined,
  replaceRefusedRuntimeOnOpen: async () => undefined,
  preserveEstablishedRuntimeOnOpen: async () => undefined,
  markRuntimeWakeStarted: async () => undefined,
  markRuntimeReadyWaitStarted: async () => undefined,
}));
// The deadline module is stubbed only where it TALKS TO THE DATABASE. The
// classifiers (isTurnStartRequest / isPreviewUseObservation / isSandboxAuthored)
// and the grant sizes are the REAL ones, because the thing under test here is
// which requests reach a writer and with what grant.
const realDeadline = await import('../../projects/sandbox-deadline-policy');
const realDeadlineWrites = await import('../../projects/sandbox-deadline');
mock.module('../../projects/sandbox-deadline', () => ({
  ...realDeadlineWrites,
  ...realDeadline,
  extendSandboxDeadline: async (target: unknown, grantMs?: number) => {
    extends_.push({ target, grantMs });
  },
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
const realTurnLedger = await import('../../projects/session-turn-ledger');
mock.module('../../projects/session-turn-ledger', () => ({
  ...realTurnLedger,
  extractTurnIdentity: () => ({ opencodeSessionId: 'sess-1', messageId: 'msg-turn-1' }),
}));
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async (target: unknown, turn: Record<string, unknown>) => {
    begunTurns.push({ target, turn });
    if (turnBeginError) throw turnBeginError;
    return turnStartObservation;
  },
  acceptSandboxTurn: async (target: unknown, token: string) => {
    acceptedTurns.push({ target, token });
    if (turnAcceptError) throw turnAcceptError;
    return true;
  },
  abandonSandboxTurn: async (target: unknown, token: string) => {
    abandonedTurns.push({ target, token });
    if (turnAbandonError) throw turnAbandonError;
  },
}));

mock.module('../backend', () => ({
  ...realProxyBackend,
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: () => ({ effectivePort: upstreamPort }),
  resolveSandboxIngress: async () => ({
    url: 'http://sandbox.local',
    headers: {},
  }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
function respondWith(response: Response) {
  (globalThis as { fetch: unknown }).fetch = async () => response.clone();
}

const HUMAN = {
  kind: 'principal',
  userId: 'u1',
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
} as const;
const BOX_ITSELF = {
  kind: 'principal',
  userId: 'u1',
  callerSessionId: 'sess-1',
  boundCredentialSessionId: 'sess-1',
  sandboxAuthored: true,
} as const;
const SHARE = { kind: 'public_share' } as const;

const PROMPT_BODY = new TextEncoder().encode(
  JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
).buffer;

// The preview-use extend is throttled per BOX and the throttle is module state
// that outlives a single test, so each test drives its own external id. Sharing
// one would let a later assertion of "no extend" pass because an earlier test had
// already consumed the window.
let boxCounter = 0;
let externalId = 'ext-0';

function get(access: typeof HUMAN | typeof BOX_ITSELF | typeof SHARE, path: string, port = 3000) {
  upstreamPort = port;
  return forwardToSandbox(
    externalId,
    port,
    access,
    'GET',
    path,
    '',
    new Headers(),
    undefined,
    'http://localhost',
  );
}

function prompt(access: typeof HUMAN | typeof BOX_ITSELF) {
  upstreamPort = 8000;
  return forwardToSandbox(
    externalId,
    8000,
    access,
    'POST',
    '/session/sess-1/prompt_async',
    '',
    new Headers({ 'content-type': 'application/json' }),
    PROMPT_BODY,
    'http://localhost',
  );
}

beforeEach(() => {
  __resetPromptDedupe();
  extends_ = [];
  begunTurns = [];
  acceptedTurns = [];
  abandonedTurns = [];
  turnBeginError = null;
  turnAcceptError = null;
  turnAbandonError = null;
  turnStartObservation = 'granted';
  upstreamPort = 3000;
  boxCounter += 1;
  externalId = `ext-${boxCounter}`;
  respondWith(new Response('ok', { status: 200 }));
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('a human using the live preview keeps the box alive', () => {
  test('REGRESSION: authenticated human traffic to a dev-server port EXTENDS the box', async () => {
    const res = await get(HUMAN, '/');

    expect(res.status).toBe(200);
    expect(extends_).toHaveLength(1);
    expect(extends_[0].target).toEqual({ externalId });
    // The preview grant, not the 4-hour turn grant.
    expect(extends_[0].grantMs).toBe(realDeadline.previewGrantMs());
  });

  test('the box fetching its OWN preview extends nothing', async () => {
    await get(BOX_ITSELF, '/');

    expect(extends_).toEqual([]);
  });

  test('a public share link extends nothing', async () => {
    await get(SHARE, '/');

    expect(extends_).toEqual([]);
  });

  test('REGRESSION: passive traffic on the session-data port extends nothing', async () => {
    await get(HUMAN, '/session', 8000);
    await get(HUMAN, '/event', 4096);

    expect(extends_).toEqual([]);
  });

  test('a non-2xx from the dev server is not an observation', async () => {
    respondWith(new Response('nope', { status: 404 }));

    await get(HUMAN, '/');

    expect(extends_).toEqual([]);
  });

  test('a page load worth of requests collapses into ONE deadline write', async () => {
    for (const asset of ['/', '/app.js', '/app.css', '/logo.svg', '/api/me']) {
      await get(HUMAN, asset);
    }

    expect(extends_).toHaveLength(1);
  });
});

describe('turn lifecycle authority is persisted before the prompt is relayed', () => {
  test('a live box is granted its turn and the prompt goes through', async () => {
    turnStartObservation = 'granted';

    const res = await prompt(HUMAN);

    expect(res.status).toBe(200);
    expect(begunTurns).toHaveLength(1);
    expect(begunTurns[0].target).toEqual({ externalId });
    expect(begunTurns[0].turn).toMatchObject({
      opencodeSessionId: 'sess-1',
      messageId: 'msg-turn-1',
    });
    expect(acceptedTurns).toHaveLength(1);
    expect(acceptedTurns[0].token).toBe(String(begunTurns[0].turn.token));
    expect(extends_).toEqual([]);
    expect(abandonedTurns).toEqual([]);
  });

  test('a missing lifecycle row refuses delivery and releases the retry claim', async () => {
    turnStartObservation = 'no_box';
    let fetched = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetched += 1;
      return new Response('ok', { status: 200 });
    };

    const refused = await prompt(HUMAN);
    expect(refused.status).toBe(503);
    expect((await refused.json()) as unknown).toMatchObject({
      code: 'sandbox_lifecycle_unavailable',
      retry: true,
    });
    expect(fetched).toBe(0);

    turnStartObservation = 'granted';
    expect((await prompt(HUMAN)).status).toBe(200);
  });

  test('a database failure refuses delivery before any upstream byte', async () => {
    turnBeginError = new Error('database unavailable');
    let fetched = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      fetched += 1;
      return new Response('ok', { status: 200 });
    };

    const refused = await prompt(HUMAN);

    expect(refused.status).toBe(503);
    expect((await refused.json()) as unknown).toMatchObject({
      code: 'sandbox_lifecycle_unavailable',
      retry: true,
    });
    expect(fetched).toBe(0);
  });

  test('the BOX cannot observe its own turn start', async () => {
    await prompt(BOX_ITSELF);

    expect(begunTurns).toEqual([]);
  });

  test('an ambiguous upstream 5xx preserves the turn because OpenCode may have accepted it', async () => {
    respondWith(new Response('upstream failed', { status: 502 }));

    const res = await prompt(HUMAN);

    expect(res.status).toBe(502);
    expect(acceptedTurns).toHaveLength(1);
    expect(abandonedTurns).toEqual([]);
    expect(extends_).toEqual([]);
  });

  test('a post-delivery database failure preserves the delivering record for reaper recovery', async () => {
    turnAcceptError = new Error('database unavailable after OpenCode accepted the prompt');

    const res = await prompt(HUMAN);

    expect(res.status).toBe(200);
    expect(acceptedTurns).toHaveLength(1);
    expect(abandonedTurns).toEqual([]);
  });

  test('a definitive upstream 4xx abandons the delivery record', async () => {
    respondWith(new Response('invalid prompt', { status: 400 }));

    const res = await prompt(HUMAN);

    expect(res.status).toBe(400);
    expect(acceptedTurns).toEqual([]);
    expect(abandonedTurns).toHaveLength(1);
  });

  test('a delivery cleanup failure preserves the definitive upstream response', async () => {
    turnAbandonError = new Error('database unavailable during cleanup');
    respondWith(new Response('invalid prompt', { status: 400 }));

    const response = await prompt(HUMAN);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('invalid prompt');
    expect(abandonedTurns).toHaveLength(1);
  });
});
