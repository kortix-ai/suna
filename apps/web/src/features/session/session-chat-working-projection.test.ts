import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source assertions, for the same reason as `session-chat-inbox-queue.test.ts`:
// `SessionChat` is a 4k-line component with no DOM harness in this app, and the
// wiring under test is which value reaches which call. `between()` FAILS on a
// missing anchor rather than yielding '' and passing.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/**
 * The composer used to answer "is this session working?" four ways at once: the
 * SSE status slot, a `pendingSendInFlight` boolean, a 30s timer that cleared
 * that boolean when no acknowledgement arrived, and a 5s grace window on the
 * polling fallback. When the answer got stuck, none of them could be blamed.
 * There is one answer now, and it carries its own provenance.
 */
describe('the composer reads ONE working answer', () => {
  test('busy is the projection, not the status slot this tab can miss frames from', () => {
    const busy = between(chat, 'const working = useSessionWorking(', 'const isServerBusy =');
    expect(chat).toContain("const isServerBusy = working.state === 'working';");
    expect(busy).toContain('runtimeSessionId: sessionId');
    // The receipt is NOT a prop. Both this component and `useSession` mount a
    // projection for the same session and share one `/turn` cache entry; two
    // private receipts meant the observer without one wrote an uninformed read
    // into that entry and flipped this composer to idle mid-send.
    expect(busy).not.toContain('optimistic:');
    expect(chat).toContain('useSessionWorkingStore');
  });

  test('no local timer decides busy any more', () => {
    // The exact two that latched: a 30s "clear it anyway" backstop, and a 5s
    // grace that kept polling because an idle status might predate the send.
    expect(chat).not.toContain('setPendingSendInFlight');
    expect(chat).not.toContain('lastSendTimeRef');
    expect(chat).not.toContain('30_000');
  });

  test('the send receipt names the optimistic turn only when the session was idle', () => {
    const send = between(
      chat,
      'const clientMessageId = overrides?.clientMessageId',
      'return messageID;',
    );
    expect(send).toContain(
      'const receiptTurnId = sendingIntoRunningTurn ? workingTurnIdRef.current : messageID;',
    );
    expect(send).toContain('noteSendReceipt(messageID, receiptTurnId)');
    // Acceptance is what lets a `/turn` read answer for the send AT ALL: until
    // `POST .../prompts` returns there is no row for it to see.
    expect(send).toContain('acceptSendReceipt(messageID)');
    expect(send).toContain('clearSendReceipt(messageID)');
    expect(send).not.toContain('noteSendReceipt(clientMessageId)');
    expect(send).not.toContain('acceptSendReceipt(clientMessageId)');
    expect(send).not.toContain('clearSendReceipt(clientMessageId)');
  });

  test('the receipt is dropped on every path where nothing is coming', () => {
    // It is not a latch — `projectWorking` outranks it with any observation
    // issued after it, and `OPTIMISTIC_RECEIPT_MAX_MS` bounds the case where
    // none ever arrives. These are the paths that know nothing is coming.
    const reset = between(chat, '// Reset on session change', 'setRewindTarget(null);');
    expect(reset).toContain('clearSendReceipt()');
  });

  test('Stop drops the receipt with the turn', () => {
    const stop = between(chat, 'const handleStop = useCallback(', 'issueSessionCancel();');
    expect(stop).toContain('clearSendReceipt()');
  });

  test('the FIRST prompt of a session is a durable row, never a client replay', () => {
    // The stash-replay effect (a 30s readiness poll, an optimistic bubble its
    // own timeout path never cleared, per-send receipt bookkeeping) is GONE:
    // the first prompt is a durable inbox row before this component mounts —
    // created server-side from `create.pending_prompt`, or POSTed by the SDK's
    // `startSessionWithPrompt`, which files the same receipts `handleSend`
    // does. Only the PICKS still travel through the stash, and a legacy
    // full-prompt stash is POSTed to the inbox rather than dropped.
    expect(chat).not.toContain('replayStartStash');
    expect(chat).not.toContain('optimisticPrompt');
    const seeding = between(
      chat,
      'const stash = readStartStash(sessionId);',
      '}, [sessionId, projectId, projectSessionId]);',
    );
    expect(seeding).toContain('clearStartStash(sessionId)');
    expect(seeding).toContain('startSessionWithPrompt(projectId, projectSessionId');
  });

  test('a slash command accepts its receipt when the command settles', () => {
    // Nothing ever accepted a command's receipt either, and commands do not go
    // through the inbox — so for a full minute after every `/compact` the
    // control plane's own "no turns" answer was discarded. The old machine this
    // replaced released at 30s; unaccepted, this was twice that.
    const command = between(
      chat,
      'const handleCommand = useCallback(',
      'setTimeout(() => scrollToBottom()',
    );
    expect(command).toContain('noteSendReceipt(label)');
    expect(command).toContain('acceptSendReceipt(label)');
    expect(command).toContain('clearSendReceipt(label)');
  });

  test('every send failure names the send it is dropping', () => {
    // `clearSendReceipt` is keyed by session, so an unguarded clear from an
    // older send's failure deleted a NEWER send's receipt while its POST was
    // still on the wire.
    const send = between(
      chat,
      'const clientMessageId = overrides?.clientMessageId',
      'return messageID;',
    );
    expect(send).toContain('clearSendReceipt(messageID)');
  });

  test('the stop is a receipt of its own, settled by the cancel it issues', () => {
    // `applyOptimisticAbort` writes an idle status frame, which invalidates the
    // `/turn` query — and the read that comes back still shows the doomed turn,
    // because the cancel needs ~1.6s to reach the daemon. Without a stop
    // receipt the composer flipped Send back to Stop ~120ms after the click.
    const cancel = between(chat, 'const issueSessionCancel = useCallback(', 'return settlement;');
    expect(cancel).toContain('noteAbortReceipt(');
    expect(cancel).toContain('settleAbortReceipt(');
  });

  test('the waking notice is suppressed by an OPEN TURN, never by a queued inbox row', () => {
    // `working.source === 'server'` is also true for a durable inbox row with
    // nothing running, which is precisely the state the notice exists for.
    // `serverHoldsOpenTurn` reads `serverOpenTurnToken`, the field the projection
    // documents as the control plane's live authority.
    const readiness = between(chat, 'const composerReadiness = sessionComposerReadiness(', '});');
    expect(readiness).toContain('serverTurnLive: serverHoldsOpenTurn(working)');
    expect(readiness).not.toContain("working.source === 'server'");
  });

  test('suppressing the notice never leaves an UNREACHABLE runtime with nothing on screen', () => {
    // The connection store's own verdict, not an inference. An open turn plus a
    // runtime that stopped answering is a real state that lasts up to the 240m
    // turn grant, and it needs its own line.
    const readiness = between(chat, 'const composerReadiness = sessionComposerReadiness(', '});');
    expect(readiness).toContain('runtimeUnreachable');
    expect(chat).toContain("useRuntimeConnectionStore((s) => s.status === 'unreachable')");
  });

  test('the command gate reads the turn TOKEN, so a `/` command sees its own turn', () => {
    // `message_id` is null for every `/` command's turn (`buildSessionCommandInput`
    // sends no `messageID`), so keying this gate on it left it permanently open
    // for the exact producer it guards.
    expect(chat).toContain('working.serverOpenTurnToken !== null');
    expect(chat).not.toContain('working.serverOpenTurnId');
  });

  test('a `/` command still refuses to go out into a turn that is mid-retry', () => {
    // REWRITTEN with the queue drain's deletion. This gate used to hold the
    // browser drain shut; the drain is gone, but the hazard is not — a command
    // is dispatched by `runCommand` with no server admission gate, and a
    // retryable provider error keeps the SAME assistant message being written
    // with no busy frame to show for it. It now feeds the composer's
    // `sessionWorking`, which is what refuses the command.
    //
    // REWRITTEN again when the redundant OR was removed (55ee4e2981):
    // `sessionWorking={effectiveBusy || hasRetryingAssistant}` collapsed to
    // `sessionWorking={effectiveBusy}` because `effectiveBusy` is now built by
    // `resolveEffectiveBusy({ isServerBusy, isOptimisticCompacting,
    // hasRetryingAssistant })` — the retry predicate already folds into it, so
    // the composer reads one value instead of re-ORing a term it already
    // contains. Pin BOTH links of the chain so this test can still fail if
    // either is severed: the retry predicate must flow into the
    // `resolveEffectiveBusy` call, and the composer must read `effectiveBusy`.
    expect(chat).toContain('hasRetryingAssistantTurn(messages)');
    const busyResolution = between(
      chat,
      'const effectiveBusy = resolveEffectiveBusy({',
      '});',
    );
    expect(busyResolution).toContain('hasRetryingAssistant');
    expect(chat).toContain('sessionWorking={effectiveBusy}');
  });
});

