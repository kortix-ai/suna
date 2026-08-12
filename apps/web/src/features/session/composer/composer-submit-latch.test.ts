/**
 * One user action = one submission.
 *
 * Source assertions, for the reason stated in `session-chat-queued-retry-id.test.ts`:
 * `apps/web` has no DOM harness, the composer sits behind a `React.lazy`
 * boundary, and the thing under test is which guard wraps which call — not
 * rendered output. Every slice goes through `between()`, which FAILS on a
 * missing anchor rather than yielding '' and passing.
 *
 * Why this guard exists at all: the sandbox proxy used to absorb an accidental
 * double-fire for free, deduping a delivery by sha256 of the request body
 * (the browser cannot send `Idempotency-Key` — it is not on the API's CORS
 * allow-list). Giving each submission its own `messageID` deliberately ended
 * that, because the same mechanism was silently swallowing prompts the user
 * MEANT to send twice. The accidental case then had nothing behind it.
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

describe('the composer refuses a re-entrant submit', () => {
  test('handleSubmit gates on the latch before dispatching', () => {
    const latch = between('const handleSubmit = useCallback(', 'const editorPlaceholder');

    expect(latch).toContain('if (submissionInFlight.current) return;');
    expect(latch).toContain('submissionInFlight.current = true;');
    expect(latch).toContain('await dispatchSubmission();');
  });

  test('the latch releases in a finally, so a throw cannot wedge the composer', () => {
    // The failure this prevents is worse than the one it fixes: a send that
    // throws would leave the gate closed and the composer permanently dead.
    const latch = between('const handleSubmit = useCallback(', 'const editorPlaceholder');
    const finallyBlock = latch.slice(latch.indexOf('} finally {'));

    expect(latch).toContain('} finally {');
    expect(finallyBlock).toContain('submissionInFlight.current = false;');
  });

  test('it is a ref, not state — it must be readable in the tick it is set', () => {
    // `useState` would not have flushed by the time a second Enter in the same
    // tick reads it, which is exactly the window being closed.
    expect(source).toContain('const submissionInFlight = useRef(false);');
  });

  test('every submit entry point goes through the latched handler', () => {
    // The keyboard path and the button path must not diverge: a disabled button
    // does nothing to Enter, and a latch on only one of them guards neither.
    //
    // Counted over CODE only. The first draft of this test counted the whole
    // file and tripped on the two prose mentions in the latch's own comment —
    // a reference in a comment calls nothing.
    const refs = code().match(/\bdispatchSubmission\b/g) ?? [];

    // Exactly three: the definition, the call inside the latch, and the
    // dependency array entry. A fourth means something calls it unlatched.
    expect(refs).toHaveLength(3);
    expect(source).toContain('onSubmit={handleSubmit}');
  });
});
