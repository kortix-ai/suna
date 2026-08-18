import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source assertions, for the same reason as `session-chat-queued-retry-id.test.ts`:
// `SessionChat` is a 4k-line component with no DOM harness in this app, and the
// wiring under test is which value reaches which call. Every slice is taken
// through `between()`, which FAILS on a missing anchor rather than yielding ''
// and passing.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');
const composer = readFileSync(
  fileURLToPath(new URL('./composer/composer.tsx', import.meta.url)),
  'utf8',
);
const shell = readFileSync(
  fileURLToPath(new URL('./instant-session-shell.tsx', import.meta.url)),
  'utf8',
);

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('stop reaches the queue that actually holds the messages', () => {
  test('handleStop holds the SERVER inbox — the only queue there is', () => {
    // REWRITTEN with the browser drain's deletion. A client-side pause never
    // reached the admission gate, which would admit the queued prompt about one
    // scheduler tick after the abort cleared turn authority — exactly the
    // message the user pressed Stop to get ahead of — and it left every OTHER
    // tab's view of the queue running.
    const stop = between(chat, 'const handleStop = useCallback(', 'issueSessionCancel();');
    expect(stop).toContain('promptInbox.hold(true)');
    expect(stop).not.toContain('queueDrain');
  });

  test('the strip is dimmed by the SERVER hold, which every tab can see', () => {
    expect(chat).toContain('queuePaused={queueRows.held}');
  });

  test('a rewind removes the queued rows instead of holding them', () => {
    // A hold cannot be right here, for a reason that is structural rather than
    // a matter of taste: the inbox delivers by `created_at`, so a row queued
    // BEFORE the rewind is admitted before the replacement prompt the rewind
    // prefills — and the first delivery is what commits the revert. The old
    // follow-up would commit the user's rewind and run against the trajectory
    // it truncated. A hold also does not hold: `POST .../prompts` releases it,
    // and the send that releases it is the one the rewind flow itself
    // prefills. So the rows go, exactly as the browser queue's `clearSession`
    // took them, and the user is told.
    const rewind = between(
      chat,
      'const handleConfirmRewind = useCallback(',
      'const handleRestoreRewind',
    );
    expect(rewind).toContain('promptInbox.remove(');
    expect(rewind).not.toContain('promptInbox.hold(');
    expect(rewind).toContain('infoToast(');
  });
});

describe('"send now" addresses the thing that actually holds the row', () => {
  test('every row is dispatched through the inbox, by its own id, and nothing else touches the hold', () => {
    // `retry` is the inbox's own "run this one next": it promotes the row past
    // the ordering gate and releases the stop's hold in one call, IN THAT
    // ORDER. Releasing the hold separately beforehand made every held row due
    // at the same instant and kicked a drain that claims by
    // `available_at, created_at` — so the OLDEST row ran, not the one the user
    // clicked. See `session-chat-stop-send-ordering.test.ts`.
    const sendNow = between(
      chat,
      'const handleQueueSendNow = useCallback(',
      '// ---- Triple-ESC to stop ----',
    );
    expect(sendNow).toContain('promptInbox.retry(id)');
    expect(sendNow).not.toContain('promptInbox.hold(');
    expect(sendNow).not.toContain('queueDrain');
  });

  test('undo re-creates the prompt from what the DELETE handed back', () => {
    // Not from the list row: `SessionPrompt.text` is a 2000-char preview and
    // carries no parts, so restoring from it silently drops every attachment,
    // the agent/model/variant picks, and anything past the truncation — under
    // a button labelled "Undo". The row is hard-deleted, so the delete's own
    // response is the only place the full body still exists.
    const remove = between(
      chat,
      'const handleRemoveQueuedMessage = useCallback(',
      'const handleRetryQueuedMessage',
    );
    expect(remove).toContain('removed = await promptInbox.remove(id)');
    // The body itself is built by `createQueueUndoAction`/`restoreQueuedMessage`
    // — asserted behaviorally in `queued-message-restore.test.ts`. This proves
    // the DELETE's own response is what reaches it, not the list row.
    expect(remove).toContain('createQueueUndoAction({');
    expect(remove).toContain('removed,');
    expect(remove).not.toContain("parts: [{ type: 'text', text: removed.text }]");
  });

  test('remove and retry have no origin to route by any more', () => {
    // One holder means one code path. The `localIds` branch each of these
    // carried is gone with the store it addressed.
    const remove = between(
      chat,
      'const handleRemoveQueuedMessage = useCallback(',
      'const handleRetryQueuedMessage',
    );
    expect(remove).not.toContain('localIds');
    const retry = between(
      chat,
      'const handleRetryQueuedMessage = useCallback(',
      '// Stop the transcript polling fallback',
    );
    expect(retry).not.toContain('localIds');
    expect(retry).toContain('promptInbox.retry(id)');
  });
});

