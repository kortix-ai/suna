import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
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

describe('a sent tile keeps one identity from Send to delivery', () => {
  test('every follow-up remembers its submitted attachments before the paint, for its own turn', () => {
    const flat = (source: string) => source.replace(/\s+/g, ' ');
    const send = flat(
      between(chat, 'const handleSend = useCallback(', 'const registerSender = useChatSendStore'),
    );
    const remember = send.indexOf(
      'setSentAttachmentsByMessage((current) => ({ ...current, [messageID]: sentAttachmentsOf(attachedFiles), }));',
    );
    expect(remember).toBeGreaterThan(-1);
    expect(send.indexOf('beginOptimisticSend(sessionId, messageID')).toBeGreaterThan(remember);
    // Every turn, not only the first: the selection (`sentAttachmentsForTurn`, tested in
    // `sent-attachment-previews.test.ts`) keeps the list through a re-minted echo, and falls
    // back to the queued row's names for a turn this tab did not send.
    const turn = flat(between(chat, '<SessionTurn', 'sessionWorking={lastTurnWorking}'));
    expect(turn).toContain(
      'pendingAttachments={sentAttachmentsForTurn({ sentByMessage: sentAttachmentsByMessage, messageId: turn.userMessage.info.id, originId: optimisticOriginOf(sessionId, turn.userMessage.info.id), isFirstTurn: turnIndex === 0, firstTurnHandover: firstTurnHandover?.attachments, firstTurnSent: firstPromptAttachments(projectSessionId), queuedRowAttachments: inboxRowsByMessageId.get( turn.userMessage.info.id, )?.attachments, })}',
    );
    // The first prompt's identities outlive its handover, in the chat and in the boot shell.
    expect(flat(shell)).toContain(
      'attachments: localFiles.length > 0 ? [] : (firstPromptAttachments(sessionId) ?? pendingRowSubmission?.attachments ?? []),',
    );
  });

  test('queued rows draw their files, a session unmount releases previews, and nothing says "Upload failed"', () => {
    // The session's FIRST prompt and Quick Queue rows are painted as turns
    // before the runtime has them; Queue List rows stay above the composer.
    expect(chat).toContain(
      "if (!isFirstPromptRow(prompt) && prompt.placement !== 'transcript') continue;",
    );
    expect(chat).toContain('useEffect(() => retainSentAttachmentPreviews(), []);');
    expect(chat).toContain('sentAttachmentsOf(firstPromptSource.files)');
    expect(chat).not.toContain("'Upload failed'");
    expect(shell).not.toContain("'Upload failed'");
    // The shell projects every durable row after the first, plus the sends it
    // has made that no row carries yet, through the same queue projection.
    expect(shell).toContain('projectQueueRows({');
    expect(shell).toContain('attachments: sentAttachmentsOf(files ?? []),');
  });
});

