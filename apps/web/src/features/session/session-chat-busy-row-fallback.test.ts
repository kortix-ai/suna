import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';

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
describe('the waiting row has a fallback when no turn owns it', () => {
  test('the fallback knows exactly when a turn is drawing the row itself', () => {
    expect(chat).toContain(
      'const someTurnDrawsBusyRow =\n    lastTurnWorking && workingTurn.workingTurnId !== null && !suppressWorkingTurnBusy;',
    );
  });

  test('the trailing row is gated on that, not on an empty transcript', () => {
    const row = between(chat, '{isBusy &&\n                      !someTurnDrawsBusyRow', '/>\n                      )}');
    // The old gate. `turns.length === 0` is why a session with one queued
    // bubble drew nothing at all.
    expect(chat).not.toContain('{isBusy && turns.length === 0 && <SessionBusyIndicator');
    expect(row).toContain('<SessionBusyIndicator');
    expect(row).toContain('sessionId={sessionId}');
  });

  test('it never stacks with the boot stand-in, which draws its own row', () => {
    const row = between(chat, '{isBusy &&\n                      !someTurnDrawsBusyRow', '/>\n                      )}');
    expect(row).toContain(
      '!(showFirstPromptPreview && firstPromptSource && queuedMessages.length === 0 && turns.length === 0)',
    );
    // The stand-in's own gate is unchanged — it is the one that decides
    // whether the boot row is on screen at all.
    expect(chat).toContain('busy={turns.length === 0}');
  });

  test('it sits where the stand-in sat, so the crossfade does not move it', () => {
    const row = between(chat, '{isBusy &&\n                      !someTurnDrawsBusyRow', '/>\n                      )}');
    expect(row).toContain("className={turns.length === 0 ? undefined : 'mt-6'}");
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
    expect(chat).toContain('return { text: firstPromptSource.text, attachments };');
    expect(chat).toContain('firstPromptSource.text,\n                                firstPromptSource.files,');
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
