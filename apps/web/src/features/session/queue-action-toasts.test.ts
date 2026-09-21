import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { readFileSync } from '@/i18n/test-source';

// Source assertions, for the same reason as `session-chat-inbox-queue.test.ts`:
// `SessionChat` and `InstantSessionShell` are large client components with no
// DOM harness in this app, and what is under test is which value reaches
// `errorToast`. The behaviour itself is tested in `queue-action-copy.test.ts`
// and `queued-message-restore.test.ts`; these assertions pin the call sites.
//
// Every slice is taken through `between()`, which FAILS on a missing anchor
// rather than yielding '' and passing. Each check is a PAIR: the raw-text
// pattern is gone AND the mapper is called, so deleting the mapper cannot make
// the test pass.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');
const shell = readFileSync(
  fileURLToPath(new URL('./instant-session-shell.tsx', import.meta.url)),
  'utf8',
);
const queueEdit = readFileSync(
  fileURLToPath(new URL('./use-queue-edit.ts', import.meta.url)),
  'utf8',
);

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

const flat = (source: string) => source.replace(/\s+/g, ' ');

/** `errorToast(error.message)` and `errorToast(error instanceof Error ? error.message …)`. */
const RAW_SERVER_TEXT = /errorToast\(\s*(?:\(?\s*error|cause)[^)]*\.message/;

describe('no queue surface toasts what the server wrote', () => {
  test('edit and send now map every refusal instead of rethrowing the server prose', () => {
    // REWRITTEN when Edit moved from take-back (DELETE + prefill) to an edit in
    // the composer (`useQueueEdit`): the same rule, one file. Both refusal
    // paths classify the error; none toasts what the server wrote.
    const flatEdit = flat(queueEdit);
    expect(flatEdit).not.toMatch(RAW_SERVER_TEXT);
    // Save: the removal's refusal is classified.
    expect(flatEdit).toContain('const kind = classifyPromptActionError(error);');
    // Send now: the shared remove and restore copy.
    expect(flatEdit).toContain('removeFailureCopyKey(classifyPromptActionError(error))');
    expect(flatEdit).toContain('restoreFailureCopyKey(cause)');
  });

  test('the rewind removal loop reads the live inbox, so a row already removed is not deleted again', () => {
    // The selection itself is `rowsToRemoveOnRewind`, table-tested in
    // `queue-projection.test.ts`. This pins that the loop feeds it the LIVE
    // inbox — the ref, written by an effect — rather than the `promptInbox`
    // captured by the render that staged the rewind.
    const editSend = flat(
      between(chat, 'const handleEditSend = useCallback(', 'const handleStop = useCallback('),
    );
    expect(editSend).toContain('rowsToRemoveOnRewind(promptInboxRef.current)');
  });

  test('SessionChat removes through the shared handler', () => {
    const remove = flat(
      between(
        chat,
        'const handleRemoveQueuedMessage = useMemo(',
        'const handleRetryQueuedMessage = useCallback(',
      ),
    );
    expect(remove).toContain('createQueueRemoveHandler({');
    expect(remove).not.toMatch(RAW_SERVER_TEXT);
  });

  test('SessionChat takes the bubble down on the click, with the row', () => {
    // `promptInbox.remove` filters the row out on the click. This tab's own
    // optimistic bubble has to leave in the same frame: without its row it
    // reads as an ordinary message — full colour, Edit-from-here in the slot
    // Remove just held — for the DELETE round trip.
    const remove = flat(
      between(
        chat,
        'const handleRemoveQueuedMessage = useMemo(',
        'const handleRetryQueuedMessage = useCallback(',
      ),
    );
    const early = remove.indexOf('paintedMessageIdsOf(promptInboxRef.current, id)');
    expect(early).toBeGreaterThan(-1);
    expect(remove.indexOf('return removePrompt(id);')).toBeGreaterThan(early);
  });

  test('SessionChat retry says nothing when the row simply left the queue', () => {
    const retry = flat(
      between(
        chat,
        'const handleRetryQueuedMessage = useCallback(',
        '// Associate stashed command',
      ),
    );
    expect(retry).toContain('retryFailureCopyKey(classifyPromptActionError(error))');
    expect(retry).not.toMatch(RAW_SERVER_TEXT);
  });

  test('every InstantSessionShell queue handler is mapped', () => {
    // Not one `.catch((error) => errorToast(error.message))` left anywhere in
    // the file: that shape only ever belonged to a queue handler.
    // Not one toast of the server's own prose left anywhere in the file — the
    // send path's first-send catch included (it used to toast `error.message`).
    expect(shell).not.toMatch(RAW_SERVER_TEXT);
    // The shell removes and retries through ONE handler each, so a removal
    // during the sandbox boot paints the same toast and the same Undo as a
    // removal mid-session.
    const handlers = flat(
      between(shell, 'const removeQueuedPrompt = useMemo(', 'const pendingRowSubmission'),
    );
    expect(handlers).toContain('createQueueRemoveHandler({');
    expect(handlers).toContain('retryFailureCopyKey(classifyPromptActionError(error))');
    expect(handlers).not.toMatch(RAW_SERVER_TEXT);

    const list = flat(between(shell, '<QueuedPromptList', 'autoFocus'));
    expect(list).toContain('onRemove={removeQueuedPrompt}');
    expect(list).toContain('onRetry={retryQueuedPrompt}');
    // One function, so the shell cannot drift from SessionChat's wording again.
    expect(list).toContain('queueResumeFailedToast(tI18nHardcoded.raw)');
    // Edit and Send now go through the same controller SessionChat mounts.
    expect(list).toContain('shellQueueEdit.openEdit(id)');
    expect(list).toContain('onSendNow={shellQueueEdit.sendNow}');

    const bubbles = flat(between(shell, 'leadingStatus={', 'Once a first message is sent'));
    expect(bubbles).toContain('retryQueuedPrompt(firstPromptRow.prompt_id)');
    expect(bubbles).toContain('retryQueuedPrompt(entry.prompt!.prompt_id)');
    expect(bubbles).toContain('void removeQueuedPrompt(entry.prompt!.prompt_id)');
  });

  test('a waiting Quick Queue bubble offers Remove through the same rule and the same handler', () => {
    // The rule is `quickQueueRemove`, table-tested in `queue-projection.test.ts`;
    // the control is `QueuedPromptRemove`. These pin that both hosts feed the
    // rule the row and the actions in flight, and remove through the handler
    // that paints the Undo toast.
    const chatRule = flat(between(chat, 'const queuedRemove = quickQueueRemove({', '});'));
    expect(chatRule).toContain('prompt: pendingPrompt');
    expect(chatRule).toContain('firstPrompt: isFirstPrompt');
    expect(chatRule).toContain('pendingAction: queuedActionPending');

    const chatBubble = flat(between(chat, 'data-turn-pending={pending', '{/* ── Assistant parts'));
    expect(chatBubble).toContain('queueAction={');
    expect(chatBubble).toContain('<QueuedPromptRemove');
    expect(chatBubble).toContain('pendingAction={queuedRemove.pendingAction}');
    expect(chatBubble).toContain('onRemoveQueued(queuedRemove.promptId)');

    const chatTurn = flat(between(chat, 'pendingPrompt={pendingPrompt}', 'interruptedBeforeRun={'));
    expect(chatTurn).toContain('promptInbox.pendingActions[pendingPrompt.prompt_id]');
    expect(chatTurn).toContain('onRemoveQueued={handleRemoveQueuedMessage}');

    const shellBubble = flat(
      between(shell, 'transcriptQueue.map((entry) =>', 'Once a first message is sent'),
    );
    expect(shellBubble).toContain('quickQueueRemove({');
    expect(shellBubble).toContain('prompt: entry.prompt');
    expect(shellBubble).toContain('promptInbox.pendingActions[entry.prompt.prompt_id]');
    expect(shellBubble).toContain('<QueuedPromptRemove');
    expect(shellBubble).toContain('void removeQueuedPrompt(queuedRemove.promptId)');
  });

  test('SessionChat resumes with the shared toast', () => {
    const resume = flat(
      between(chat, 'const handleResumeQueue = useCallback(', 'const queueEditor = useQueueEdit('),
    );
    expect(resume).toContain('queueResumeFailedToast(tHardcodedUi.raw)');
    expect(resume).not.toContain("tHardcodedUi.raw('i18nComplete.text06619384104c')");
  });

  test('SessionChat imports no toast helper it no longer calls', () => {
    // `dismissToast`'s only call site moved into `createQueueRemoveHandler`.
    expect(chat).not.toContain('dismissToast');
  });

  test('the shell builds its queue rows with the pending actions', () => {
    const rows = flat(between(shell, 'const shellQueue = useMemo(', 'const transcriptQueue'));
    expect(rows).toContain('pendingActions: promptInbox.pendingActions');
  });
});
