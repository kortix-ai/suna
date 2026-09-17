import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';

import {
  fileNewSessionSendReceipt,
  pendingFirstPromptMessageId,
  planNewSessionSendReceipt,
  type SendReceiptStore,
} from './new-session-send-receipt';

const SID = '00000000-0000-4000-8000-000000000001';
const SENT_AT = 1_769_999_990_000;

function recorder(): SendReceiptStore & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    noteSendReceipt: (sessionId, receipt) => calls.push(['noteSendReceipt', sessionId, receipt]),
    acceptSendReceipt: (sessionId, messageId, atMs) =>
      calls.push(['acceptSendReceipt', sessionId, messageId, atMs]),
    notePromptAccepted: (sessionId, atMs, serverAtMs) =>
      calls.push(['notePromptAccepted', sessionId, atMs, serverAtMs]),
    clearSendReceipt: (sessionId, messageId) =>
      calls.push(['clearSendReceipt', sessionId, messageId]),
  };
}

describe('planNewSessionSendReceipt — which receipt a new-session send files', () => {
  test('a create carrying the first prompt files one, under the id the API mints for it', () => {
    expect(planNewSessionSendReceipt({ sessionId: SID, hasPendingPrompt: true })).toEqual({
      file: true,
      messageId: `pending:${SID}`,
    });
    expect(pendingFirstPromptMessageId(SID)).toBe(`pending:${SID}`);
  });

  // The sidebar's "New session" creates an empty session. Nothing was sent, so
  // a receipt would make the composer show Stop for a session with no prompt.
  test('a create with no prompt files nothing', () => {
    expect(planNewSessionSendReceipt({ sessionId: SID, hasPendingPrompt: false })).toEqual({
      file: false,
    });
  });

  test('no session id files nothing', () => {
    expect(planNewSessionSendReceipt({ sessionId: '', hasPendingPrompt: true })).toEqual({
      file: false,
    });
  });
});

describe('fileNewSessionSendReceipt — the send is covered from the Send press', () => {
  test('the receipt is stamped at the SEND instant, not at the response', () => {
    const store = recorder();

    fileNewSessionSendReceipt({
      sessionId: SID,
      hasPendingPrompt: true,
      sentAtMs: SENT_AT,
      store,
    });

    expect(store.calls).toEqual([
      ['noteSendReceipt', SID, { messageId: `pending:${SID}`, atMs: SENT_AT }],
    ]);
  });

  test('acceptance files the same pair startSessionWithPrompt files', () => {
    const store = recorder();

    const receipt = fileNewSessionSendReceipt({
      sessionId: SID,
      hasPendingPrompt: true,
      sentAtMs: SENT_AT,
      store,
    });
    receipt.accept(SENT_AT + 420);

    expect(store.calls.slice(1)).toEqual([
      ['acceptSendReceipt', SID, `pending:${SID}`, SENT_AT + 420],
      ['notePromptAccepted', SID, SENT_AT + 420, undefined],
    ]);
  });

  test('a refused create or claim clears the receipt it filed', () => {
    const store = recorder();

    const receipt = fileNewSessionSendReceipt({
      sessionId: SID,
      hasPendingPrompt: true,
      sentAtMs: SENT_AT,
      store,
    });
    receipt.clear();

    expect(store.calls.slice(1)).toEqual([['clearSendReceipt', SID, `pending:${SID}`]]);
  });

  test('a create with no prompt touches the store on no path', () => {
    const store = recorder();

    const receipt = fileNewSessionSendReceipt({
      sessionId: SID,
      hasPendingPrompt: false,
      sentAtMs: SENT_AT,
      store,
    });
    receipt.accept(SENT_AT + 1);
    receipt.clear();

    expect(store.calls).toEqual([]);
  });
});

/**
 * The receipts only exist because the home send files them. `useNewProjectSession`
 * is a hook over a router, a query client and three stores, with no harness in
 * this app, so the call sites are asserted against its source — matched against
 * WHITESPACE-COLLAPSED text, so re-indenting or re-nesting cannot fail a test
 * whose decision is unchanged. `between()` FAILS on a missing anchor rather
 * than yielding '' and passing.
 */
function squish(source: string): string {
  return source.replace(/\s+/g, ' ');
}

const hook = squish(
  readFileSync(fileURLToPath(new URL('./use-new-project-session.ts', import.meta.url)), 'utf8'),
);

function between(source: string, start: string, end: string): string {
  const startAt = squish(start);
  const endAt = squish(end);
  const from = source.indexOf(startAt);
  expect(from, `anchor not found: ${startAt}`).toBeGreaterThan(-1);
  const to = source.indexOf(endAt, from + startAt.length);
  expect(to, `anchor not found after ${startAt}: ${endAt}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the home send files these receipts', () => {
  test('the warm claim files one against the warm session, at the send instant', () => {
    const slice = between(hook, 'const warmReceipt = fileNewSessionSendReceipt({', '});');
    expect(slice).toContain('sessionId: warm.sessionId,');
    expect(slice).toContain('hasPendingPrompt: !!pendingPrompt,');
    expect(slice).toContain('sentAtMs,');
  });

  test('the ordinary create files one against the id it mints', () => {
    const slice = between(hook, 'const receipt = fileNewSessionSendReceipt({', '});');
    expect(slice).toContain('sessionId,');
    expect(slice).toContain('hasPendingPrompt: !!pendingPrompt,');
    expect(slice).toContain('sentAtMs,');
  });

  // Accept on the paths that produced a session, clear on the ones that did
  // not. A receipt left open keeps the composer showing Stop for a prompt the
  // server never took.
  test('every branch either accepts or clears the receipt it filed', () => {
    expect(hook).toContain('warmReceipt.accept(Date.now());');
    expect(hook).toContain('warmReceipt.clear();');
    expect(hook).toContain('receipt.clear();');
    expect(hook).toContain('receipt.accept(Date.now());');
  });

  // The send instant, not the response instant: the create and the claim carry
  // the same prompt, so both receipts and the API row share one stamp.
  test('the send instant comes from the prompt, not from the response', () => {
    expect(hook).toContain('const sentAtMs = pendingPrompt?.send_started_at_ms ?? Date.now();');
  });

  test('the adoption seeds the row pickAdoptedWarmSession chooses', () => {
    expect(hook).toContain(
      'adoptedWarmSession = pickAdoptedWarmSession(claimed, warm.session);',
    );
  });
});
