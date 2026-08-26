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

  test('the queued bubbles read the SERVER hold, which every tab can see', () => {
    // The queue is drawn IN the transcript, not in a composer strip.
    expect(chat).toContain('held={queueRows.held}');
    expect(chat).toContain('<QueuedPromptBubbles');
    expect(chat).not.toContain('queuePaused=');
    expect(chat).not.toContain('queuedMessages={queuedMessages}');
  });

  test('a rewind removes the queued rows instead of holding them', () => {
    // A hold cannot be right here, for a reason that is structural rather than
    // a matter of taste: the inbox delivers by `created_at`, so a row queued
    // BEFORE the rewind is admitted before the replacement prompt the edit
    // sends — and the first delivery is what commits the revert. The old
    // follow-up would commit the user's rewind and run against the trajectory
    // it truncated. A hold also does not hold: `POST .../prompts` releases it,
    // and the send that releases it is the edit's own replacement prompt.
    // So the rows go, exactly as the browser queue's `clearSession` took them,
    // and the user is told. (`handleEditSend` is the inline editor's Send —
    // the successor of `handleConfirmRewind` + its ConfirmDialog.)
    const rewind = between(chat, 'const handleEditSend = useCallback(', 'const handleStop');
    expect(rewind).toContain('promptInbox.remove(');
    expect(rewind).not.toContain('promptInbox.hold(');
    expect(rewind).toContain('infoToast(');
  });

  test('the edit-send commits the local revert — Restore must not outlive the path it restores', () => {
    // OpenCode commits a staged revert on ANY prompt delivery
    // (`SessionRevert.cleanup`, first thing in `SessionPrompt.prompt`), but
    // the classic server emits no `session.next.revert.*` wire event —
    // `setRevert`/`clearRevert` are bare session patches, and
    // `syncSessionRevertFromInfo` deliberately ignores an absent `revert`
    // field. The inbox send path also never runs the SDK's `sendParts`, whose
    // trailing `commitSessionRevert` covers this for SDK hosts. So the ONLY
    // thing that can retire the composer's Restore button after an edit-send
    // is this handler committing the local record itself; without it the
    // button survives forever and every click is a guaranteed no-op
    // (`unrevert` finds nothing staged, or throws BusyError mid-run).
    const rewind = between(chat, 'const handleEditSend = useCallback(', 'const handleStop');
    const sendAt = rewind.indexOf('await handleSend(text)');
    const commitAt = rewind.indexOf('.commitSessionRevert(');
    expect(sendAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(sendAt);
    // Only a SUCCESSFUL send commits: a refused send leaves the revert staged,
    // where Restore genuinely works.
    expect(rewind).toContain('if (sendOk');
  });

  test('the Restore control is disabled while the session is busy', () => {
    // `unrevert` asserts the session is idle server-side (BusyError) — the
    // button must refuse up front rather than offer a guaranteed failure.
    const composerRewind = between(chat, 'const composerRewind =', 'onRestore:');
    expect(composerRewind).toContain('disabled: isBusy');
  });

  test('the Restore control never flashes during the edit-send window', () => {
    // The edit's Send stages the revert first and commits it only after
    // `handleSend` resolves — ungated, the button paints for the milliseconds
    // in between and vanishes. It may appear only once the send has FAILED
    // (record still staged, restore genuinely works).
    const composerRewind = between(chat, 'const composerRewind =', 'onRestore:');
    expect(composerRewind).toContain('!editSendPending');
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
      '// Associate stashed command info',
    );
    expect(retry).not.toContain('localIds');
    expect(retry).toContain('promptInbox.retry(id)');
  });
});

