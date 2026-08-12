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
  test('the queue dispatch carries the entry stable key into handleSend', () => {
    const dispatch = between('const sendQueuedMessage = useCallback(', 'const queueDrain =');

    expect(dispatch).toContain('clientMessageId: message.clientMessageId');
  });

  test('handleSend accepts it as an override rather than minting its own', () => {
    const signature = between('const handleSend = useCallback(', 'setCommandError(null);');

    expect(signature).toContain('clientMessageId?: string');
  });

  test('BOTH wire paths forward it — the sessionState one and the fallback', () => {
    // Two send paths exist (`sessionState.sendParts` when the session runtime
    // hook is mounted, `sendAndRecover` otherwise). Threading only one leaves
    // the other duplicating on retry, which is the harder half to notice.
    const send = between('const result = sessionState', 'if (!result.ok) {');
    const forwards = send.match(/clientMessageId: overrides\.clientMessageId/g) ?? [];

    expect(send).toContain('sessionState.sendParts(');
    expect(send).toContain('sendAndRecover({');
    expect(forwards).toHaveLength(2);
  });

  test('a direct composer send stays unnamed, so identical text sent twice is two turns', () => {
    // The opposite failure: keying every send off one value would resurrect the
    // silent-drop bug this branch exists to fix. Only the queue names a
    // submission, and each enqueue mints its own key.
    const composer = between(
      'const handleSendWithDraftClear = useCallback(',
      '[handleSend, failedStartDraft, sessionId]',
    );

    expect(composer).toContain('handleSend(text, files, mentions)');
    expect(composer).not.toContain('clientMessageId');
  });
});
