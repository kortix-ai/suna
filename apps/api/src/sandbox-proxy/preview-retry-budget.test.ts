import { describe, expect, test } from 'bun:test';

import {
  PROXY_ATTEMPT_TIMEOUT_MS,
  isLongTurnCompletionRequest,
  proxyAttemptTimeoutMs,
} from './preview-retry-budget';

// `POST /session/:id/message` is OpenCode's synchronous, blocking turn
// endpoint: it doesn't emit response headers until the whole reasoning +
// tool-call turn is done. It must get the same "remaining budget, not the
// generic 15s connect cap" treatment as a multipart upload, or a perfectly
// healthy 20-40s turn gets aborted and its non-idempotent body gets resent.
describe('isLongTurnCompletionRequest', () => {
  test('POST /session/:id/message matches', () => {
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/message' })).toBe(
      true,
    );
    expect(isLongTurnCompletionRequest({ method: 'post', path: '/session/abc-123/message' })).toBe(
      true,
    );
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/message?x=1' }),
    ).toBe(true);
  });

  test('GET (fetch transcript) does not match, only the blocking POST does', () => {
    expect(isLongTurnCompletionRequest({ method: 'GET', path: '/session/abc123/message' })).toBe(
      false,
    );
  });

  test('the async sibling endpoint does not match — it already returns immediately', () => {
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/prompt_async' }),
    ).toBe(false);
  });

  test('an unrelated path with "/message" elsewhere does not match', () => {
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/not-session/abc123/message' }),
    ).toBe(false);
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/messages' })).toBe(
      false,
    );
  });
});

describe('proxyAttemptTimeoutMs', () => {
  test('an ordinary GET is capped at the generic 15s connect window', () => {
    expect(proxyAttemptTimeoutMs(40_000, { method: 'GET', path: '/session/abc123/status' })).toBe(
      PROXY_ATTEMPT_TIMEOUT_MS,
    );
  });

  test('with no request info at all, still caps at the generic window', () => {
    expect(proxyAttemptTimeoutMs(40_000)).toBe(PROXY_ATTEMPT_TIMEOUT_MS);
  });

  test('a blocking session-message POST gets ~the whole remaining budget, not the 15s cap', () => {
    expect(proxyAttemptTimeoutMs(40_000, { method: 'POST', path: '/session/abc123/message' })).toBe(
      39_500,
    );
  });

  test('an upload keeps its existing remaining-budget treatment (no regression)', () => {
    expect(proxyAttemptTimeoutMs(40_000, { method: 'POST', path: '/file/upload' })).toBe(39_500);
  });

  test('a blocking session-message POST never drops below the 1s floor', () => {
    expect(proxyAttemptTimeoutMs(200, { method: 'POST', path: '/session/abc123/message' })).toBe(
      1_000,
    );
  });

  test('a blocking session-message POST is still bounded by whatever budget remains', () => {
    // Near the end of the outer 50s budget, the exempted class must shrink
    // with it — it never gets MORE than the remaining wall-clock budget, only
    // the generic 15s floor is what it's exempt from.
    expect(proxyAttemptTimeoutMs(5_000, { method: 'POST', path: '/session/abc123/message' })).toBe(
      4_500,
    );
    expect(
      proxyAttemptTimeoutMs(5_000, { method: 'POST', path: '/session/abc123/message' }),
    ).toBeLessThan(PROXY_ATTEMPT_TIMEOUT_MS);
  });
});

// ── Regression: `/command` is a blocking turn too ──────────────────────────
//
// A `/` slash-command goes to `POST /session/:id/command`, NOT
// `/session/:id/message`. OpenCode holds that response open for the whole turn
// exactly like `/message` does, but the matcher only listed `/message` — so a
// command got the generic 15s connect cap, the abort looked like a stalled
// connection, and the retry loop re-POSTed the SAME non-idempotent command up
// to 4 times. Observed 2026-08-11 in session 9f6b0d87: one `/webapp` submit
// produced 4 identical user messages, 11.0s / 11.8s / 13.7s apart.
describe('isLongTurnCompletionRequest — slash commands', () => {
  test('POST /session/:id/command matches (it blocks for the whole turn)', () => {
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/command' })).toBe(
      true,
    );
    expect(isLongTurnCompletionRequest({ method: 'post', path: '/session/abc-123/command' })).toBe(
      true,
    );
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/command?x=1' }),
    ).toBe(true);
  });

  test('GET does not match, and neither does a lookalike path', () => {
    expect(isLongTurnCompletionRequest({ method: 'GET', path: '/session/abc123/command' })).toBe(
      false,
    );
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/commands' })).toBe(
      false,
    );
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/not-session/abc123/command' }),
    ).toBe(false);
  });

  test('a command POST gets ~the whole remaining budget, not the 15s cap', () => {
    expect(proxyAttemptTimeoutMs(40_000, { method: 'POST', path: '/session/abc123/command' })).toBe(
      39_500,
    );
  });
});

// ── Regression: `/summarize` (compaction) is a blocking turn too ───────────
//
// Same omission as `/command`, one endpoint over: OpenCode holds the response
// to `POST /session/:id/summarize` open until the ENTIRE summary turn is done —
// routinely 30s+ with a large model over a long transcript. Missing from this
// matcher it got the generic 15s cap here and the daemon's 10s cap inside the
// sandbox, so EVERY compaction died as
// `503 {"error":"upstream unreachable","details":"The operation was aborted."}`
// — and the retry loop then re-POSTed the non-idempotent summarize, stacking
// failed summary attempts in the transcript. Observed 2026-08-26 on /compact.
describe('isLongTurnCompletionRequest — summarize (compaction)', () => {
  test('POST /session/:id/summarize matches (it blocks for the whole summary turn)', () => {
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/summarize' })).toBe(
      true,
    );
    expect(
      isLongTurnCompletionRequest({ method: 'post', path: '/session/abc-123/summarize' }),
    ).toBe(true);
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/summarize?x=1' }),
    ).toBe(true);
  });

  test('GET does not match, and neither does a lookalike path', () => {
    expect(isLongTurnCompletionRequest({ method: 'GET', path: '/session/abc123/summarize' })).toBe(
      false,
    );
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/session/abc123/summarizes' }),
    ).toBe(false);
    expect(
      isLongTurnCompletionRequest({ method: 'POST', path: '/not-session/abc123/summarize' }),
    ).toBe(false);
  });

  test('a summarize POST gets ~the whole remaining budget, not the 15s cap', () => {
    expect(
      proxyAttemptTimeoutMs(40_000, { method: 'POST', path: '/session/abc123/summarize' }),
    ).toBe(39_500);
  });
});