describe('ONE prompt = ONE id = ONE bubble, from Enter', () => {
  test('every send paints the transcript bubble under the WIRE id — no "will it wait?" branch', () => {
    // The old rule painted nothing for a prompt that would wait, so the queue
    // strip drew it instead, and the hand-off between the two surfaces was
    // where it doubled, blinked and jumped. Now the bubble is in the
    // transcript from the first frame under the id the inbox row carries;
    // its turn renders dimmed until the agent reaches it (`pending`).
    const send = between(chat, "playSound('send');", 'anchorTurn(messageID);');
    expect(send).toContain('const messageID = mintSessionWireMessageId(sessionId, clientMessageId);');
    expect(send).toContain('beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);');
    expect(send).not.toContain('willWaitInInbox');
    expect(chat).not.toContain('willWaitInInbox');
  });

  test('the row carries the SAME id, and the bubble is inbox-backed from dispatch (never swept)', () => {
    const send = between(chat, 'const result = await (async () => {', 'if (!result.ok) {');
    expect(send).toContain('messageId: messageID,');
    expect(send).toContain('recoverFromSendFailure(sessionId, messageID, cause');
    // Marked in the SAME tick as the paint, before the first await: an idle
    // frame from a short previous turn used to sweep the bubble mid-send.
    const paint = between(chat, 'beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);', 'const sendingIntoRunningTurn');
    expect(paint).toContain('markOptimisticSendInboxBacked(sessionId, messageID);');
  });

  test('a row already on screen — by id or by re-mint alias — is never a queued bubble', () => {
    expect(chat).toContain('store.optimisticOriginOf(sessionId, message.info.id)');
    expect(chat).toContain('transcriptMessageIds: transcriptUserMessageIds');
  });

  test('the turn is keyed by the id the bubble was FIRST painted under — uniquely', () => {
    // The origin key keeps one element across the re-mint swap; the
    // uniqueness pass keeps React sane when an old echo and its re-placed
    // copy transiently share an origin (duplicate keys corrupt the list).
    expect(chat).toContain('key={turnRenderKeys.get(turn.userMessage.info.id)}');
    expect(chat).toContain('const origin = optimisticOriginOf(sessionId, id);');
    expect(chat).toContain('while (used.has(key)) key = `${key}~`;');
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
    //
    // REWRITTEN when the redundant OR was removed (55ee4e2981):
    // `sessionWorking={effectiveBusy || hasRetryingAssistant}` collapsed to
    // `sessionWorking={effectiveBusy}` because `effectiveBusy` is now built by
    // `resolveEffectiveBusy({ isServerBusy, isOptimisticCompacting,
    // hasRetryingAssistant })` — the retry predicate already folds into it, so
    // the composer reads one value instead of re-ORing a term it already
    // contains. The invariant this test actually guards was never asserted
    // directly: the negative below is it — the refusal must NOT read the
    // faded `isBusy`, so this test fails if someone points the composer at it.
    expect(chat).toContain('sessionWorking={effectiveBusy}');
    expect(chat).not.toContain('sessionWorking={isBusy}');
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
  test('every shell send — first or second — is a durable row, POSTed before the bubble', () => {
    // Three answers preceded this, in order: `return` outright (the draft was
    // simply gone); a browser-local queue (lost with the tab); then a refusal
    // with a toast and a carried draft, because the FIRST message travelled
    // through the start stash and a row POSTed during boot would have been
    // admitted before it. The first message is an inbox row NOW, so ordering
    // is the server's (available_at, created_at) and the refusal is gone: a
    // second message simply POSTs. AWAITED and thrown on failure, so the
    // composer's own recovery restores the draft for a message the server
    // never got.
    const send = between(shell, 'const handleSend = useCallback(', "playSound('send');");
    expect(send).toContain('await startSessionWithPrompt(projectId, sessionId');
    expect(send).toContain('attachedFilesToDataUrlParts(files)');
    expect(send).toContain('throw error;');
    expect(shell).not.toContain('useMessageQueueStore');
    expect(shell).not.toContain('carryDraft(');
    expect(shell).not.toContain('Still starting this session');
  });

  test('the stash carries ONLY the picks — the prompt travels as the row', () => {
    const send = between(shell, 'const handleSend = useCallback(', "playSound('send');");
    expect(send).toContain("prompt: ''");
    // And the shell paints the durable rows, so the bubble survives a reload.
    expect(shell).toContain('useSessionPrompts(projectId, sessionId');
  });

  test('SessionChat carries no shell hand-off machinery any more', () => {
    // The carried-draft workaround existed only for the refusal above.
    expect(chat).not.toContain('useCarriedDraft');
    expect(chat).not.toContain('carriedDraft');
  });
});