describe('a prompt that will WAIT is not painted into the transcript', () => {
  test('the optimistic user message is only added when the prompt can run now', () => {
    // Otherwise the same message is on screen twice — once as a transcript
    // bubble under the still-streaming answer, once as a queue row — and the
    // bubble then vanishes when the running turn ends and the optimistic sweep
    // clears it, only to reappear when the drain finally delivers.
    const send = between(chat, 'const willWaitInInbox =', 'anchorTurn(messageID);');
    expect(send).toContain('beginOptimisticSend(');
    expect(send).toContain('if (!willWaitInInbox)');
  });

  test('the failure path only rehydrates a message it actually painted', () => {
    const send = between(chat, 'const result = await (async () => {', 'if (!result.ok) {');
    expect(send).toContain('willWaitInInbox');
    expect(send).toContain('recoverFromSendFailure(sessionId, messageID, cause');
  });
});

describe('a `/` command is REFUSED mid-turn, not queued', () => {
  test('the composer refuses the command and dispatches nothing', () => {
    // REWRITTEN with the browser queue's deletion. A command is a turn, and it
    // does NOT go through the prompt inbox — it is dispatched by `runCommand`,
    // so no admission gate ever sees it and putting one on the wire mid-turn
    // aborts the answer in progress. It used to wait in a tab-local queue for
    // that reason; a closed tab lost it, a second tab could not see it, and its
    // release was a guess at a turn boundary. A refusal keeps the draft in the
    // editor and stores nothing.
    const branch = between(composer, "if (plan.kind === 'command') {", 'if (lockForQuestion) {');
    expect(branch).toContain('commandBlocker({');
    expect(branch).toContain('isWorking: sessionWorking ?? isBusy');
    expect(branch).toContain('if (blocker) {');
    expect(branch).toContain('onCommand?.(plan.command, plan.args, draft?.commandSplit)');
    expect(branch).not.toContain('onQueueMessage');
  });

  test('the refusal reads server turn authority, not the 300 ms busy fade', () => {
    // `isBusy` is a fade timer for the busy indicator: it lapses between
    // agentic steps, which is exactly when a command would land mid-turn.
    expect(chat).toContain('sessionWorking={effectiveBusy || hasRetryingAssistant}');
  });

  test('a PROMPT is never refused for being mid-turn — the server orders it', () => {
    const promptBranch = between(composer, 'const reset = resolveComposerResetOnSend(', '} catch {');
    expect(promptBranch).toContain('await onSend(trimmed, filesToSend, mentionsToSend)');
    expect(promptBranch).not.toContain('onQueueMessage(');
    // The shared blocker set has no `session_working` member for a prompt:
    // only `commandBlocker` adds it.
    const shared = between(composer, 'const submissionBlocker = sendBlocker({', 'const draft =');
    expect(shared).not.toContain('isWorking');
  });

  test('SessionChat hands the composer no local queue at all', () => {
    expect(chat).not.toContain('handleQueueMessage');
    expect(chat).not.toContain('onQueueMessage=');
  });
});

