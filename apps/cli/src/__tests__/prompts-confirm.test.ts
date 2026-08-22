/**
 * `confirm()` against a real stdin stream.
 *
 * The case worth pinning is end-of-input: `rl.question`'s callback never fires
 * when the stream ends, so the awaited promise used to stay pending forever and
 * the process would exit AT the prompt — no answer, no error, no remaining
 * work. Anything that asks before doing something irreversible (the bare
 * `kortix` update prompt) has to be able to say what "nobody answered" means.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';

import { confirm } from '../prompts.ts';

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const realIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

/** Swap process.stdin for a stream we drive, with the TTY flags confirm()
 *  requires. Returns the writable end. */
function attachStdin(): PassThrough {
  const stream = new PassThrough();
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  return stream;
}

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  if (realIsTTY) Object.defineProperty(process.stdout, 'isTTY', realIsTTY);
});

describe('confirm', () => {
  test('reads an explicit answer', async () => {
    const stdin = attachStdin();
    const answer = confirm('go?', false);
    stdin.write('y\n');
    expect(await answer).toBe(true);
  });

  test('blank input takes the default', async () => {
    const stdin = attachStdin();
    const answer = confirm('go?', true);
    stdin.write('\n');
    expect(await answer).toBe(true);
  });

  test('re-asks on junk without piling up close listeners', async () => {
    const stdin = attachStdin();
    const answer = confirm('go?', false);
    // One line per turn of the loop — readline only consumes input while a
    // question is outstanding, so a single batched write would be swallowed.
    for (let i = 0; i < 12; i++) {
      stdin.write('maybe\n');
      await new Promise((r) => setImmediate(r));
    }
    // A per-question 'close' listener would have blown past Node's warning
    // threshold long before the twelfth retry.
    expect(stdin.listenerCount('close')).toBeLessThan(5);

    stdin.write('n\n');
    expect(await answer).toBe(false);
  });

  test('end of input resolves instead of hanging — default when unspecified', async () => {
    const stdin = attachStdin();
    const answer = confirm('go?', true);
    stdin.end();
    expect(await answer).toBe(true);
  });

  test('end of input honours onEndOfInput, so silence never means "yes, do it"', async () => {
    const stdin = attachStdin();
    const answer = confirm('go?', true, { onEndOfInput: false });
    stdin.end();
    // Default is yes (Enter accepts), but a stream that simply ended is nobody
    // answering — the update prompt relies on this to not self-install.
    expect(await answer).toBe(false);
  });
});
