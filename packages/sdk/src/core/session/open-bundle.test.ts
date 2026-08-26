import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix } from '../http/config';
import {
  OPEN_BUNDLE_SHARE_MS,
  OPEN_BUNDLE_TRANSCRIPT_TTL_MS,
  claimOpenBundle,
  openBundleQueue,
  openBundleTurn,
  openSessionBundle,
  resetSessionOpenBundles,
  takeOpenBundleTranscript,
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
    expect(requests[0]).toContain('/projects/P1/sessions/S1/open-bundle');
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
});

describe('the transcript stash', () => {
  test('is consumed ONCE — a second reader must go to the runtime', async () => {
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    const first = takeOpenBundleTranscript(PID, SID);
    expect(first?.source).toBe('mirror');
    expect(first?.messages).toHaveLength(1);
    expect(takeOpenBundleTranscript(PID, SID)).toBeNull();
  });

  test('outlives the claim window, because the mirror paints after the box wakes', async () => {
    let now = 1_000;
    openSessionBundle(PID, SID, { now: () => now });
    await claimOpenBundle(PID, SID, now);
    // The transcript hydrate runs once the OpenCode root is known, which on a
    // cold box is 18.9-24.5s after the open. A 5s share window would throw the
    // mirror away exactly when it is needed.
    now += OPEN_BUNDLE_SHARE_MS + 1;
    expect(takeOpenBundleTranscript(PID, SID, now)).not.toBeNull();
  });

  test('expires with the transcript TTL', async () => {
    let now = 1_000;
    openSessionBundle(PID, SID, { now: () => now });
    await claimOpenBundle(PID, SID, now);
    now += OPEN_BUNDLE_TRANSCRIPT_TTL_MS + 1;
    expect(takeOpenBundleTranscript(PID, SID, now)).toBeNull();
  });

  test('a pointer-only bundle stashes nothing', async () => {
    respond = () => ({
      status: 200,
      body: bundleBody({ transcript: { known: true, requested: false } }),
    });
    openSessionBundle(PID, SID, { transcript: 0 });
    await claimOpenBundle(PID, SID);
    expect(requests[0]).toContain('transcript=0');
    expect(takeOpenBundleTranscript(PID, SID)).toBeNull();
  });

  test('an unavailable mirror stashes nothing — an empty thread is not an answer', async () => {
    respond = () => ({
      status: 200,
      body: bundleBody({
        transcript: {
          known: true,
          requested: true,
          available: false,
          reason: 'no server-side transcript has been captured for this session yet',
          source: 'none',
          complete: false,
          captured_at: null,
          opencode_session_id: null,
          message_count: 0,
          messages: [],
        },
      }),
    });
    openSessionBundle(PID, SID);
    await claimOpenBundle(PID, SID);
    expect(takeOpenBundleTranscript(PID, SID)).toBeNull();
  });
});
