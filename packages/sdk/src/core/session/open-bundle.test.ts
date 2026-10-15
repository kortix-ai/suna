import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../http/config';
import type { SessionOpenBundleConfig, SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';

test('existing typed config consumers may omit the additive effort field', () => {
  const config: SessionOpenBundleConfig = {
    known: true,
    base_ref: null,
    agent_name: null,
    llm_gateway_enabled: true,
  };
  expect(config.default_reasoning_effort).toBeUndefined();
});
import {
  OPEN_BUNDLE_SHARE_MS,
  OPEN_BUNDLE_TRANSCRIPT_LIMIT,
  claimOpenBundle,
  heldSavedWindow,
  holdSavedWindow,
  openBundleAudit,
  openBundleHistory,
  openBundleQueue,
  openBundleTurn,
  openSessionBundle,
  resetSessionOpenBundles,
} from './open-bundle';

const PID = 'P1';
const SID = 'S1';

let requests: string[] = [];
let respond: (url: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: bundleBody(),
});

function bundleBody(overrides: Record<string, unknown> = {}) {
  return {
    observed_at: '2026-08-26T12:00:00.000Z',
    session: { session_id: SID },
    turn: { known: true, turns: [{ turn_token: 't1', state: 'active' }] },
    queue: { known: true, prompts: [{ prompt_id: 'p1' }], held: false },
    transcript: {
      known: true,
      requested: true,
      available: true,
      reason: null,
      source: 'mirror',
      complete: true,
      captured_at: '2026-08-26T11:59:00.000Z',
      opencode_session_id: 'ses_root',
      message_count: 2,
      messages: [{ info: { id: 'msg_1' }, parts: [] }],
    },
    config: { known: true, base_ref: 'main', agent_name: 'kortix', llm_gateway_enabled: true },
    models: { known: true, resolvedForCaller: 'anthropic/claude-sonnet-4-6' },
    audit: {
      known: true,
      session_id: SID,
      agent: 'kortix',
      audit_access: false,
      count: 0,
      actions: [{ execution_id: 'exec-1', status: 'pending_approval' }],
    },
    ...overrides,
  };
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200, body: bundleBody() });
  resetSessionOpenBundles();
  globalThis.fetch = mock(async (url: unknown) => {
    requests.push(String(url));
    const { status, body } = respond(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

describe('the session-open bundle coalescer', () => {
  test('one open issues ONE request however many consumers claim it', async () => {
    openSessionBundle(PID, SID);
    const claims = await Promise.all([
      claimOpenBundle(PID, SID),
      claimOpenBundle(PID, SID),
      claimOpenBundle(PID, SID),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/projects/P1/sessions/S1/snapshot');
    for (const claim of claims) expect(claim?.observed_at).toBe('2026-08-26T12:00:00.000Z');
  });

  test('a second open for the same session while one is in flight does not fan out', async () => {
    openSessionBundle(PID, SID);
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    expect(requests).toHaveLength(1);
  });

  test('a claim with no open in flight is null — a poll must never START a bundle', async () => {
    // The bundle is the OPEN path's read. If a 15s steady-state `/turn` poll
    // could start one, every session view would keep re-fetching the transcript
    // and the model catalogue forever.
    expect(claimOpenBundle(PID, SID)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test('a resolved bundle answers later claims inside the share window and not after', async () => {
    let now = 1_000;
    openSessionBundle(PID, SID, { now: () => now });
    await claimOpenBundle(PID, SID, now);
    now += OPEN_BUNDLE_SHARE_MS - 1;
    expect(claimOpenBundle(PID, SID, now)).not.toBeNull();
    now += 2;
    expect(claimOpenBundle(PID, SID, now)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('claims are scoped to their own session', async () => {
    openSessionBundle(PID, SID);
    expect(claimOpenBundle(PID, 'OTHER')).toBeNull();
    expect(claimOpenBundle('OTHER', SID)).toBeNull();
    await claimOpenBundle(PID, SID);
    expect(requests).toHaveLength(1);
  });

  test('a failed bundle resolves null instead of throwing, so consumers fall back', async () => {
    respond = () => ({ status: 500, body: { message: 'boom' } });
    openSessionBundle(PID, SID);
    expect(await claimOpenBundle(PID, SID)).toBeNull();
  });

  test('a failed bundle is not retried by the next claim inside the share window', async () => {
    respond = () => ({ status: 500, body: { message: 'boom' } });
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    expect(requests).toHaveLength(1);
  });

  test('re-opening the same session after the window starts a fresh read', async () => {
    let now = 1_000;
    openSessionBundle(PID, SID, { now: () => now });
    await claimOpenBundle(PID, SID, now);
    now += OPEN_BUNDLE_SHARE_MS + 1;
    openSessionBundle(PID, SID, { now: () => now });
    await claimOpenBundle(PID, SID, now);
    expect(requests).toHaveLength(2);
  });
});

describe('the saved-window hold — one slot per session, not one global slot', () => {
  const envelopeFor = (root: string) =>
    ({
      available: true,
      reason: null,
      source: 'mirror',
      complete: true,
      captured_at: '2026-09-26T10:00:00Z',
      opencode_session_id: root,
      message_count: 0,
      messages: [],
    }) as unknown as SessionTranscriptSyncEnvelope;

  test('a late hold for session B does not evict session A\'s hold', () => {
    holdSavedWindow(PID, 'A', envelopeFor('ses_a'));
    holdSavedWindow(PID, 'B', envelopeFor('ses_b'));
    expect(heldSavedWindow(PID, 'A')?.opencode_session_id).toBe('ses_a');
    expect(heldSavedWindow(PID, 'B')?.opencode_session_id).toBe('ses_b');
  });

  test('the bind asks the pointer only while its own hold lives, even after another session held', async () => {
    holdSavedWindow(PID, SID, envelopeFor('ses_root'));
    // Another session's connecting view settles late and holds its own window.
    holdSavedWindow(PID, 'LATE', envelopeFor('ses_late'));
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    expect(requests[0]).toContain('transcript=0');
  });

  test('the cap keeps the hold map bounded: the oldest hold gives its slot', () => {
    for (let i = 0; i < 16; i++) holdSavedWindow(PID, `s${i}`, envelopeFor(`ses_${i}`));
    expect(heldSavedWindow(PID, 's0')?.opencode_session_id).toBe('ses_0');
    holdSavedWindow(PID, 's16', envelopeFor('ses_16'));
    expect(heldSavedWindow(PID, 's0')).toBeNull();
    expect(heldSavedWindow(PID, 's16')?.opencode_session_id).toBe('ses_16');
    // The surviving holds keep their envelopes.
    expect(heldSavedWindow(PID, 's15')?.opencode_session_id).toBe('ses_15');
  });
});

describe('the bundle legs — every one is tri-state', () => {
  test('turn projects onto a stamped observation, clocked from observed_at', async () => {
    openSessionBundle(PID, SID);
    const bundle = await claimOpenBundle(PID, SID);
    const turn = openBundleTurn(bundle!);
    // The stamp is the SERVER's instant, never arrival: an answer is only as
    // fresh as the moment it was taken, and a bundle shared across the first
    // seconds of an open must not claim to be newer than it is.
    expect(turn).toEqual({
      turns: [{ turn_token: 't1', state: 'active' }] as never,
      last_ended: undefined,
      atMs: Date.parse('2026-08-26T12:00:00.000Z'),
    });
  });

  test('an unknown turn leg projects to null, never to idle', async () => {
    respond = () => ({
      status: 200,
      body: bundleBody({ turn: { known: false, reason: 'turn read exploded' } }),
    });
    openSessionBundle(PID, SID);
    const bundle = await claimOpenBundle(PID, SID);
    // null means "ask the endpoint" — `{ turns: [] }` would be an idle CLAIM
    // made by something that did not know.
    expect(openBundleTurn(bundle!)).toBeNull();
  });

  test('queue projects onto the prompt rows, and an unknown queue is null', async () => {
    openSessionBundle(PID, SID);
    const bundle = await claimOpenBundle(PID, SID);
    expect(openBundleQueue(bundle!)).toEqual([{ prompt_id: 'p1' }] as never);

    resetSessionOpenBundles();
    respond = () => ({
      status: 200,
      body: bundleBody({ queue: { known: false, reason: 'inbox read failed' } }),
    });
    openSessionBundle(PID, SID);
    const degraded = await claimOpenBundle(PID, SID);
    expect(openBundleQueue(degraded!)).toBeNull();
  });

  test('audit projects onto the pending-approvals shape GET .../audit answers, and an unknown leg is null', async () => {
    openSessionBundle(PID, SID);
    const bundle = await claimOpenBundle(PID, SID);
    // Byte-identical to what `getSessionAudit(..., { includeEvents: false })`
    // returns, minus `known` — a consumer can hand this straight to code that
    // reads `SessionAudit.actions`.
    expect(openBundleAudit(bundle!)).toEqual({
      session_id: SID,
      agent: 'kortix',
      audit_access: false,
      count: 0,
      actions: [{ execution_id: 'exec-1', status: 'pending_approval' }],
    } as never);

    resetSessionOpenBundles();
    respond = () => ({
      status: 200,
      body: bundleBody({ audit: { known: false, reason: 'leg_failed' } }),
    });
    openSessionBundle(PID, SID);
    const degraded = await claimOpenBundle(PID, SID);
    // null means "ask the endpoint" — never a fabricated empty actions list,
    // which would read as "nothing pending" for a leg that could not answer.
    expect(openBundleAudit(degraded!)).toBeNull();
  });
});

describe('the transcript leg', () => {
  test('an open asks for the first saved window; a pointer-only open asks for none', async () => {
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    expect(requests[0]).toContain(`transcript=${OPEN_BUNDLE_TRANSCRIPT_LIMIT}`);

    resetSessionOpenBundles();
    openSessionBundle(PID, SID, { transcript: 0 });
    await claimOpenBundle(PID, SID);
    expect(requests[1]).toContain('transcript=0');
  });

  test('the saved window is served by the history projection, for the row root only', async () => {
    respond = () => ({
      status: 200,
      body: bundleBody({ session: { session_id: SID, runtime_session_id: 'ses_root' } }),
    });
    openSessionBundle(PID, SID);
    const bundle = await claimOpenBundle(PID, SID);
    expect(openBundleHistory(bundle!)?.messages).toHaveLength(1);
    expect(openBundleHistory({ ...bundle!, session: { session_id: SID, runtime_session_id: 'ses_other' } } as never)).toBeNull();
  });
});
