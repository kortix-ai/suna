import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

// ANCHOR GUARD — not a regression test.
//
// Every behaviour named here is unit-tested where it lives:
// `removeQueuedDraftSend` (call order and arguments, with fakes) in
// `queue-draft-actions.test.ts`, `projectQueueRows` and `draftMessageId` in
// `queue-projection.test.ts`, `captureHeldSend` and `heldSendResendInput` in
// `session-composer-handoff-store.test.ts`.
//
// What no pure test can reach is whether `SessionChat` — a 4k-line component
// with no DOM harness in this app — actually CALLS them, and with which value.
// That is all this file pins. It fails on a renamed anchor, so read a failure
// here as "the wiring moved", and check the behavioural test before editing an
// assertion.
//
// Every slice is taken through `between()`, which FAILS on a missing anchor
// rather than yielding '' and passing.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

function between(start: string, end: string): string {
  const from = chat.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = chat.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return chat.slice(from, to);
}

const flat = (source: string) => source.replace(/\s+/g, ' ');

/**
 * A Queue List send that fails before the POST leaves no server row, so its
 * row stands for a draft this tab still holds. Both queue actions have to
 * recognise that row and act on the draft instead of on a `prompt_id` the
 * route would answer 404 for.
 */
describe('a failed Queue List send is acted on as a draft, not as a row', () => {
  test('the list is built from the held-send failures, and mints nothing while rendering', () => {
    const rows = flat(between('const queueRows = useMemo(', 'A posted draft whose row'));
    expect(rows).toContain('heldSendFailures: listSendFailures,');
    // The projection is a pure read: no session id goes in, so no wire id can
    // be minted (and the SDK's submission memo written) from a `useMemo`.
    expect(rows).not.toContain('sessionId');
    // The same store the transcript reads for a Quick Queue bubble.
    expect(chat).toContain(
      'const listSendFailures = useHeldSendFailureStore((s) => s.failuresBySession[sessionId]);',
    );
  });

  test('the send stores the wire id on its draft, so nothing has to re-derive it', () => {
    const send = flat(between('useQueuedDraftStore.getState().add(sessionId, {', 'posted: false,'));
    expect(send).toContain('messageId: messageID,');
  });

  test('both draft actions take that stored id, and mint only as a last resort', () => {
    const helper = flat(
      between('function heldSendIdForDraft(', 'const STOP_HOLD_DEADLINE_MS = 1500;'),
    );
    expect(helper).toContain('draftMessageId(drafts, clientMessageId) ??');
    expect(helper).toContain('mintSessionWireMessageId(sessionId, clientMessageId)');
  });

  test('Remove hands the pure removal its stores, its toast and both prompt reads', () => {
    const remove = flat(between('const removeQueuedDraft = useCallback(', 'Removing used to be'));
    expect(remove).toContain('removeQueuedDraftSend({');
    expect(remove).toContain('messageId: heldSendIdForDraft(sessionId, clientMessageId),');
    expect(remove).toContain('failures: useHeldSendFailureStore.getState(),');
    expect(remove).toContain('drafts: useQueuedDraftStore.getState(),');
    // Same sentence as a server row's Remove; no Undo button beside it.
    expect(remove).toContain('infoToast(tHardcodedUi.raw(QUEUE_REMOVED_KEY), {');
    expect(remove).not.toContain('QUEUE_UNDO_KEY');
    expect(remove).toContain('listedPrompts: () => promptInboxRef.current.prompts,');
    expect(remove).toContain(
      'async () => (await listSessionPrompts(projectId, projectSessionId)).prompts',
    );
    expect(remove).toContain('removePrompt: promptInbox.remove,');
  });

  test('the remove handler routes a draft row to it and everything else to the shared handler', () => {
    const handler = flat(
      between('const handleRemoveQueuedMessage = useMemo(', 'const handleRetryQueuedMessage'),
    );
    expect(handler).toContain('const clientMessageId = draftClientMessageId(id);');
    expect(handler).toContain(
      'if (clientMessageId !== null) return removeQueuedDraft(clientMessageId);',
    );
    expect(handler).toContain('return removePrompt(id);');
  });

  test('Retry re-runs the kept send, so the same words, picks and Enter time go out again', () => {
    const retry = flat(
      between('const handleRetryQueuedMessage = useCallback(', 'Associate stashed command info'),
    );
    expect(retry).toContain('const clientMessageId = draftClientMessageId(id);');
    expect(retry).toContain(
      'retryHeldSend( sessionId, heldSendIdForDraft(sessionId, clientMessageId),',
    );
    // The re-send goes through the kept send's own arguments.
    expect(chat).toContain('const again = heldSendResendInput(send);');
  });

  test('the send keeps the original Enter, and a re-send never re-wraps the reply context', () => {
    const send = flat(between('const handleSend = useCallback(', 'const placement = overrides'));
    expect(send).toContain('const sentAtMs = overrides?.sentAtMs ?? Date.now();');
    expect(send).toContain('if (overrides?.sentText !== undefined) { text = overrides.sentText; }');
  });
});
