// The PURE half of the bounded-lifetime rule: which observations count, how much
// life each is worth, and which sandbox-reported signals may shorten a box.
//
// Every case below is a bug that shipped in the first cut of this design and was
// caught by review, so each one names the failure it prevents rather than the
// branch it covers.
//
// `mock.module` is process-global in bun — run this file on its own.
import { afterEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';

mock.module('../config', () => ({ config: { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 } }));

const {
  ABSOLUTE_RUN_CAP_MS,
  createExtendThrottle,
  idleGraceMs,
  isPreviewUseObservation,
  isSandboxAuthored,
  isSessionAgentLoopMutationRequest,
  isTerminalTurnEnd,
  isTurnStartRequest,
  isWarmPoolBox,
  llmActivityGrantMs,
  previewGrantMs,
  turnGrantMs,
  warmPoolGrantMs,
} = await import('./sandbox-deadline-policy');

const KNOBS = [
  'KORTIX_SANDBOX_TURN_GRANT_MINUTES',
  'KORTIX_SANDBOX_LLM_ACTIVITY_GRANT_MINUTES',
  'KORTIX_SANDBOX_PREVIEW_GRANT_MINUTES',
  'KORTIX_SANDBOX_WARM_GRANT_MINUTES',
];
afterEach(() => {
  for (const knob of KNOBS) delete process.env[knob];
});

describe('the grants', () => {
  test('a turn start is worth 4h — above the p99 turn, 66x below the 264h worst case', () => {
    expect(turnGrantMs()).toBe(4 * 3_600_000);
  });

  // The measured p99.9 gap between consecutive usage_events inside one session is
  // OVER AN HOUR, because a long local tool run (build, test suite, migration)
  // emits none at all. A grant near that gap would kill a box in the middle of
  // exactly the work it exists to do.
  test('an LLM call is worth 4h — comfortably past the ~1h p99.9 usage_event gap', () => {
    expect(llmActivityGrantMs()).toBe(4 * 3_600_000);
    expect(llmActivityGrantMs()).toBeGreaterThan(4 * 3_600_000 * 0.9);
    expect(llmActivityGrantMs()).toBeGreaterThan(3 * 3_600_000);
  });

  // Shorter than a turn on purpose: a forgotten open tab that polls is the one
  // plausible abuse, and 30 minutes bounds what it can cost.
  test('human preview traffic is worth 30 minutes, shorter than a turn', () => {
    expect(previewGrantMs()).toBe(30 * 60_000);
    expect(previewGrantMs()).toBeLessThan(turnGrantMs());
  });

  // An unclaimed warm box can NEVER be observed again — no turns, no LLM calls,
  // no human traffic — so a floor is its whole lifetime. It must outlive the
  // 20-minute boot floor or the warm pool is reaped before it can be handed out.
  test('an unclaimed warm box gets a bounded hour, well past the 20-minute boot floor', () => {
    expect(warmPoolGrantMs()).toBe(60 * 60_000);
    expect(warmPoolGrantMs()).toBeGreaterThan(20 * 60_000);
    // Bounded, not exempt: the unbounded exemption it replaces let warm boxes
    // hold for hours as pure billed dead time.
    expect(warmPoolGrantMs()).toBeLessThan(ABSOLUTE_RUN_CAP_MS);
  });

  test('the idle tail reuses KORTIX_SANDBOX_AUTOSTOP_MINUTES, already 15 in prod', () => {
    expect(idleGraceMs()).toBe(15 * 60_000);
  });

  test('every grant is independently tunable without a code change', () => {
    process.env.KORTIX_SANDBOX_TURN_GRANT_MINUTES = '60';
    process.env.KORTIX_SANDBOX_LLM_ACTIVITY_GRANT_MINUTES = '90';
    process.env.KORTIX_SANDBOX_PREVIEW_GRANT_MINUTES = '10';
    process.env.KORTIX_SANDBOX_WARM_GRANT_MINUTES = '5';

    expect(turnGrantMs()).toBe(60 * 60_000);
    expect(llmActivityGrantMs()).toBe(90 * 60_000);
    expect(previewGrantMs()).toBe(10 * 60_000);
    expect(warmPoolGrantMs()).toBe(5 * 60_000);
  });

  test('every grant stays inside the absolute cap at its default', () => {
    for (const grant of [
      turnGrantMs(),
      llmActivityGrantMs(),
      previewGrantMs(),
      warmPoolGrantMs(),
    ]) {
      expect(grant).toBeLessThanOrEqual(ABSOLUTE_RUN_CAP_MS);
    }
  });
});

// ═══ THE USER-VISIBLE REGRESSION THIS CLOSES ═══
// A user clicking through the app their agent just built generates continuous
// authenticated proxy traffic that the control plane watches end to end. Without
// this classifier none of it extended anything, so the dev server died 15
// minutes after the last AGENT turn while the human was still using it — worse
// than the zombie boxes the deadline model exists to kill.
describe('isPreviewUseObservation — a human using the preview keeps the box', () => {
  const DEV_SERVER = 3000;
  const AGENT = 8000;
  const OPENCODE = 4096;

  test('an authenticated human on a dev-server port EXTENDS the box', () => {
    expect(
      isPreviewUseObservation({
        isPrincipal: true,
        sandboxAuthored: false,
        upstreamPort: DEV_SERVER,
      }),
    ).toBe(true);
  });

  test('every app port counts, not a hard-coded list of them', () => {
    for (const port of [3000, 5173, 8080, 1, 65535]) {
      expect(
        isPreviewUseObservation({ isPrincipal: true, sandboxAuthored: false, upstreamPort: port }),
      ).toBe(true);
    }
  });

  // The box holds two credentials that authenticate perfectly well (its sandbox
  // token and a session-scoped PAT). Letting its own traffic through rebuilds the
  // self-renewing lease this whole design deletes.
  test('the BOX fetching its own preview does NOT extend it', () => {
    expect(
      isPreviewUseObservation({
        isPrincipal: true,
        sandboxAuthored: true,
        upstreamPort: DEV_SERVER,
      }),
    ).toBe(false);
  });

  // 8000/4096 carry the conversation, and their passive traffic — an open tab
  // streaming events, repeated /start polls, background stream reconnects — is
  // what once kept idle boxes alive for days (1,597 phantom-active compute rows,
  // verified live 2026-06-21). A real turn on those ports still extends the box,
  // but only through isTurnStartRequest.
  test('REGRESSION: passive traffic on the session-data ports does NOT extend', () => {
    for (const port of [AGENT, OPENCODE]) {
      expect(
        isPreviewUseObservation({ isPrincipal: true, sandboxAuthored: false, upstreamPort: port }),
      ).toBe(false);
    }
  });

  test('a public share link is not a human credential we can attribute', () => {
    expect(
      isPreviewUseObservation({
        isPrincipal: false,
        sandboxAuthored: false,
        upstreamPort: DEV_SERVER,
      }),
    ).toBe(false);
  });
});

// ═══ THE MID-TURN KILL THIS CLOSES ═══
// `session.error` fires while opencode is RETRYING too — a 429 backoff, a
// transient upstream 5xx. Treating that as a turn end pulled the deadline in to
// 15 minutes WHILE THE TURN WAS STILL RUNNING, so any backoff longer than 15
// minutes killed the box mid-work. It is the one state the deleted execution
// lease got right: it renewed on 'busy' OR 'retry'.
describe('isTerminalTurnEnd — a retry is not a turn end', () => {
  test('idle is terminal', () => {
    expect(isTerminalTurnEnd('idle')).toBe(true);
    expect(isTerminalTurnEnd('idle', { isRetryable: true })).toBe(true);
  });

  test('REGRESSION: a RETRYABLE error is not terminal — the turn is still running', () => {
    expect(isTerminalTurnEnd('error', { isRetryable: true })).toBe(false);
  });

  test('a rate-limit backoff longer than the idle tail does not shorten the box', () => {
    // opencode marks a 429 retryable; the backoff can exceed 15 minutes.
    expect(isTerminalTurnEnd('error', { isRetryable: true })).toBe(false);
  });

  test('a permanent error IS terminal', () => {
    expect(isTerminalTurnEnd('error', { isRetryable: false })).toBe(true);
  });

  // Defaulting the unknown case to "still running" would restore the unbounded
  // reprieve this change deletes, so an error with no retry flag is an error.
  test('an error carrying no retry flag is terminal, never assumed alive', () => {
    expect(isTerminalTurnEnd('error')).toBe(true);
    expect(isTerminalTurnEnd('error', null)).toBe(true);
    expect(isTerminalTurnEnd('error', {})).toBe(true);
  });
});

describe('isWarmPoolBox — the marker the warm coordinator leaves on the row', () => {
  test('an available warm box is recognised from the sandbox row itself, with no join', () => {
    expect(isWarmPoolBox({ warm_session: { state: 'available', sandbox_slug: 'default' } })).toBe(
      true,
    );
  });

  test('a claimed or discarded marker is not a warm-pool box', () => {
    expect(isWarmPoolBox({ warm_session: { state: 'claimed' } })).toBe(false);
    expect(isWarmPoolBox({ warm_session: { state: 'discarded' } })).toBe(false);
  });

  test('an ordinary box, a null row and a malformed marker are all not warm', () => {
    expect(isWarmPoolBox(null)).toBe(false);
    expect(isWarmPoolBox(undefined)).toBe(false);
    expect(isWarmPoolBox({})).toBe(false);
    expect(isWarmPoolBox({ warm_session: 'available' })).toBe(false);
    expect(isWarmPoolBox({ warm_session: ['available'] })).toBe(false);
  });
});

describe('createExtendThrottle — one write per window, not one per request', () => {
  test('the first observation writes; the rest of the window does not', () => {
    const t = createExtendThrottle(60_000);

    expect(t.take('sb-1', 1_000)).toBe(true);
    expect(t.take('sb-1', 2_000)).toBe(false);
    expect(t.take('sb-1', 60_999)).toBe(false);
    expect(t.take('sb-1', 61_000)).toBe(true);
  });

  test('windows are per box, so one busy sandbox cannot starve another', () => {
    const t = createExtendThrottle(60_000);

    expect(t.take('sb-1', 1_000)).toBe(true);
    expect(t.take('sb-2', 1_000)).toBe(true);
  });

  // A long-lived pod otherwise accumulates one map entry per sandbox forever.
  test('expired reservations are swept, so the map cannot grow without bound', () => {
    const t = createExtendThrottle(1);
    for (let i = 0; i < 6_000; i += 1) t.take(`sb-${i}`, 1_000);

    // Every entry above expired at 1_001; one more write past that sweeps them.
    expect(t.take('sb-final', 10_000)).toBe(true);
    expect(t.take('sb-0', 10_000)).toBe(true);
  });
});

// The two most security-relevant classifiers in the file, which it advertises as
// exhaustively tested and previously did not touch at all: both survived mutation.
describe('isSandboxAuthored — provenance is decided by the CREDENTIAL', () => {
  test('an unauthenticated-shaped caller with no credential is not the box', () => {
    expect(isSandboxAuthored(undefined, undefined)).toBe(false);
    expect(isSandboxAuthored(null, null)).toBe(false);
  });

  test('the sandbox API-key type is the box', () => {
    expect(isSandboxAuthored('sandbox', null)).toBe(true);
  });

  // ═══ THE SECOND CREDENTIAL ═══ every box also carries a session-scoped
  // kortix_pat_ (`KORTIX_CLI_TOKEN`). Its auth branch never
  // sets apiKeyType, so a gate keyed on TYPE ALONE failed open on the path-based
  // proxy edge — the one the in-box CLI actually uses.
  test('a SESSION-SCOPED credential is the box even though apiKeyType is unset', () => {
    expect(isSandboxAuthored(undefined, 'sess-1')).toBe(true);
  });

  // The corollary, and the reason every CALL SITE must resolve the session id
  // through `callerKortixSessionId`: this function cannot tell a Kortix session
  // binding from a Supabase auth session, so it treats any non-null value as the
  // box. Passing a browser's auth session here reads every human as a sandbox.
  test('it cannot distinguish which KIND of session id it was handed', () => {
    expect(isSandboxAuthored('user', 'any-non-null-session-id')).toBe(true);
  });
});

describe('isTurnStartRequest', () => {
  test('legacy and pinned OpenCode POST routes start a turn', () => {
    expect(isTurnStartRequest(8000, 'POST', '/session/abc/prompt_async')).toBe(true);
    expect(isTurnStartRequest(4096, 'POST', '/session/abc/message')).toBe(true);
    expect(isTurnStartRequest(8000, 'POST', '/session/abc/command')).toBe(true);
    expect(isTurnStartRequest(8000, 'POST', '/session/abc/summarize')).toBe(true);
    expect(isTurnStartRequest(8000, 'POST', '/api/session/abc/prompt')).toBe(true);
    expect(isTurnStartRequest(4096, 'POST', '/api/session/abc/compact')).toBe(true);
  });

  // Passive polling must never extend a box — that is the deleted lease, rebuilt.
  test('a GET never starts a turn, on any port or path', () => {
    expect(isTurnStartRequest(8000, 'GET', '/session/abc/prompt_async')).toBe(false);
    expect(isTurnStartRequest(4096, 'GET', '/session/abc/message')).toBe(false);
  });

  test('a dev-server port is never a turn start, whatever the path looks like', () => {
    expect(isTurnStartRequest(3000, 'POST', '/session/abc/prompt_async')).toBe(false);
  });

  test('the in-box dynamic-port nesting prefix is stripped before matching', () => {
    expect(isTurnStartRequest(8000, 'POST', '/proxy/4096/session/abc/prompt_async')).toBe(true);
  });

  test('a neighbouring session path is not a turn start', () => {
    expect(isTurnStartRequest(8000, 'POST', '/session/abc')).toBe(false);
    expect(isTurnStartRequest(8000, 'POST', '/session/abc/prompt_asyncx')).toBe(false);
    expect(isTurnStartRequest(8000, 'POST', '/health')).toBe(false);
  });
});

describe('isSessionAgentLoopMutationRequest', () => {
  test('matches known and unknown mutating routes on both OpenCode surfaces', () => {
    expect(isSessionAgentLoopMutationRequest(8000, 'POST', '/session/abc/prompt_async')).toBe(true);
    expect(isSessionAgentLoopMutationRequest(4096, 'POST', '/api/session/abc/prompt')).toBe(true);
    expect(
      isSessionAgentLoopMutationRequest(8000, 'DELETE', '/api/session/abc/future-route'),
    ).toBe(true);
    expect(isSessionAgentLoopMutationRequest(8000, 'POST', '/api/session')).toBe(true);
    expect(isSessionAgentLoopMutationRequest(4096, 'DELETE', '/session/abc')).toBe(true);
  });

  test('does not match reads, non-session paths, or non-agent ports', () => {
    expect(isSessionAgentLoopMutationRequest(8000, 'GET', '/api/session/abc/prompt')).toBe(false);
    expect(isSessionAgentLoopMutationRequest(8000, 'POST', '/api/global/event')).toBe(false);
    expect(isSessionAgentLoopMutationRequest(3000, 'POST', '/api/session/abc/prompt')).toBe(false);
  });
});
