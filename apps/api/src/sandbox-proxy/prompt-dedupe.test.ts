import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetPromptDedupe,
  claimPromptDelivery,
  promptDeliveryKey,
  releasePromptDelivery,
} from './prompt-dedupe';

beforeEach(() => __resetPromptDedupe());

describe('promptDeliveryKey', () => {
  test('prefers a trimmed Idempotency-Key over the content hash', () => {
    const key = promptDeliveryKey({
      idempotencyKey: '  abc-123  ',
      sandboxId: 'sb',
      sessionId: 'se',
      body: undefined,
    });
    expect(key).toBe('idem:abc-123');
  });

  test('falls back to a stable content hash when no key is supplied', () => {
    const body = new TextEncoder().encode('{"parts":[{"type":"text","text":"hi"}]}').buffer;
    const a = promptDeliveryKey({ idempotencyKey: null, sandboxId: 'sb', sessionId: 'se', body });
    const b = promptDeliveryKey({ idempotencyKey: '', sandboxId: 'sb', sessionId: 'se', body });
    expect(a).toBe(b);
    expect(a.startsWith('hash:')).toBe(true);
    // Different session ⇒ different key (no cross-session collisions).
    const c = promptDeliveryKey({ idempotencyKey: null, sandboxId: 'sb', sessionId: 'other', body });
    expect(c).not.toBe(a);
  });
});

describe('claimPromptDelivery', () => {
  test('first claim wins, an immediate repeat is deduped', () => {
    expect(claimPromptDelivery('k1', 1_000)).toBe(true);
    expect(claimPromptDelivery('k1', 1_000)).toBe(false);
    expect(claimPromptDelivery('k2', 1_000)).toBe(true);
  });

  test('a key is claimable again once its TTL has elapsed', () => {
    expect(claimPromptDelivery('k1', 0)).toBe(true);
    expect(claimPromptDelivery('k1', 59_999)).toBe(false); // still within TTL
    expect(claimPromptDelivery('k1', 60_001)).toBe(true); // TTL expired → reclaimable
  });

  test('the cache is bounded — it never grows past the max entry count', () => {
    // Far more than MAX_ENTRIES (2_000) distinct keys, all non-expiring.
    for (let i = 0; i < 5_000; i++) {
      expect(claimPromptDelivery(`bulk-${i}`, 1_000)).toBe(true);
    }
    // The most-recent key is still remembered (deduped)…
    expect(claimPromptDelivery('bulk-4999', 1_000)).toBe(false);
    // …but the oldest were evicted, so they read as fresh again.
    expect(claimPromptDelivery('bulk-0', 1_000)).toBe(true);
  });
});

describe('releasePromptDelivery', () => {
  test('a released claim is immediately reclaimable (retry can re-deliver)', () => {
    // Delivery is claimed, then PROVES undelivered → released. The client's retry
    // with the same key must be able to deliver, not short-circuit as a duplicate.
    expect(claimPromptDelivery('k1', 1_000)).toBe(true);
    expect(claimPromptDelivery('k1', 1_000)).toBe(false); // held → would drop the retry
    releasePromptDelivery('k1');
    expect(claimPromptDelivery('k1', 1_000)).toBe(true); // reclaimable → retry delivers
  });

  test('releasing only clears the named key, not other in-flight claims', () => {
    expect(claimPromptDelivery('k1', 1_000)).toBe(true);
    expect(claimPromptDelivery('k2', 1_000)).toBe(true);
    releasePromptDelivery('k1');
    // k2's claim survives — an unrelated delivery is not disturbed.
    expect(claimPromptDelivery('k2', 1_000)).toBe(false);
    expect(claimPromptDelivery('k1', 1_000)).toBe(true);
  });

  test('releasing an unknown or already-evicted key is a harmless no-op', () => {
    expect(() => releasePromptDelivery('never-claimed')).not.toThrow();
    expect(claimPromptDelivery('never-claimed', 1_000)).toBe(true);
  });
});
