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
    expect(key).toBe('idem:sb\0se\0abc-123');
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

  // ── T13: the durable identity is the wire messageID, not the bytes ─
  describe('wire messageID precedence (T13)', () => {
    const bodyWithId = (messageID: string, text = 'hi') =>
      new TextEncoder().encode(
        JSON.stringify({ sessionID: 'se', parts: [{ type: 'text', text }], messageID }),
      ).buffer;

    test('a prompt body carrying a wire messageID keys on the id, not the hash', () => {
      const key = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      expect(key).toBe('msgid:sb\0se\0msg_0123456789ab00000000000000');
      expect(key.startsWith('hash:')).toBe(false);
    });

    test('same messageID, evolved body text → SAME key (a retry stays one delivery)', () => {
      // The exact bug this exists to fix: a retry after a wake can carry a
      // slightly different body (e.g. re-serialized), but the SDK always
      // resends the SAME messageID for a retry of one submission
      // (submissionWireId in messages.ts). Keying on the id, not the bytes,
      // means the retry is still recognized as the same delivery.
      const a = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000', 'hi'),
      });
      const b = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000', 'hi there'),
      });
      expect(a).toBe(b);
    });

    test('different messageID, IDENTICAL body text → DIFFERENT key (never swallowed)', () => {
      // The swallow trap this exists to fix: a user sending "continue" twice on
      // purpose must reach opencode twice, not get answered
      // `200 {"deduplicated":true}` on the second send just because the text
      // matches the first.
      const a = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000001', 'continue'),
      });
      const b = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000002', 'continue'),
      });
      expect(a).not.toBe(b);
    });

    test('scoped by sandbox — a rotated sandbox never inherits a claim from the old one', () => {
      const a = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb-old',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      const b = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb-new',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      expect(a).not.toBe(b);
    });

    test('scoped by session — the same messageID in a different session never collides', () => {
      const a = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se-1',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      const b = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'sb',
        sessionId: 'se-2',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      expect(a).not.toBe(b);
    });

    test('an explicit Idempotency-Key still wins over a wire messageID in the same body', () => {
      const key = promptDeliveryKey({
        idempotencyKey: 'cli-key-1',
        sandboxId: 'sb',
        sessionId: 'se',
        body: bodyWithId('msg_0123456789ab00000000000000'),
      });
      expect(key).toBe('idem:sb\0se\0cli-key-1');
    });

    test('a command body (no messageID field) still falls back to the content hash', () => {
      const body = new TextEncoder().encode('{"command":"webapp","arguments":"explain"}').buffer;
      const key = promptDeliveryKey({ idempotencyKey: null, sandboxId: 'sb', sessionId: 'se', body });
      expect(key.startsWith('hash:')).toBe(true);
    });

    // T13 — the no-blind-repost guarantee for the API's OWN
    // `continue_session` delivery (session-lifecycle/engine.ts `postPrompt`,
    // called through the SAME `forwardToSandbox` → prompt-dedupe path a
    // browser/CLI send goes through). `postPrompt` sends no messageID field —
    // its body is exactly `{"parts":[{"type":"text","text":…}]}` — so a
    // retried delivery of the SAME queued command (identical sessionId + text)
    // falls to the content-hash key, and MUST collide with the first attempt's
    // claim so the drain loop's re-post is recognized as the same delivery
    // instead of re-enqueuing it. See the comment on `executeQueuedContinue`
    // in engine.ts for the full mechanism this pins.
    test('a retried continue_session delivery — postPrompt\'s exact body shape — collides on the same dedupe key', () => {
      const postPromptBody = (text: string) =>
        new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text }] })).buffer;
      const firstAttempt = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'ext-1',
        sessionId: 'sess-1',
        body: postPromptBody('please continue'),
      });
      const retryAfterWake = promptDeliveryKey({
        idempotencyKey: null,
        sandboxId: 'ext-1',
        sessionId: 'sess-1',
        body: postPromptBody('please continue'),
      });
      expect(firstAttempt).toBe(retryAfterWake);
      expect(firstAttempt.startsWith('hash:')).toBe(true);
      // And the claim itself: the SAME two calls that `forwardToSandbox` makes
      // — claim on the first attempt, re-claim on the retry — must observe the
      // second as already-held, at a gap that spans the old 60s TTL but stays
      // inside the new 10-minute one (the realistic worst case: a ~45s
      // deliverWithRetry deadline plus a delayed drain tick).
      expect(claimPromptDelivery(firstAttempt, 0)).toBe(true);
      expect(claimPromptDelivery(retryAfterWake, 90_000)).toBe(false);
    });

    // F2 — `postPrompt` (session-lifecycle/engine.ts) now sends
    // `Idempotency-Key: <row.commandId>` on every continue_session delivery.
    // These pin the two halves of that guarantee directly against the real
    // dedupe cache, one layer below the engine.ts-level proof in
    // `postprompt-idempotency-key.test.ts`.
    describe('F2 — Idempotency-Key outranks the content hash for postPrompt deliveries', () => {
      const postPromptBody = (text: string) =>
        new TextEncoder().encode(JSON.stringify({ parts: [{ type: 'text', text }] })).buffer;

      test('same commandId retried → deduped (second claim is short-circuited)', () => {
        const key = promptDeliveryKey({
          idempotencyKey: 'cmd-1',
          sandboxId: 'ext-1',
          sessionId: 'sess-1',
          body: postPromptBody('please approve and continue'),
        });
        const retryKey = promptDeliveryKey({
          idempotencyKey: 'cmd-1',
          sandboxId: 'ext-1',
          sessionId: 'sess-1',
          body: postPromptBody('please approve and continue'),
        });
        expect(key).toBe(retryKey);
        expect(claimPromptDelivery(key, 0)).toBe(true);
        expect(claimPromptDelivery(retryKey, 1_000)).toBe(false);
      });

      test('two DIFFERENT commandIds, identical body → BOTH deliver (independent claims)', () => {
        // Exactly the F2 hazard: two distinct queued continues whose text
        // happens to match. Before F2 these shared the same content-hash key
        // and the second was silently swallowed as a duplicate.
        const keyA = promptDeliveryKey({
          idempotencyKey: 'cmd-a',
          sandboxId: 'ext-1',
          sessionId: 'sess-1',
          body: postPromptBody('please approve and continue'),
        });
        const keyB = promptDeliveryKey({
          idempotencyKey: 'cmd-b',
          sandboxId: 'ext-1',
          sessionId: 'sess-1',
          body: postPromptBody('please approve and continue'),
        });
        expect(keyA).not.toBe(keyB);
        expect(claimPromptDelivery(keyA, 0)).toBe(true);
        expect(claimPromptDelivery(keyB, 0)).toBe(true);
      });
    });

    test('a non-string, empty, or malformed messageID falls back to the content hash', () => {
      const numericId = new TextEncoder().encode('{"parts":[],"messageID":123}').buffer;
      const blankId = new TextEncoder().encode('{"parts":[],"messageID":"   "}').buffer;
      const notJson = new TextEncoder().encode('not json at all').buffer;
      for (const body of [numericId, blankId, notJson]) {
        const key = promptDeliveryKey({ idempotencyKey: null, sandboxId: 'sb', sessionId: 'se', body });
        expect(key.startsWith('hash:')).toBe(true);
      }
    });
  });
});

