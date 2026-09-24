import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';
import { busyRowTurnPresentation, resolveBusyRow } from './turn/working-turn';

// Source assertions, same rationale as `session-chat-working-projection.test.ts`:
// `SessionChat` is a 5k-line component with no DOM harness in this app, and what
// is under test is which condition reaches which render. Every slice is taken
// through `between()`, which FAILS on a missing anchor rather than yielding ''
// and passing.
const chat = readFileSync(fileURLToPath(new URL('./session-chat.tsx', import.meta.url)), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

/**
 * A busy session always says so somewhere.
 *
 * `resolveWorkingTurn` declines to name a working turn in two legitimate
 * states — every prompt still held by the server with no answer yet, and a
 * finished answer with queued prompts under it — and in both the transcript
 * used to fall silent while the composer showed Stop. On the 2026-09-06
 * recording that was ~11s on a new session's first prompt and ~1s on the
 * second: the session read as INACTIVE with the user's prompt in flight.
 */
const turn = (id: string, ...assistant: Array<'open' | 'done'>) => ({
  userMessage: { info: { id } },
  assistantMessages: assistant.map((state) => ({
    info: state === 'done' ? { time: { completed: 1 }, finish: 'stop' } : { time: {} },
  })),
});
const row = (id: string, state = 'waiting') => ({
  prompt_id: `p_${id}`,
  state,
  message_id: id,
  wire_message_id: id,
});
type Input = Parameters<typeof resolveBusyRow<ReturnType<typeof turn>, ReturnType<typeof row>>>[0];
const busyInput = (over: Partial<Input>): Input => ({
  turns: [],
  prompts: [],
  projection: { state: 'working', turnId: null },
  freshSendTurnId: null,
  lastTurnWorking: true,
  isRetrying: false,
  turnHasError: () => false,
  firstPromptStandIn: false,
  ...over,
});

describe('the waiting row has a fallback when no turn owns it', () => {
  test('the fallback knows exactly when a turn is drawing the row itself', () => {
    const running = busyInput({
      turns: [turn('a', 'open')],
      projection: { state: 'working', turnId: 'a' },
    });
    expect(resolveBusyRow(running)).toMatchObject({
      someTurnDrawsBusyRow: true,
      showFallbackBusyRow: false,
    });
    // An errored working turn hides its own row, so the fallback must draw.
    expect(resolveBusyRow({ ...running, turnHasError: () => true })).toMatchObject({
      someTurnDrawsBusyRow: false,
      showFallbackBusyRow: true,
    });
    // A retry keeps the errored turn's own row.
    expect(
      resolveBusyRow({ ...running, turnHasError: () => true, isRetrying: true }),
    ).toMatchObject({ someTurnDrawsBusyRow: true, showFallbackBusyRow: false });
    // A finished answer with a prompt delivering below: the delivering prompt
    // IS the work in progress, so its own turn draws the row — directly under
    // its bubble, never over the finished answer and never twice.
    expect(
      resolveBusyRow(
        busyInput({
          turns: [turn('a', 'done'), turn('b')],
          prompts: [row('b', 'delivering')],
          projection: { state: 'working', turnId: null },
        }),
      ),
    ).toMatchObject({ workingTurnId: 'b', someTurnDrawsBusyRow: true, showFallbackBusyRow: false });
    // No busy value, no row anywhere.
    expect(resolveBusyRow({ ...running, lastTurnWorking: false })).toMatchObject({
      someTurnDrawsBusyRow: false,
      showFallbackBusyRow: false,
    });
    // The page feeds it the same values the turn card reads.
    const call = between(chat, 'resolveBusyRow({', '}),');
    expect(call).toContain('lastTurnWorking,');
    expect(call).toContain('isRetrying: isRetryingStatus,');
    expect(call).toContain('turnHasError: (turn) => !!resolveTurnError(turn),');
    expect(chat).toContain('const isRetryingStatus = !!getRetryInfo(sessionStatus);');
  });

  test('Stop and Thinking read one busy value', () => {
    // The composer's Stop reads `isBusy`. Any extra gate on the row reopened the
    // Stop-without-Thinking state users kept reporting.
    const busy = between(chat, 'const lastTurnWorking = resolveLastTurnWorking({', '});');
    expect(busy).toContain('projectionBusy: isBusy,');
    expect(chat).toContain('isBusy={isBusy}');
  });

  test('the trailing row is gated on that, not on an empty transcript', () => {
    const trailing = between(chat, '{showFallbackBusyRow && fallbackBusyRowTurnId === null && (', '/>\n                      )}');
    // The old gate. `turns.length === 0` is why a session with one queued
    // bubble drew nothing at all.
    expect(chat).not.toContain('{isBusy && turns.length === 0 && <SessionBusyIndicator');
    // One queued bubble, nothing answered: no turn is working, the row still draws.
    const queuedOnly = resolveBusyRow(
      busyInput({ turns: [turn('q')], prompts: [row('q')], projection: { state: 'working', turnId: null, pendingDelivery: true } }),
    );
    expect(queuedOnly).toMatchObject({ workingTurnId: null, showFallbackBusyRow: true, fallbackBusyRowTurnId: null });
    // Not busy, so nothing draws.
    expect(
      resolveBusyRow(busyInput({ turns: [turn('q')], prompts: [row('q')], lastTurnWorking: false })),
    ).toMatchObject({ showFallbackBusyRow: false });
    expect(trailing).toContain('<SessionBusyIndicator');
    expect(trailing).toContain('sessionId={sessionId}');
  });

  test('it never stacks with the boot stand-in, which draws its own row', () => {
    // First prompts and Enter submissions share this stand-in exclusion.
    expect(resolveBusyRow(busyInput({ firstPromptStandIn: true }))).toMatchObject({
      showFallbackBusyRow: false,
    });
    // Once the transcript carries a turn, the stand-in is gone and the row draws.
    expect(
      resolveBusyRow(busyInput({ firstPromptStandIn: true, turns: [turn('q')], prompts: [row('q')] })),
    ).toMatchObject({ showFallbackBusyRow: true });
    expect(chat).toMatch(
      /const firstPromptStandIn =\s*showFirstPromptPreview && !!firstPromptSource && queuedSyntheticMessages\.length === 0;/,
    );
    expect(between(chat, 'resolveBusyRow({', '}),')).toContain('firstPromptStandIn,');
    expect(chat).toMatch(/showFirstPromptPreview &&\s*firstPromptSource &&\s*queuedSyntheticMessages\.length === 0 && \(/);
    // The stand-in's own gate still decides whether the boot row is on screen
    // at all, and an empty transcript is still what opens it. What it reads
    // moved into `firstPromptStandInBusy` — the shell's rule, so the row does
    // not blink out on an idle projection frame at the crossfade.
    expect(between(chat, 'busy={firstPromptStandInBusy({', '})}')).toContain(
      'transcriptHasTurns: turns.length > 0,',
    );
  });

  test('it sits where the stand-in sat, so the crossfade does not move it', () => {
    const row = between(chat, '{showFallbackBusyRow && fallbackBusyRowTurnId === null && (', '/>\n                      )}');
    expect(row).toContain("className={turns.length === 0 ? undefined : 'mt-6'}");
  });

  test('with a queue on screen it renders inside the turn before the queue, never under it', () => {
    // The map hands the decision to the memoized row as `showBusyRow`…
    expect(chat).toMatch(
      /showBusyRow=\{\s*showFallbackBusyRow &&\s*fallbackBusyRowTurnId === turn\.userMessage\.info\.id\s*\}/,
    );
    // …and the row draws it INSIDE the turn's viewport, after the turn.
    const rowSource = between(chat, 'const TranscriptTurnRow = memo(', '</TurnViewport>');
    expect(rowSource).toContain('<TurnViewport turnId={turnId} className={viewportClassName}>');
    expect(rowSource).toContain(
      '{showBusyRow && <SessionBusyIndicator sessionId={turnProps.sessionId} className="mt-2.5" />}',
    );
    // WHICH turn is decided by the SDK resolver (`fallbackBusyRowAfterTurnId`
    // runs inside `resolveBusyRow`); the page only reads its answer.
    expect(chat).toContain('resolveBusyRow({');
    // A finished answer with a Quick Queue bubble under it: the row sits in the
    // answered turn, above the bubble.
    expect(
      resolveBusyRow(
        busyInput({
          turns: [turn('answered', 'done'), turn('queued')],
          prompts: [row('queued')],
          projection: { state: 'working', turnId: null, pendingDelivery: true },
        }),
      ),
    ).toMatchObject({ showFallbackBusyRow: true, fallbackBusyRowTurnId: 'answered' });
  });
});

/**
 * A turn nobody has started reports no status.
 *
 * `getTurnStatus`'s fallback ("Figuring out what's next…") describes a turn
 * already under way. Applied to a turn with zero assistant messages it is a
 * claim about work that has not begun — and the 2.5s throttle then replaced the
 * waiting row's honest "Thinking" with it while the prompt was still queued.
 */
describe('the status phrase is gated at its source', () => {
  test('a turn with no assistant content produces no status at all', () => {
    expect(chat).toContain('const hasAssistantContent = turn.assistantMessages.length > 0;');
    expect(chat).toContain(
      '() => (hasAssistantContent ? getTurnStatus(allParts, childMessages) : \'\'),',
    );
  });

  test('the throttle still ignores an empty status, so the row keeps its default word', () => {
    // This is what makes gating the SOURCE enough: `throttledStatus` never
    // becomes the fallback phrase, so neither `statusText` nor the elapsed
    // clock derived from it is ever emitted for a turn that has not started.
    const throttle = between(chat, 'const newStatus = rawStatus;', 'const elapsed =');
    expect(throttle).toContain('if (newStatus === throttledStatus || !newStatus) return;');
  });
});

/**
 * The producer's copy of the first prompt outlives the frame the transcript
 * first shows it.
 *
 * On the project-home path the prompt is a durable row, not an optimistic
 * message, so nothing bridges the runtime's info frame to its text part. When
 * the copy was forgotten on that first frame, the bubble had one source left
 * and blanked as soon as that source flickered.
 */
describe("the first prompt's text outlives the store's copy, locally", () => {
  // Two readers, two lifetimes. The boot shell (and the route that pins it)
  // must lose the copy the frame the transcript shows the prompt, or the
  // shell's bubble dissolves over the real one for the length of the
  // crossfade. This component needs the TEXT for longer — the runtime's echo
  // lands part-less on the project-home path — so it keeps its own snapshot.
  test('the STORE is cleared the frame the transcript carries the prompt — the original rule', () => {
    const clear = between(chat, 'if (!projectSessionId || !firstPromptPreview) return;', '}, [');
    expect(clear).toContain('if (transcriptCarriesFirstPromptFiles) clearFirstPromptPreview(projectSessionId);');
    expect(clear).not.toContain('firstPromptSettled');
  });

  test('the LOCAL copy is what the stand-in and the hand-over read', () => {
    expect(chat).toContain('const firstPromptSource = firstPromptPreview ?? firstPromptKeep;');
    expect(chat).toContain('hasPreview: !!firstPromptSource,');
    expect(chat).toContain(
      'text: firstPromptSource.text,\n        attachments: sentAttachmentsOf(firstPromptSource.files),',
    );
    // Whitespace-collapsed: the stand-in's indentation moved when the bubble
    // gained its queue-tone wrapper, and re-indenting the JSX is not a change
    // of decision.
    expect(chat.replace(/\s+/g, ' ')).toContain('firstPromptSource.text, firstPromptSource.files,');
  });

  test('settled means answered, or the session is finished with it — and that clears the local copy', () => {
    expect(chat).toContain(
      'const firstPromptSettled =\n    turns.length > 0 &&\n    (turns[0].assistantMessages.length > 0 || (!isBusy && promptInbox.prompts.length === 0));',
    );
    expect(chat).toContain('if (firstPromptSettled) {\n    if (firstPromptKeep) setFirstPromptKeep(null);');
  });

  test('nothing on unmount — local state dies with the component', () => {
    expect(chat).not.toContain('firstPromptReleasedRef');
  });

  test('an empty transcript is reported to the handover, so the stand-in can come back', () => {
    const handover = between(chat, 'const handover = resolveFirstPromptHandover({', '});');
    expect(handover).toContain('transcriptEmpty: turns.length === 0,');
  });
});


test('a confirmed working turn cannot retain a stale pending inbox presentation', () => {
  // Confirmed by the server, not by the fresh-send hint: a send the inbox still
  // holds keeps its pending bubble beside its Thinking row.
  const turns = [turn('old', 'done'), turn('sent')];
  const stillHeld = resolveBusyRow(
    busyInput({
      turns,
      prompts: [row('sent')],
      freshSendTurnId: 'sent',
      projection: { state: 'working', turnId: 'sent', pendingDelivery: true },
    }),
  );
  expect(stillHeld.workingTurnId).toBe('sent');
  expect(busyRowTurnPresentation(stillHeld, turns[1])).toMatchObject({
    confirmedActive: false,
    pending: true,
  });
  expect(busyRowTurnPresentation(stillHeld, turns[1]).pendingPrompt?.prompt_id).toBe('p_sent');
  // The server names the running turn while a stale inbox read still lists it.
  const confirmed = resolveBusyRow(
    busyInput({ turns, prompts: [row('sent')], projection: { state: 'working', turnId: 'sent' } }),
  );
  expect(busyRowTurnPresentation(confirmed, turns[1])).toEqual({
    confirmedActive: true,
    pendingPrompt: undefined,
    pending: false,
  });
  // The page renders exactly that presentation.
  expect(chat).toContain('const { pending, pendingPrompt } = busyRowTurnPresentation(busyRow, turn);');
  expect(chat).toContain('pending={pending}');
  expect(chat).toContain('pendingPrompt={pendingPrompt}');
});

/**
 * A session parked on the USER draws no waiting row anywhere.
 *
 * The `question` tool and a tool-permission prompt both block OpenCode inside
 * its own turn loop: no `session.idle` frame follows, the control plane's row
 * stays `active`, and `projectWorking` correctly keeps saying `working`. So the
 * shimmer and its clock ran while the agent was waiting for a reply — measured
 * on the local stack 2026-09-22 (session 8d807956): 12m22s on one unanswered
 * 2-option question, the clock reading 7m55s in the screenshot.
 *
 * Source assertions because the permission half cannot be driven here at all:
 * the local test profile has no cloud sandbox, so no agent reaches a tool that
 * asks. The question half was verified by hand against a real sandbox; this
 * pins that BOTH lists feed one decision and that every consumer of it is
 * wired, so the two halves cannot drift apart.
 */
describe('waiting on the user is not the agent working', () => {
  test('one fact, read from both pending lists', () => {
    expect(chat).toContain(
      'const awaitingUserInput = pendingQuestions.length > 0 || pendingPermissions.length > 0;',
    );
  });

  test('the busy-row resolver gets the same fact', () => {
    // The rule itself — the working turn declines its row AND the fallback
    // does not catch it — lives in `@kortix/sdk` `resolveBusyRow` and is
    // tested there. This pins that the page hands it the fact.
    const gate = between(chat, 'resolveBusyRow({', '}),');
    expect(gate).toContain('awaitingUser: awaitingUserInput,');
  });

  test('the turn card gets the same fact, and its indicator reads it', () => {
    expect(chat).toContain('awaitingUser={awaitingUserInput}');
    const indicator = between(chat, '{showTurnBusyIndicator({', '}) && (');
    expect(indicator).toContain('awaitingUser,');
  });

  test('the elapsed clock measures the AGENT, so it stops and restarts from zero', () => {
    // On `working` it kept counting behind the hidden row and came back
    // reporting how long the reader took to answer.
    expect(chat).toContain('const agentWorking = working && !awaitingUser;');
    const label = between(chat, 'const statusElapsedLabel =', 'formatDuration(statusElapsedMs)');
    expect(label).toContain('agentWorking');
    expect(chat).toContain('if (!agentWorking) return;');
  });

  test('`working` itself is untouched — the turn IS still open', () => {
    // Every structural decision below still reads it: which steps render, and
    // where answered questions go.
    expect(chat).toContain('const working = isWorkingTurn && sessionWorking;');
    expect(chat).toContain('{!hasSteps && !working && !hasReasoning && answeredQuestionParts.length > 0 && (');
  });
});
