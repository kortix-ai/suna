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
