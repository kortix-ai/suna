import { beforeEach, describe, expect, test } from 'bun:test';

import {
  __resetPromptDedupe,
  claimPromptDelivery,
  isNonIdempotentSessionWrite,
  promptDeliveryKey,
  releasePromptDelivery,
  shouldClaimPromptDelivery,
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

// ── Which calls may never be re-POSTed ─────────────────────────────────────
describe('isNonIdempotentSessionWrite', () => {
  test('all three turn-creating endpoints match', () => {
    for (const path of [
      '/session/abc123/message',
      '/session/abc123/prompt_async',
      '/session/abc123/command',
    ]) {
      expect(isNonIdempotentSessionWrite(8000, 'POST', path)).toBe(true);
    }
  });

  test('/command matches — the omission that caused the 4x duplicate send', () => {
    // 2026-08-11, session 9f6b0d87: one `/webapp` submit, four identical user
    // messages. `/command` was absent from the guard's path list, so the proxy
    // treated a non-idempotent agent turn as a safe-to-retry request.
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/session/abc123/command')).toBe(true);
    expect(isNonIdempotentSessionWrite(8000, 'post', '/session/abc-123/command?x=1')).toBe(true);
  });

  test('reads are always safe to retry', () => {
    expect(isNonIdempotentSessionWrite(8000, 'GET', '/session/abc123/message')).toBe(false);
    expect(isNonIdempotentSessionWrite(8000, 'GET', '/session/abc123/command')).toBe(false);
  });

  test('only the agent runtime port counts', () => {
    expect(isNonIdempotentSessionWrite(3000, 'POST', '/session/abc123/command')).toBe(false);
  });

  test('lookalike paths do not match', () => {
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/session/abc123/commands')).toBe(false);
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/not-session/abc123/command')).toBe(false);
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/session/abc123/shell')).toBe(false);
  });

  test('a command body with no Idempotency-Key still gets a stable content key', () => {
    // The proxy's own retry is now blocked, but a CLIENT resend must still
    // collide. Commands send no Idempotency-Key, so the content hash is the
    // only thing standing between a double-submit and a double-execution.
    const body = new TextEncoder().encode('{"command":"webapp","arguments":"explain"}').buffer;
    const a = promptDeliveryKey({ idempotencyKey: null, sandboxId: 's', sessionId: 'x', body });
    const b = promptDeliveryKey({ idempotencyKey: null, sandboxId: 's', sessionId: 'x', body });
    expect(a).toBe(b);
    expect(a.startsWith('hash:')).toBe(true);
  });
});

// ── Claiming is a stronger guarantee than not-retrying ─────────────────────
describe('shouldClaimPromptDelivery', () => {
  test('prompts always claim — their bodies differ between submissions', () => {
    expect(shouldClaimPromptDelivery('/session/abc/message', false)).toBe(true);
    expect(shouldClaimPromptDelivery('/session/abc/prompt_async', false)).toBe(true);
  });

  test('a command with no Idempotency-Key does NOT claim', () => {
    // `{command:"webapp",arguments:"build a site"}` is byte-identical between
    // two deliberate runs. Claiming on that hash answers the second with
    // `200 {"deduplicated":true}` and never runs it — silent loss, in exactly
    // the case where the user is re-sending something that looked like it
    // failed.
    expect(shouldClaimPromptDelivery('/session/abc/command', false)).toBe(false);
    expect(shouldClaimPromptDelivery('/session/abc/command?x=1', false)).toBe(false);
  });

  test('a command WITH an Idempotency-Key claims — the CLI mints one per prompt', () => {
    expect(shouldClaimPromptDelivery('/session/abc/command', true)).toBe(true);
  });

  test('a lookalike path is treated as a prompt, not a command', () => {
    expect(shouldClaimPromptDelivery('/session/abc/commands', false)).toBe(true);
  });
});