describe('the boot shell never swallows what the user typed', () => {
  test('a second message typed during boot is refused, and the draft survives', () => {
    // Three answers, in order: `return` outright (the composer had already
    // cleared the input, so the draft was gone); a browser-local queue, because
    // the FIRST message is still in the start stash and is not an inbox row
    // yet, so a row created now would be admitted BEFORE it; and now a throw.
    // `dispatchSubmission` catches it and `planFailedSendRecovery` puts the
    // text and attachments back — nothing is stored, so nothing can be lost.
    const send = between(shell, 'const handleSend = useCallback(', "playSound('send');");
    expect(send).toContain('if (submitted)');
    expect(send).toContain('throw new Error(');
    expect(shell).not.toContain('useMessageQueueStore');
  });

  test('the refused draft outlives the shell, which the crossfade unmounts', () => {
    // The throw restores the text into THIS component's editor, and this
    // component is destroyed the moment `chatReady` flips — after a 19-25 s
    // boot, which is exactly when a follow-up gets typed. `carryDraft` hands it
    // to the session so `SessionChat` can pick it up; nothing is SENT, so the
    // ordering rule the refusal exists for is untouched.
    const send = between(shell, 'const handleSend = useCallback(', "playSound('send');");
    expect(send).toContain('carryDraft(sessionId, text, files ?? [])');
    expect(chat).toContain("useCarriedDraft(projectSessionId ?? '')");
    expect(chat).toContain('text: carriedDraft.text');
  });

  test('the carried draft is consumed ON APPLY, never on SessionChat mount', () => {
    // The draft is written BEFORE SessionChat exists, so it is present on the
    // FIRST commit — when the lazily-mounted composer editor is still null and
    // `shouldApplyPrefill` refuses it. A clear in SessionChat's own mount effect
    // therefore ran one commit too early and deleted the message the shell's
    // toast promised to keep. The composer reports the id it applied instead.
    const applied = between(
      chat,
      'const handlePrefillApplied = useCallback(',
      '[composerPrefill, projectSessionId],',
    );
    expect(applied).toContain("composerPrefill?.source !== 'carried'");
    expect(applied).toContain('composerPrefill.id !== appliedId');
    expect(applied).toContain("clearCarriedDraft(projectSessionId ?? '')");
    expect(chat).toContain('onPrefillApplied={handlePrefillApplied}');
    // Nothing else may clear it: a second clear site is a clear on mount again.
    expect(chat.match(/clearCarriedDraft\(/g) ?? []).toHaveLength(1);
    // And the composer only reports it once the text is actually in the editor.
    const prefillEffect = between(
      composer,
      '!shouldApplyPrefill({',
      '[prefillId, prefillText, prefillFiles, prefillMode, editorElement]',
    );
    expect(prefillEffect.indexOf('onPrefillAppliedRef.current?.(')).toBeGreaterThan(
      prefillEffect.indexOf('editorRef.current?.focus()'),
    );
  });

  test('a `/` command is refused while the sandbox is still waking', () => {
    // `runCommand` returns a RESOLVED promise until the runtime is switched: no
    // request, no error, no row. Dispatching into it cleared the draft and left
    // an optimistic command bubble waiting on a turn that never starts. The
    // prompt path is deliberately NOT gated — it becomes an inbox row.
    const commandBranch = between(composer, 'const blocker = commandBlocker({', 'if (blocker) {');
    expect(commandBranch).toContain('runtimeReady,');
    expect(chat).toContain('runtimeReady={runtimeReady}');
    const shared = between(composer, 'const submissionBlocker = sendBlocker({', 'const draft =');
    expect(shared).not.toContain('runtimeReady');
  });

  test('the shell reports itself as working, so a boot-time command is refused too', () => {
    expect(shell).toContain('sessionWorking={!!submitted}');
  });
});
