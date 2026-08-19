import { describe, expect, test } from 'bun:test';

import { errorMessageOf, isDeliveredButDisconnected } from './delivered-but-disconnected';

describe('isDeliveredButDisconnected — the turn is running, the wait expired', () => {
  test('the sandbox daemon severing its header wait', () => {
    // `kortix-sandbox-agent-server/src/proxy.ts` — the exact body users saw as
    // a chat banner while the turn ran to completion behind it.
    expect(
      isDeliveredButDisconnected('upstream unreachable: The operation was aborted.'),
    ).toBe(true);
  });

  test("apps/api's long-turn timeout", () => {
    expect(isDeliveredButDisconnected('LONG_TURN_PROXY_TIMEOUT')).toBe(true);
    expect(
      isDeliveredButDisconnected('Turn is still running and outran this connection’s budget.'),
    ).toBe(true);
  });

  test("apps/api's ambiguous prompt-delivery giveup", () => {
    // The proxy sets `promptDeliveryMaybeAccepted` — it believes the box has
    // the message — and then answers with this. Treating it as a failure is
    // what produced a retry that aborted a live turn.
    expect(isDeliveredButDisconnected('sandbox upstream unreachable')).toBe(true);
  });
});

describe('isDeliveredButDisconnected — nothing was delivered, keep failing', () => {
  test('opencode refused before forwarding', () => {
    expect(isDeliveredButDisconnected('opencode not ready')).toBe(false);
    expect(isDeliveredButDisconnected('sandbox runtime not ready')).toBe(false);
  });

  test('a refusal that also mentions unreachable still counts as refused', () => {
    // Order matters: the refusal list wins, or a 503 that happens to carry both
    // phrases would be silently swallowed and the message genuinely lost.
    expect(
      isDeliveredButDisconnected('opencode not ready — upstream unreachable'),
    ).toBe(false);
  });

  test('auth, billing and dedupe are not delivery timeouts', () => {
    expect(isDeliveredButDisconnected('sandbox proxy authentication rejected')).toBe(false);
    expect(isDeliveredButDisconnected('Payment Required: Insufficient credits')).toBe(false);
    expect(isDeliveredButDisconnected('connection refused')).toBe(false);
  });

  test('an unrecognised error is a failure, not an optimistic pass', () => {
    expect(isDeliveredButDisconnected('something exploded')).toBe(false);
    expect(isDeliveredButDisconnected('')).toBe(false);
    expect(isDeliveredButDisconnected(null)).toBe(false);
    expect(isDeliveredButDisconnected(undefined)).toBe(false);
  });

  test('a dead PREVIEW PORT is not a prompt delivery', () => {
    // `portUnreachableResponse(..., reason: 'sandbox port unreachable')` in
    // `apps/api/src/sandbox-proxy/routes/preview.ts:1370` is guarded by
    // `!promptDelivery && isBrowserNavigation(incomingHeaders)` — it answers a
    // BROWSER NAVIGATION to a dead preview port, and never a prompt POST.
    // Nothing about it says the agent received anything, so a mutation that
    // somehow saw it must still surface its failure toast.
    expect(isDeliveredButDisconnected('sandbox port unreachable')).toBe(false);
    expect(
      isDeliveredButDisconnected(
        errorMessageOf({ error: 'sandbox port unreachable', port: 3000, status: 502 }),
      ),
    ).toBe(false);
  });

  test('the port case does not drag the ambiguous DELIVERY case down with it', () => {
    // The two reasons differ by one word and only one of them means "the box
    // may already have the message": `sandbox upstream unreachable` is the
    // giveup at `preview.ts:1546`, reached with `promptDeliveryMaybeAccepted`
    // still true. Pin both directions so a future edit cannot collapse them.
    expect(isDeliveredButDisconnected('sandbox upstream unreachable')).toBe(true);
    expect(isDeliveredButDisconnected('sandbox port unreachable')).toBe(false);
  });

  test('a sandbox that is not ready yet never delivered anything', () => {
    // The other `portUnreachableResponse` reason a mutation can actually see
    // (`preview.ts:969`), for a row that is not `active`.
    const notReady = 'sandbox not ready (status: stopped)';

    expect(isDeliveredButDisconnected(notReady)).toBe(false);
    // …and that `false` is the classifier DISCRIMINATING, not the classifier
    // being blind to this envelope. The same string with the one phrase that
    // does mean "already on the wire" swapped in flips to true, so the
    // assertion above can no longer pass merely by falling through — which is
    // what it did when it was the only line in this test.
    expect(isDeliveredButDisconnected(notReady.replace('not ready', 'upstream unreachable'))).toBe(
      true,
    );
    // The default direction is the safe one, and it is deliberate: an
    // unrecognised failure is NOT delivered. Guessing "delivered" for anything
    // unknown swallows the user's message with no toast and no turn.
    expect(isDeliveredButDisconnected('sandbox exploded in a brand new way')).toBe(false);
  });
});

describe('errorMessageOf', () => {
  test('reads an Error, a string, and a proxy JSON body', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf('boom')).toBe('boom');
    expect(errorMessageOf({ error: 'upstream unreachable' })).toBe('upstream unreachable');
    expect(errorMessageOf({ details: 'The operation was aborted.' })).toBe(
      'The operation was aborted.',
    );
  });

  test('never throws on an odd shape', () => {
    expect(errorMessageOf(null)).toBe('');
    expect(errorMessageOf(undefined)).toBe('');
    expect(errorMessageOf(42)).toBe('42');
  });
});

describe('the captured 502 is classified as delivered, not failed', () => {
  // The literal body captured from a live reproduction run:
  //   POST /v1/p/sbx_.../8000/session/ses_.../command
  //   http=502  t=10.229554s   (= the sandbox daemon's header bound)
  // The turn it belonged to completed normally ~6s later.
  const CAPTURED = JSON.parse(
    '{"error":"upstream unreachable","details":"The operation was aborted."}',
  );

  test('from the raw proxy JSON body', () => {
    expect(isDeliveredButDisconnected(errorMessageOf(CAPTURED))).toBe(true);
  });

  test('from the flattened Error that unwrap() produces', () => {
    expect(isDeliveredButDisconnected(new Error(CAPTURED.error).message)).toBe(true);
  });
});
