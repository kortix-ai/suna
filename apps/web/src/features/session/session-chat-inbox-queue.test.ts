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

/**
 * Whitespace stripped, so a formatter re-wrapping a condition cannot break an
 * assertion about it. That has already happened twice in this file: Prettier
 * moved a `&&` onto its own line and a `toContain` on the joined text went red
 * without a single behaviour changing. Structure is what these tests are
 * about; spacing is not.
 */
function nows(source: string): string {
  return source.replace(/\s+/g, '');
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
    expect(sendNow).toMatch(/promptInbox\s*\.retry\(id\)/);
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
      // The next declaration after the retry handler. It used to be the
      // stashed-command effect; the queue's own handlers were moved between
      // them, and an end anchor past those would sweep THEIR `clientMessageId`
      // (`handleDuplicateQueuedMessage` mints a fresh one) into this slice.
      '   * DUPLICATE A PARKED ROW',
    );
    expect(retry).not.toContain('localIds');
    expect(retry).toMatch(/promptInbox\s*\.retry\(id\)/);
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
    expect(send).toContain(
      'const messageID = mintSessionWireMessageId(sessionId, clientMessageId);',
    );
    expect(send).toContain(
      'beginOptimisticSend(sessionId, messageID, optimisticText, [textPartId]);',
    );
    expect(send).not.toContain('willWaitInInbox');
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
      'const sendingIntoRunningTurn',
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
    //
    // They used to disagree. This reader matched `message_id` and
    // `wire_message_id`; `projectQueueRows` matched those AND
    // `client_message_id` — the only handle that survives both a re-mint and a
    // reload. So the case the third clause exists for still drew a duplicate,
    // in exactly the reader that paints the bubbles. Both now call ONE
    // predicate, which is what makes "the same claimed set" a fact rather than
    // two lists that happen to look alike.
    expect(chat).toContain('if (promptIsOnScreen(prompt, transcriptClaimedIds)) continue;');
    expect(chat).toContain(
      "import { countHaltableInboxPrompts, projectQueueRows, promptIsOnScreen } from './queue-projection';",
    );
    // And the shared predicate is the one that reads all three ids.
    const projection = readFileSync(
      fileURLToPath(new URL('./queue-projection.ts', import.meta.url)),
      'utf8',
    );
    expect(projection).toContain('export function promptIsOnScreen(');
    expect(projection).toContain('transcriptMessageIds.has(prompt.client_message_id)');
  });

  test('the claimed bubble keeps its row: controls, and its queued dimming', () => {
    // Hiding the duplicate must not cost the surviving copy the chrome the row
    // is the only source of (the X, send-now, retry, its error) nor let it read
    // as running while the server still holds the prompt.
    expect(chat).toContain('byId.set(firstTurnClaim.messageId, claimed);');
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
    const rowsByMessageId = between(
      chat,
      'const inboxRowsByMessageId = useMemo(() => {',
      'const queueRows = useMemo(',
    );
    expect(rowsByMessageId).not.toContain('registerOptimisticEcho');
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
    const promptBranch = between(
      composer,
      'const reset = resolveComposerResetOnSend(',
      '} catch {',
    );
    // The 4th argument is the submit INTENT (Enter runs, Cmd+Enter queues) —
    // see `composer/send-intent.ts`. It is not a queue decision made here: the
    // host still POSTs every prompt to the durable inbox either way; the intent
    // only says whether a running turn is interrupted first.
    expect(promptBranch).toContain('await onSend(trimmed, filesToSend, mentionsToSend, intent)');
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
    expect(send).toContain('stageFirstPromptAttachments(files)');
    expect(send).toContain('throw error;');
    expect(shell).not.toContain('useMessageQueueStore');
    expect(shell).not.toContain('carryDraft(');
    expect(shell).not.toContain('Still starting this session');
  });

  test('ready-session sends retain the workspace upload path', () => {
    expect(chat).toContain(
      'buildPromptPartsWithUploads(textPrompt.text, attachedFiles, uploadFile)',
    );
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

/**
 * AN IN-FLIGHT ROW IS INERT — the rule `projectQueueRows` documents and the
 * transcript never implemented.
 *
 * `projectQueueRows` collects `delivering` and `optimistic:` rows into
 * `inFlightIds` so the strip can render them "INERT: every action the strip
 * offers is refused by the server for a row it has already handed to OpenCode"
 * (queue-projection.ts). That list reaches `QueuedPromptBubbles` — which
 * `SessionChat` renders with `queued={[]}`, so it can never match anything.
 * The transcript-turn path that replaced the strip never carried the rule over.
 *
 * The consequence is a live X on a row with no server id: `DELETE
 * /prompts/optimistic:cli_…` fails the route's id regex (r8.ts accepts a uuid
 * or `msg_…`) and answers 400 for a prompt the server has never seen.
 */
describe('a row the server has not acknowledged offers no controls', () => {
  test('an optimistic row is excluded from the queue-action id', () => {
    // The bubble is painted on Enter, before `POST .../prompts` returns. Until
    // the server answers there is no id any action can name.
    expect(chat).toContain('const rowIsInFlight = !!queueRow && isOptimisticSessionPrompt(queueRow);');
    expect(chat).toContain('!rowIsInFlight &&');
  });

  test('the optimistic prefix is never handed to a route that rejects it', () => {
    // Defence in depth: even if a caller does pass one, the SDK cancels it
    // locally instead of issuing a request that cannot succeed.
    const sdk = readFileSync(
      fileURLToPath(
        new URL('../../../../../packages/sdk/src/react/use-session-prompts.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(sdk).toContain('if (isOptimisticSessionPrompt({ prompt_id: promptId }))');
  });
});

/**
 * THE THREE WIRINGS THAT FAIL SILENTLY.
 *
 * Each one is a single expression whose removal breaks the feature without
 * breaking anything visible in a test that renders the list: the cap would
 * start refusing ordinary chat, Duplicate would create nothing at all, and
 * Move to top would fire a request the server has nothing to persist. None of
 * the three can be reached from a DOM harness this app does not have, so they
 * are pinned here, in the same source-slice style as the rest of the file, and
 * every assertion runs over `nows()`.
 */
describe('the queue wirings a regression would hide', () => {
  test('ONLY a queued submission meets the cap — plain Enter is never capped', () => {
    // The cap counts PARKED rows. A plain Enter is not one: it waits in the
    // transcript, where depth is not something the user manages. Drop the
    // `isQueuedSubmission(intent) &&` and ordinary chat starts refusing the
    // eleventh message of the session with "Queue full".
    const gate = between(chat, "intent: ComposerSubmitIntent = 'run',", 'let text = rawText;');
    expect(nows(gate)).toContain(
      'isQueuedSubmission(intent)&&queueIsAtCap(parkedQueue.live.length)',
    );
    // And the cap is consulted exactly once on this path, so there is no
    // second, ungated copy of it above the send.
    expect(nows(gate).split('queueIsAtCap(')).toHaveLength(2);
  });

  test('Duplicate mints a FRESH clientMessageId — the source row’s would dedupe into it', () => {
    // `clientMessageId` is the inbox's idempotency key
    // (`POST .../prompts` in r8.ts). Re-POSTing the row's own key returns the
    // row it came from, so the "copy" creates nothing and the menu item reads
    // as broken while erroring nowhere.
    const dup = between(
      chat,
      'const handleDuplicateQueuedMessage = useCallback(',
      'const handleMoveQueuedMessageToTop',
    );
    expect(nows(dup)).toContain("constclientMessageId=ascendingId('msg')");
    // The minted id is what the payload carries, by shorthand.
    expect(nows(dup)).toMatch(/enqueue\(\{[^}]*clientMessageId,/);
    // Never the row's own id, under any spelling.
    expect(nows(dup)).not.toMatch(/clientMessageId:(?:row\.)?id\b/);
    expect(nows(dup)).not.toMatch(/clientMessageId:row\.clientMessageId\b/);
  });

  test('Duplicate refuses a row it cannot copy faithfully', () => {
    // A capped preview or a row with files copies into something that is not
    // the message on screen. The menu disables the item; this is the same
    // refusal at the only place that can create the row.
    const dup = between(
      chat,
      'const handleDuplicateQueuedMessage = useCallback(',
      'const handleMoveQueuedMessageToTop',
    );
    const guardAt = nows(dup).indexOf('if(!canDuplicateRow(row))return;');
    const enqueueAt = nows(dup).indexOf('promptInbox.enqueue(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(enqueueAt).toBeGreaterThan(guardAt);
  });

  test('Move to top issues NO request when the order would not change', () => {
    // `nextQueueOrderAfterMoveToTop` returns null for a row already first and
    // for a row that is not in the list. Both are no-ops the server has
    // nothing to persist — and a reorder fired for a row that never moved is
    // the drag that appears to re-trigger itself.
    const move = between(
      chat,
      'const handleMoveQueuedMessageToTop = useCallback(',
      'ARROW-UP ON AN EMPTY COMPOSER',
    );
    const flat = nows(move);
    expect(flat).toContain('constnext=nextQueueOrderAfterMoveToTop(');
    const guardAt = flat.indexOf('if(!next)return;');
    expect(guardAt).toBeGreaterThan(-1);
    // Nothing leaves the browser before the guard: no request, no analytics.
    expect(flat.indexOf('promptInbox.reorder(')).toBeGreaterThan(guardAt);
    expect(flat.indexOf('track(')).toBeGreaterThan(guardAt);
  });
});

/**
 * THE ERROR HALT PROTECTS THE WHOLE INBOX, NOT ONE LANE.
 *
 * A turn that ends in failure holds the inbox, so the next prompt is not
 * answered by the same broken session. The gate counted `parkedQueue.live` —
 * `queued_by_user` rows only — so a failure with nothing but ENTER-queued rows
 * behind it held nothing at all and they drained straight into the failure.
 * The server does not catch it either: `turnCompletionAllowsQueuePromotion`
 * passes on `closed`, and an errored turn is closed.
 */
describe('the error halt protects the whole inbox, not one lane', () => {
  const halt = () =>
    nows(
      between(
        chat,
        'const queueErrorHoldTurnRef = useRef<string | null>(null);',
        'const handleRetryQueueAfterError',
      ),
    );

  test('the halt gate counts EVERY live row, not just the parked ones', () => {
    expect(halt()).toContain('if(liveInboxCount===0)return;');
    // The bug, named: this lane filter is what made half the queue unprotected.
    expect(halt()).not.toContain('parkedQueue.live');
    expect(halt()).toContain('promptInbox.hold(true)');
  });

  test('`liveInboxCount` is the whole inbox, minus the rows that already gave up', () => {
    const memo = nows(between(chat, 'const liveInboxCount = useMemo(', '// Associate stashed'));
    expect(memo).toContain('countHaltableInboxPrompts(promptInbox.prompts)');
  });

  test('one hold per failed turn — the ref guard is what stops it storming', () => {
    // `queueFailedTurnId` is true for every render until the next turn starts,
    // so an unguarded effect re-POSTs the hold on every poll tick.
    expect(halt()).toContain('queueErrorHoldTurnRef.current===queueFailedTurnId');
    expect(halt()).toContain('queueErrorHoldTurnRef.current=queueFailedTurnId;');
  });

  test('a user Stop is still not a failure — the exclusion lives in newestFailedTurnId', () => {
    // Asserted properly in `queue-run-state.test.ts`; pinned here so the halt
    // cannot be rewired to a "did the turn end badly?" signal that counts an
    // abort. Stopping is the user getting what they asked for.
    expect(nows(chat)).toContain('constqueueFailedTurnId=useMemo(()=>newestFailedTurnId(turns)');
  });
});

/**
 * A PARKED ROW SAYS SO. The list's pin, its screen-reader position label, and
 * `runsNextId`'s refusal to mark a parked row all read one flag — and nothing
 * ever set it, so an all-parked list labelled its top row "Runs next": a
 * promise the drain does not keep, and the exact statement `runsNextId` exists
 * to prevent.
 */
describe('the parked queue marks its rows parked', () => {
  test('the producer sets `parked` from the row being HELD, not from its lane', () => {
    const memo = nows(
      between(chat, 'const parkedQueue = useMemo(() => {', 'return { live, failed: failedRows'),
    );
    // From `reason`, because those are different questions: every row here is
    // `queued_by_user`, but "Send now" releases one while leaving the flag on
    // it — and that row IS next.
    expect(memo).toContain("...(prompt.reason==='held'?{parked:true}:{})");
  });
});

/**
 * AN EDIT MUST NOT DESTROY A PROMPT WITH NO WAY BACK.
 *
 * There is no PATCH for an inbox row, so an edit is a hard DELETE plus a fresh
 * enqueue. When the enqueue failed, the handler showed one toast and returned —
 * and `removed`, the only lossless copy of the original parts, files and
 * overrides, went out of scope. The plain remove path offers a 5s Undo for
 * exactly that destruction; an edit that failed halfway owes the same.
 */
describe('a failed edit still owes the user their message', () => {
  const edit = () =>
    nows(
      between(
        chat,
        'const handleEditQueuedMessage = useCallback(',
        'const handleReorderQueuedMessage',
      ),
    );

  test('a refused enqueue offers the same Undo the remove path does', () => {
    expect(edit()).toContain('createQueueUndoAction({removed,');
    expect(edit()).toContain('enqueue:promptInbox.enqueue,');
  });

  test('the reorder is its own failure, so it cannot swallow the enqueue error', () => {
    // Folded into one `try`, a refused REORDER — with the new row already
    // created — would have offered an Undo that re-creates the original
    // alongside the edit. Two copies, under a button that says "Undo".
    const body = edit();
    expect(body.indexOf('createQueueUndoAction')).toBeLessThan(body.indexOf('promptInbox.reorder'));
    // Its own message, too: "Could not restore that prompt" would name the
    // undo, which is not what failed. ('Edited, but could not restore its
    // position'.)
    expect(body).toContain('text3674c4c553af');
    expect(body.indexOf('text3674c4c553af')).toBeGreaterThan(body.indexOf('promptInbox.reorder'));
  });

  test('the re-enqueue keeps the row in ITS OWN lane, not a hardcoded parked one', () => {
    // "Send now" releases a parked row and leaves `queued_by_user` on it.
    // Re-parking it because the user fixed a typo would take it back out of the
    // drain behind their back.
    expect(edit()).toContain('...(removed.queued_by_user?{queuedByUser:true}:{}),');
    expect(edit()).not.toContain('queuedByUser:true,');
  });
});
