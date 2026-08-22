/**
 * One user action = one submission — and the NEXT user action must survive.
 *
 * The latch's BEHAVIOR (defer a typed second message, drop a same-tick
 * double-fire, release on throw) is asserted with real promises in
 * `submit-latch.test.ts`. This file pins only the composer's WIRING of it,
 * which a behavioral test of the pure module cannot see.
 *
 * Source assertions, for the reason stated in `session-chat-queued-retry-id.test.ts`:
 * `apps/web` has no DOM harness, the composer sits behind a `React.lazy`
 * boundary, and the thing under test is which guard wraps which call — not
 * rendered output. Every slice goes through `between()`, which FAILS on a
 * missing anchor rather than yielding '' and passing.
 *
 * History: the first latch was an inline `if (submissionInFlight.current)
 * return;`. That blanket return held the gate for the entire await of the
 * previous send's ACK (seconds with uploads, ~30s against a waking sandbox)
 * and silently dropped every submission inside the window — the "second
 * message never queues, Enter does nothing" bug. The expectation this file
 * used to pin was that behavior; it changed on purpose.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./composer.tsx', import.meta.url)), 'utf8');

/** The file with comments removed, for assertions about what CODE references. */
function code(): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  expect(to, `anchor not found after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the composer submits through the latch', () => {
  test('handleSubmit goes through ONE latch instance, held in a ref', () => {
    // A latch rebuilt per render forgets it is in flight, which reopens the
    // same-tick double-fire window mid-send. The `??=` into a ref is what makes
    // the instance survive every render; the handler itself is stable (`[]`)
    // because its only inputs are refs.
    const wiring = between('const submitLatchRef = useRef', 'const editorPlaceholder');
    expect(wiring).toContain('submitLatchRef.current ??= createSubmitLatch<StashedDraft>(');
    expect(wiring).toContain('return submitLatchRef.current();');
    expect(wiring).toContain('}, []);');
  });

  test('the latch dispatches through a ref, so a deferred re-run reads fresh state', () => {
    // The deferred re-run fires after the in-flight send settles — an
    // arbitrarily later render. Dispatching the closure captured at latch
    // creation would submit against stale attachedFiles/queue props.
    const wiring = between('const dispatchSubmissionRef = useRef', 'const editorPlaceholder');
    expect(wiring).toContain('dispatchSubmissionRef.current = dispatchSubmission;');
    expect(wiring).toContain('(stash) => dispatchSubmissionRef.current(stash)');
  });

  test('the stash discriminator is typed text in the live editor, and the stash clears the editor', () => {
    // A double-fire arrives with the editor already cleared (dispatch clears it
    // synchronously); a distinct second message arrives with text. Files alone
    // must NOT arm the stash — un-flushed `attachedFiles` state is exactly
    // the hazard the latch exists to swallow. A stashed draft leaves the
    // editor at once, so the next Enter cannot merge into it.
    const wiring = between('submitLatchRef.current ??= createSubmitLatch<StashedDraft>(', 'const editorPlaceholder');
    expect(wiring).toContain("if (!editor || !content || !content.text.trim()) return null;");
    expect(wiring).toContain('editor.clear();');
    expect(wiring).toContain('attachedFilesRef.current = [];');
  });

  test('every submit entry point goes through the latched handler', () => {
    // The keyboard path and the button path must not diverge: a disabled button
    // does nothing to Enter, and a latch on only one of them guards neither.
    //
    // Counted over CODE only (comments reference the name without calling it).
    const refs = code().match(/\bdispatchSubmission\b/g) ?? [];

    // Exactly three: the definition, the `useRef(dispatchSubmission)` seed, and
    // the ref-mirror assignment. A fourth means something calls it unlatched.
    expect(refs).toHaveLength(3);
    expect(source).toContain('onSubmit={handleSubmit}');
  });
});
