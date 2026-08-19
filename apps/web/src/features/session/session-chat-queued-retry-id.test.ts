import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source assertions, for the same reason as session-chat-external-send.test.ts:
// `SessionChat` is a 4k-line component with no DOM harness in this app, and the
// wiring under test is which value reaches which call — not rendered output.
//
// Every slice below is taken through `between()`, which FAILS when an anchor is
// missing instead of quietly yielding '' and passing. A source test that cannot
// fail is worse than no test: it reports coverage it does not have.
const source = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('a queue retry re-sends ONE delivery, not two', () => {
  // The proxy identifies a prompt delivery by a sha256 of the request body
  // (apps/api/src/sandbox-proxy/prompt-dedupe.ts, 60s TTL) because the browser
  // cannot send `Idempotency-Key` — it is not on the API's CORS allow-list. The
  // SDK now mints a per-submission `messageID` into that body, so a retry that
  // mints a NEW one is no longer absorbed: a prompt that reached opencode but
  // reported failure would be delivered twice, and the second delivery aborts
  // the turn the first one started. `clientMessageId` is what makes a retry the
  // same submission.
  test('a retry re-runs the SERVER row, so the key is never re-derived here', () => {
    // REWRITTEN with the browser drain's deletion. There used to be a local
    // dispatch that merged a claimed batch and handed `overrides.clientMessageId`
    // to `handleSend`, and the risk it carried was that the merge dropped the
    // key and the retry minted a new one. There is no local dispatch: a retry is
    // `POST .../prompts/:id/retry`, which re-queues the row UNDER ITS ORIGINAL
    // wire id server-side, so the key cannot be re-derived wrongly by a client.
    const retry = between(
      'const handleRetryQueuedMessage = useCallback(',
      '// Associate stashed command info',
    );

    expect(retry).toContain('promptInbox.retry(id)');
    expect(retry).not.toContain('clientMessageId');
  });

  test('handleSend accepts it as an override rather than minting its own', () => {
    const signature = between('const handleSend = useCallback(', 'setCommandError(null);');

    expect(signature).toContain('clientMessageId?: string');
  });

  test('there is now exactly ONE wire path, and it is the server prompt inbox', () => {
    // REWRITTEN. There used to be two send paths — `sessionState.sendParts`
    // when the session runtime hook was mounted, `sendAndRecover` otherwise —
    // and each had to thread the submission key separately. Both are gone: the
    // composer POSTs a durable row to `POST .../prompts`, and the SERVER
    // decides when it is delivered. One path cannot disagree with itself.
    const send = between('const result = await (async () => {', 'if (!result.ok) {');

    expect(send).toContain('promptInbox.enqueue({');
    expect(send).not.toContain('sessionState.sendParts(');
    expect(send).not.toContain('sendAndRecover({');
    // The wire id is minted by the SDK (`mintSessionWireMessageId`, above the
    // POST) and is ALSO the optimistic bubble's id — one id per prompt — so
    // the row carries `messageID` itself.
    expect(send).toContain('messageId: messageID,');
    // Recovery on a failed enqueue is unchanged.
    expect(send).toContain('recoverFromSendFailure(sessionId, messageID, cause');
  });

  test('a direct composer send stays unnamed, so identical text sent twice is two turns', () => {
    // The opposite failure: keying every send off one value would resurrect the
    // silent-drop bug this branch exists to fix. Only the queue names a
    // submission, and each enqueue mints its own key.
    const composer = between('await handleSend(text, files, mentions);', 'prefill={composerPrefill}');

    expect(composer).not.toContain('clientMessageId');
  });
});