describe('claimPromptDelivery', () => {
  test('first claim wins, an immediate repeat is deduped', () => {
    expect(claimPromptDelivery('k1', 1_000)).toBe(true);
    expect(claimPromptDelivery('k1', 1_000)).toBe(false);
    expect(claimPromptDelivery('k2', 1_000)).toBe(true);
  });

  test('a key is claimable again once its TTL has elapsed (T13: 10 minutes, not 60s)', () => {
    // A wake from auto-stop routinely takes longer than 60s (see
    // BOOT_BACKOFF_MS in messages.ts), and the queued continue_session drain
    // retries on the scheduler's own tick — so the old 60s TTL let a genuine
    // retry land as an un-deduped double delivery. 10 minutes matches this
    // system's own existing bound for "how stale can a retry be and still be
    // the same logical delivery" — UNDELIVERED_PROMPT_STARVATION_MS in
    // session-lifecycle/undelivered-prompts.ts.
    expect(claimPromptDelivery('k1', 0)).toBe(true);
    expect(claimPromptDelivery('k1', 60_001)).toBe(false); // past the OLD 60s TTL — still held
    expect(claimPromptDelivery('k1', 599_999)).toBe(false); // still within the NEW 10-min TTL
    expect(claimPromptDelivery('k1', 600_001)).toBe(true); // TTL expired → reclaimable
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

  test('/summarize matches — a retried summarize starts ANOTHER summary turn', () => {
    // 2026-08-26: every /compact died at the proxies' short timeouts as
    // `503 upstream unreachable`, and because summarize was absent here the
    // retry loop re-POSTed it — each retry stacking one more failed summary
    // attempt into the transcript.
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/session/abc123/summarize')).toBe(true);
    expect(isNonIdempotentSessionWrite(8000, 'post', '/session/abc-123/summarize?x=1')).toBe(true);
    expect(isNonIdempotentSessionWrite(8000, 'GET', '/session/abc123/summarize')).toBe(false);
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/session/abc123/summarizes')).toBe(false);
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

  test('a summarize with no Idempotency-Key does NOT claim — its body is byte-identical between deliberate retries', () => {
    // `{providerID,modelID}` is the whole summarize body: a user re-running
    // /compact after a failure sends identical bytes. A blanket claim would
    // answer the retry `200 {"deduplicated":true}` and never run it — the
    // same silent-loss trap as commands.
    expect(shouldClaimPromptDelivery('/session/abc/summarize', false)).toBe(false);
    expect(shouldClaimPromptDelivery('/session/abc/summarize?x=1', false)).toBe(false);
    expect(shouldClaimPromptDelivery('/session/abc/summarize', true)).toBe(true);
  });
});

describe('Idempotency-Key scoping', () => {
  // A failed create can requeue and re-provision onto a DIFFERENT
  // session/sandbox while carrying the SAME command-scoped Idempotency-Key
  // (session-lifecycle/engine.ts reuses the create command's id for the
  // post-create prompt). An unscoped `idem:` key let the first attempt's
  // claim swallow the retry's delivery to the NEW sandbox as a "duplicate" —
  // that sandbox genuinely never saw the prompt. Scope by sandbox+session,
  // exactly like the msgid and hash precedences: a repeat to the SAME box
  // still dedupes; a different box is a different delivery.
  test('the same Idempotency-Key on a different sandbox/session is a different delivery', () => {
    const a = promptDeliveryKey({
      idempotencyKey: 'cmd-1',
      sandboxId: 'sb-old',
      sessionId: 'se-old',
      body: undefined,
    });
    const b = promptDeliveryKey({
      idempotencyKey: 'cmd-1',
      sandboxId: 'sb-new',
      sessionId: 'se-new',
      body: undefined,
    });
    expect(a).not.toBe(b);
  });

  test('the same Idempotency-Key on the same sandbox/session still collides', () => {
    const a = promptDeliveryKey({
      idempotencyKey: 'cmd-1',
      sandboxId: 'sb',
      sessionId: 'se',
      body: undefined,
    });
    const b = promptDeliveryKey({
      idempotencyKey: 'cmd-1',
      sandboxId: 'sb',
      sessionId: 'se',
      body: new TextEncoder().encode('{"different":"body"}').buffer,
    });
    expect(a).toBe(b);
  });
});