/**
 * The turn card reads the SAME answer the composer does. It used to compute its
 * own from the raw SSE slot (`getWorkingState(sessionStatus, isLast)`), so a
 * dropped end-of-turn frame shimmered the last turn over a finished answer for
 * ever while the composer beside it — projection-backed — correctly read idle.
 */
describe('the turn card reads the same working answer', () => {
  test('the WORKING turn shimmers from the projection; any other turn NEVER works', () => {
    // Not "the last turn": a prompt queued mid-turn is the last user message
    // while the agent still streams the turn before it — `resolveWorkingTurn`
    // picks the turn, the projection says whether it works.
    const turn = between(chat, 'function SessionTurnImpl(', 'const activeAssistantMessage');
    expect(turn).toContain('isWorkingTurn && sessionWorking');
    // The raw slot no longer decides any turn's shimmer inside the card.
    expect(turn).not.toContain('getWorkingState(');
  });

  test('the parent computes lastTurnWorking ONCE, with the child-session split', () => {
    // `resolveLastTurnWorking` (session-composer-readiness.ts) carries the
    // behavior tests; this pins that the component actually calls it and feeds
    // the projection-backed delay-hidden `isBusy` as the Kortix answer.
    expect(chat).toContain('resolveLastTurnWorking({');
    expect(chat).toContain('isChildSession');
    expect(chat).toContain('sessionWorking={lastTurnWorking}');
    expect(chat).toContain(
      'resolveWorkingTurn({ turns, hintMessageId: working.turnId, unrunTurnIds })',
    );
  });

  test('retry copy keeps the raw frame — the projection does not carry the reason', () => {
    const turn = between(chat, 'function SessionTurnImpl(', '// Cost info');
    expect(turn).toContain('getRetryInfo(sessionStatus)');
    expect(turn).toContain('getRetryMessage(sessionStatus)');
  });

  test('"Send now" decides from the projection, not the raw slot', () => {
    // Both failure directions were real: a stale-idle slot dispatched into a
    // live turn (OpenCode answers that by aborting it — the "Interrupted"
    // symptom), and a stale-busy slot issued a spurious Stop that held the
    // whole inbox.
    const sendNow = between(chat, 'const handleQueueSendNow = useCallback(', 'stop: async ()');
    expect(sendNow).toContain('isRunning: () => serverHoldsOpenTurn(working)');
    expect(sendNow).not.toContain('useSessionStateStore.getState()');
  });

  test('the composer honors the server admission verdict — a failed row cannot pose as a sent prompt', () => {
    // A deduped re-POST of a clientMessageId whose row already dead-lettered
    // answers 200 with state 'failed'. Discarding the result accepted the
    // receipt, cleared the draft, and told the user nothing.
    const send = between(
      chat,
      'const created = await promptInbox.enqueue({',
      'return { ok: true }',
    );
    expect(send).toContain("created.state === 'failed'");
    // No after-the-fact bubble for a prompt sent while a turn is live: the
    // server HOLDS it (one prompt = one turn), so it belongs in the strip
    // until its own turn starts.
    expect(chat).not.toContain('correctedWillWait');
  });
});