describe('a send paints first and holds its POST on the handed-off uploads', () => {
  test('follow-up send paints first, delivers detached when it carries uploads, and keeps the message on every later failure', () => {
    const flat = (source: string) => source.replace(/\s+/g, ' ');
    const send = between(chat, 'const handleSend = useCallback(', 'const registerSender = useChatSendStore');
    const paint = send.indexOf('beginOptimisticSend(sessionId, messageID');
    const deliver = send.indexOf('const deliver = async (detached: boolean): Promise<string> => {');
    const wait = send.indexOf('attachmentParts = await attachments.whenReady();');
    const parts = send.indexOf('parts.push(...promptFileParts(attachedFiles, attachmentParts));');
    const post = send.indexOf('promptInbox.enqueue({');
    // The composer's dispatch settles at the paint for a send with uploads, or for
    // a send behind an earlier send of this session (`deliverAfterPaint`, tested in
    // `attachment-submission.test.ts` and `composer-submit-latch.test.ts`). The
    // chain key is the Kortix session id, the key the boot shell and project home use.
    const detach = send.indexOf(
      'return deliverAfterPaint(projectSessionId ?? sessionId, attachments, deliver, messageID, {',
    );
    // Only the inline edit's send (`commitsRewind`) POSTs outside the chain.
    expect(flat(send.slice(detach))).toContain(
      'messageID, { immediate: overrides?.commitsRewind === true, });',
    );
    expect(paint).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(paint);
    expect(wait).toBeGreaterThan(deliver);
    expect(parts).toBeGreaterThan(wait);
    expect(post).toBeGreaterThan(parts);
    expect(detach).toBeGreaterThan(post);
    // A detached send, or a Retry of a kept one, is never taken back.
    expect(send.indexOf('const keepsPainted = detached || retryingKeptSend;')).toBeGreaterThan(
      deliver,
    );
    expect(send).toContain('const retryingKeptSend = overrides?.clientMessageId !== undefined;');
    // The failure is kept in a store outside this component, so a remount
    // (session switch and return) still draws it with Retry. Its reason is
    // localized and never says "Upload failed".
    const kept = flat(between(send, 'const markHeldSendFailed = (error: unknown) => {', 'const deliver = async'));
    expect(kept).toContain('useHeldSendFailureStore.getState().setHeldSendFailure(sessionId, messageID, {');
    // A 4xx refusal shows its own classified words; every other failure its reason copy
    // (`sentFailureMessage`, tested in `attachment-submission.test.ts`).
    expect(kept).toContain('message: sentFailureMessage(error, tComposerAttachments, classified.message),');
    expect(kept).toContain('overrides: { ...overrides, clientMessageId },');
    // An upload that fails after the paint keeps the message: no removal, no draft restore.
    const upload = between(send, 'attachmentParts = await attachments.whenReady();', 'const parts: SessionPromptPart[]');
    expect(upload).toContain('markHeldSendFailed(err);');
    expect(upload).not.toContain('abandonOptimisticSend(');
    expect(upload).not.toContain('throw ');
    // A POST that fails after the paint keeps it too, unless the inbox holds the row.
    const recovery = between(send, '} catch (cause) {', 'recoverFromSendFailure(');
    expect(recovery).toContain('if (keepsPainted) return { ok: false, cause, error: null } as const;');
    const failedPost = between(send, 'if (!result.ok) {', 'setCommandError(result.error);');
    expect(failedPost).toContain('if (!result.error) {');
    expect(failedPost).toContain('if (await inboxRowExists().catch(() => false)) {');
    // A `failed` row with this send's key is a refusal, never proof the send landed
    // (`inboxHoldsLivePrompt`, tested in `inbox-live-prompt.test.ts`).
    expect(between(send, 'const inboxRowExists = async () => {', 'const deliver = async')).toContain(
      'return inboxHoldsLivePrompt(prompts, clientMessageId);',
    );
    expect(failedPost).toContain('markHeldSendFailed(result.cause);');
    expect(chat).not.toContain('setHeldSendFailures');
    // An accepted POST releases the send's uploads.
    const accepted = between(send, 'acceptSendReceipt(messageID);', 'return { ok: true } as const;');
    expect(accepted).toContain('attachments?.release();');
    // The mounted instance reads the store and builds Retry on its own send path.
    expect(chat).toContain(
      'useHeldSendFailureStore((state) => state.failuresBySession[sessionId])',
    );
    expect(chat).toContain(
      'send.text, send.files, send.mentions, send.attachments, send.overrides',
    );
    // The status is built in the prop, and Retry runs at click time: no call
    // during render receives `handleSend`, which reads refs.
    expect(chat).not.toContain('heldSendUploadStatuses');
    expect(chat.replace(/\s+/g, ' ')).toContain(
      'uploadStatus={ heldSendFailures?.[turn.userMessage.info.id] ? {',
    );
    expect(chat.replace(/\s+/g, ' ')).toContain(
      'onRetry: () => retryHeldSend( sessionId, turn.userMessage.info.id, resendHeldSend,',
    );
  });

  test('the boot shell paints the first prompt before its held POST and keeps it, marked failed, when a send with uploads fails', () => {
    const send = between(shell, 'const handleSend = useCallback(', 'const handleCommand = useCallback(');
    const paint = send.indexOf('setSubmission({ text, files: files ?? [] });');
    const held = send.indexOf('void postWhenUploaded(');
    expect(paint).toBeGreaterThan(-1);
    expect(held).toBeGreaterThan(paint);
    // A first send that is not detached paints and mounts the real chat only once its
    // POST is accepted. Until then the hero composer that sent it stays mounted, so a
    // refusal leaves the draft there, mention chips included. A send with uploads is
    // never taken back, so it paints and mounts the chat at once.
    const flat = (source: string) => source.replace(/\s+/g, ' ');
    expect(send).toContain('const detached = !!attachments && deliversDetached(sessionId, attachments);');
    const inline = 'await deliverInOrder(sessionId, () => post([]));';
    const textOnly = send.slice(send.indexOf(inline));
    expect(send.indexOf(inline)).toBeGreaterThan(-1);
    const refused = between(textOnly, '} catch (error) {', 'throw error;');
    expect(refused).not.toContain('setSubmission(');
    expect(refused).not.toContain('setPrefill(');
    expect(flat(textOnly.slice(textOnly.indexOf('throw error;')))).toContain(
      "if (first) { // Only now does the page mount the real chat: the server holds the prompt. playSound('send'); setSubmission({ text, files: files ?? [] }); onSubmit?.(); }",
    );
    expect(send.slice(0, send.indexOf(inline)).match(/onSubmit\?\.\(\)/g)).toHaveLength(1);
    // A send with uploads, or one behind an earlier send of this session, is
    // delivered detached; the ordering itself is tested in
    // `instant-session-shell-delivery.test.tsx`.
    expect(
      between(send, 'if (attachments && detached) {', 'void postWhenUploaded('),
    ).toContain('onSubmit?.();');
    expect(send.replace(/\s+/g, ' ').match(/void postWhenUploaded\( sessionId, attachments,/g)).toHaveLength(2);
    // A later send with uploads keeps its bubble, marked failed, instead of vanishing.
    expect(send.replace(/\s+/g, ' ')).toContain(
      'prev.map((extra) => (extra.id === clientMessageId ? { ...extra, uploadStatus } : extra))',
    );
    // Send time, not POST time: a message sent while the uploads run is
    // ordered after this one.
    const stamp = send.indexOf('const sentAtMs = Date.now();');
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(held);
    expect(
      between(send, 'const post = async', 'if (attachments && detached) {'),
    ).toContain('clientSentAtMs: sentAtMs,');
    // The failed status lives in the first-prompt preview, which SessionChat
    // also draws, so it survives the crossfade that unmounts this shell.
    expect(send).toMatch(
      /useFirstPromptPreviewStore\s*\.getState\(\)\s*\.setFirstPromptPreview\(sessionId, text, files \?\? \[\], uploadStatus\)/,
    );
    expect(shell).toContain(
      'uploadStatus: previewSubmission?.uploadStatus ?? pendingRowSubmission?.uploadStatus,',
    );
    expect(chat.replace(/\s+/g, ' ')).toContain(
      'uploadStatus={firstPromptSource.uploadStatus ?? firstPromptUploadStatus}',
    );
    // The hero composer remounts when the thread appears, so the shell owns the
    // upload controller that the held send and its Retry use.
    expect(shell).toContain('const promptAttachments = usePromptAttachments(projectId);');
    expect(shell).toContain('promptAttachments={promptAttachments}');
  });
});

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

  test('the queued list reads the SERVER hold, which every tab can see', () => {
    // REWRITTEN when the queue moved out of the transcript: queued entries are
    // listed above the composer. The paused state is the server's
    // hold count, never a tab-local flag.
    expect(chat).toContain('<QueuedPromptList');
    expect(chat).toContain('heldCount={queueRows.heldCount}');
    expect(chat).not.toContain('<QueuedPromptBubbles');
    expect(chat).not.toContain('queuePaused=');
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
    // The edit's send commits its own staged revert, so it POSTs at once instead
    // of behind an earlier Send still waiting in the session's delivery chain.
    expect(rewind).toContain('const editSend = { commitsRewind: true };');
    const sendAt = rewind.indexOf(
      'await handleSend(text, undefined, undefined, undefined, editSend)',
    );
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

describe('queue row actions address the inbox that holds the row', () => {
  test('there is no per-row "send now": reordering is a non-goal, and Resume releases the hold', () => {
    expect(chat).not.toContain('handleQueueSendNow');
    expect(chat).not.toContain('stopThenSendNow');
    const resume = between(chat, 'const handleResumeQueue = useCallback(', '}, [promptInbox.hold]);');
    expect(resume).toContain('promptInbox.hold(false)');
    expect(resume).toContain('setResumePending(false)');
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
    expect(retry).toMatch(/promptInbox\s*\.retry\(id\)/);
  });
});

describe('ONE prompt = ONE id = ONE bubble, from Enter', () => {
  test('Enter paints the transcript immediately; explicit queue intent paints the composer', () => {
    const send = between(chat, "playSound('send');", 'const receiptTurnId');
    expect(send).toContain(
      'const messageID = mintSessionWireMessageId(sessionId, clientMessageId);',
    );
    expect(send).toContain("const paintTranscript = placement === 'transcript';");
    expect(send).toContain('isBusyRef.current || promptInbox.prompts.some(');
    expect(send).toMatch(
      /if \(!paintTranscript\) \{\s*useQueuedDraftStore\.getState\(\)\.add\([\s\S]*\} else \{\s*beginOptimisticSend\(sessionId, messageID, optimisticText, \[textPartId\]\);/,
    );
    // A composer entry never marks a transcript bubble it never painted.
    expect(chat).toContain('if (paintTranscript) markOptimisticSendDispatched(sessionId, messageID);');
    expect(chat).not.toContain('willWaitInInbox');
  });

  test('the row carries the SAME id, and the bubble is inbox-backed from dispatch (never swept)', () => {
    const send = between(chat, 'const result = await (async () => {', 'if (!result.ok) {');
    expect(send).toContain('messageId: messageID,');
    expect(send).toContain('recoverFromSendFailure(sessionId, messageID, cause');
    // Marked in the SAME tick as the paint, before the first await: an idle
    // frame from a short previous turn used to sweep the bubble mid-send.
    const paint = between(
      chat,
      'beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);',
      'setFreshSend(',
    );
    expect(paint).toContain('markOptimisticSendInboxBacked(sessionId, messageID);');
  });

  test('a row already on screen — by id, by re-mint alias, or by elimination — is never a queued bubble', () => {
    expect(chat).toContain('store.optimisticOriginOf(sessionId, message.info.id)');
    // The set the queue projection reads is the id set PLUS the row claimed by
    // elimination (`claimFirstTurnRow`). The ids alone are not enough for the
    // one window where the drain has re-minted and this tab has not polled
    // since: the transcript holds the message under an id the cached row does
    // not report, so every id clause misses and the prompt renders twice.
    expect(chat).toContain('transcriptMessageIds: transcriptClaimedIds');
    expect(chat).toContain('const transcriptClaimedIds = useMemo(');
    expect(chat).toContain('ids.add(firstTurnClaim.rowMessageId);');
  });

  test('the synthetic turns read the same claimed set, so both surfaces agree', () => {
    // One decision, every consumer: if the two disagreed, the row would be
    // hidden from the strip and still minted as a turn, or the reverse.
    // The queue list above the composer is projected from that set...
    expect(chat).toContain('transcriptMessageIds: transcriptClaimedIds,');
    // ...and the synthetic turns are built from the very same one.
    expect(chat).toContain(
      'if (prompt.message_id && transcriptClaimedIds.has(prompt.message_id)) continue;',
    );
    const projection = readFileSync(
      fileURLToPath(new URL('./queue-projection.ts', import.meta.url)),
      'utf8',
    );
    expect(projection).toContain('if (onScreen(prompt, input.transcriptMessageIds)) continue;');
    // ANY of the prompt's ids counts, or a re-mint hides a row from one surface
    // and not the other.
    expect(projection).toContain(
      '(prompt.message_id && transcriptIds.has(prompt.message_id)) ||',
    );
    expect(projection).toContain(
      '(prompt.wire_message_id && transcriptIds.has(prompt.wire_message_id)) ||',
    );
  });

  test('the claimed bubble keeps its queued dimming', () => {
    // Hiding the duplicate must not let the surviving copy read as running
    // while the server still holds the prompt.
    expect(chat).toContain('if (firstTurnClaim) ids.add(firstTurnClaim.messageId);');
  });

  test('the re-mint alias is announced from an EFFECT, never from the memo that reads it', () => {
    // `registerOptimisticEcho` writes to the sync store: it retires the bubble
    // the row names when the runtime's echo has already landed unmatched,
    // which a burst of queued prompts makes the ordinary case. Called from a
    // `useMemo`, that write lands during render and re-renders every
    // subscriber mid-render.
    const effect = between(
      chat,
      'const store = useSessionStateStore.getState();\n    for (const prompt of promptInbox.prompts) {',
      '}, [promptInbox.prompts, sessionId]);',
    );
    expect(effect).toContain('store.registerOptimisticEcho(');
    const queueRows = between(chat, 'const queueRows = useMemo(', 'const canTakeBackQueue');
    expect(queueRows).not.toContain('registerOptimisticEcho');
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

describe('Up takes the queue back into the composer', () => {
  test('only what the server actually removed comes back, in queue order, above the draft', () => {
    const takeBack = between(
      chat,
      'const handleTakeBackQueue = useCallback(',
      '// ---- Triple-ESC to stop ----',
    );
    expect(takeBack).toContain('row.takeBackEligible');
    // Drafts are read BEFORE the removals: removing a row prunes its draft.
    expect(takeBack.indexOf('useQueuedDraftStore.getState().bySession[sessionId]')).toBeLessThan(
      takeBack.indexOf('promptInbox.remove(row.id)'),
    );
    expect(takeBack).toContain('Promise.allSettled(');
    expect(takeBack).toContain('composeTakeBack({ removed, drafts })');
    expect(takeBack).toContain('.setPrefill(sessionId, text, files)');
    // Anything that cannot come back losslessly goes back to the queue.
    expect(takeBack).toContain('restoreQueuedMessage(prompt,');
  });

  test('the composer gets the key handler and the hint', () => {
    expect(chat).toContain('onArrowUpAtStart={() => handleTakeBackQueue()}');
    // The hint shows only while there is something Up would take back.
    expect(chat).toMatch(/hint=\{\s*canTakeBackQueue \?/);
  });

  test('first and Enter prompts are drawn as turns before the runtime has them', () => {
    const synthetic = between(
      chat,
      'const queuedSyntheticMessages = useMemo(',
      'const rawTurns = useMemo(',
    );
    expect(synthetic).toContain("if (!isFirstPromptRow(prompt) && prompt.placement !== 'transcript') continue;");
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
    const promptBranch = between(
      composer,
      'const reset = resolveComposerResetOnSend(',
      'const dispatchSubmissionRef = useRef',
    );
    expect(promptBranch).toContain(
      'onSend(trimmed, filesToSend, mentionsToSend, attachmentSubmission, placement)',
    );
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
  test('every shell send — first or second — is a durable row, POSTed once its uploads are ready', () => {
    // Three answers preceded this, in order: `return` outright (the draft was
    // simply gone); a browser-local queue (lost with the tab); then a refusal
    // with a toast and a carried draft, because the FIRST message travelled
    // through the start stash and a row POSTed during boot would have been
    // admitted before it. The first message is an inbox row NOW, so ordering
    // is the server's (available_at, created_at) and the refusal is gone: a
    // second message simply POSTs. AWAITED and thrown on failure, so the
    // composer's own recovery restores the draft for a message the server
    // never got.
    const send = between(shell, 'const handleSend = useCallback(', 'const handleCommand = useCallback(');
    expect(send).toContain('await startSessionWithPrompt(projectId, sessionId');
    expect(send).toContain('promptFileParts(files, attachmentParts)');
    expect(send).toContain('throw error;');
    expect(shell).not.toContain('useMessageQueueStore');
    expect(shell).not.toContain('carryDraft(');
    expect(shell).not.toContain('Still starting this session');
  });

  test('ready-session sends carry handle-only attachment parts and never upload at Send', () => {
    expect(chat).toContain('parts.push(...promptFileParts(attachedFiles, attachmentParts));');
    expect(chat).toContain('attachment_id: p.attachment_id');
    expect(chat).not.toContain("from '@/features/files/api/runtime-files'");
  });

  test('the stash carries ONLY the picks — the prompt travels as the row', () => {
    const send = between(shell, 'const handleSend = useCallback(', 'const handleCommand = useCallback(');
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
