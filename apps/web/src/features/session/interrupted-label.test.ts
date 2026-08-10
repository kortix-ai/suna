/**
 * "Interrupted" must mean the turn was actually interrupted.
 *
 * The label is a muted one-liner that REPLACES the error card. So mislabelling
 * costs twice: the user is told they stopped something they didn't, and the
 * real failure is never shown.
 *
 * It was decided by substring-matching the error's display text for "abort" /
 * "cancel". `getTurnError` flattens the structured error to a string and drops
 * its `name`, so that was the only signal left — and it fires on any message
 * that merely contains the word.
 *
 * The transcript can read the identity directly off the message, so it now
 * passes `isAbort`. The prose sniff survives only for the send-failure path,
 * where a message really is all there is.
 */
import { describe, expect, test } from 'bun:test';

const BANNER = await Bun.file(
  new URL('./session-error-banner.tsx', import.meta.url).pathname,
).text();
const CHAT = await Bun.file(new URL('./session-chat.tsx', import.meta.url).pathname).text();

function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/** The predicate the banner uses, mirrored. */
function rendersInterrupted(isAbort: boolean | undefined, text: string): boolean {
  const patterns = ['aborted', 'abort', 'cancelled', 'canceled'];
  return isAbort ?? patterns.some((p) => text.toLowerCase().includes(p));
}

describe('identity wins over prose', () => {
  test('a real abort is labelled Interrupted', () => {
    expect(rendersInterrupted(true, 'The operation was aborted.')).toBe(true);
  });

  test('a genuine failure that merely says "aborted" is NOT', () => {
    // The bug. This is a real error the user needs to see, not a muted note
    // telling them they stopped their own turn.
    expect(rendersInterrupted(false, 'upstream connection aborted by peer')).toBe(false);
    expect(rendersInterrupted(false, 'signal is aborted without reason')).toBe(false);
    expect(rendersInterrupted(false, 'stream cancelled by server')).toBe(false);
  });

  test('a clean turn shows nothing either way', () => {
    // No error text at all → the component returns null before any of this.
    expect(rendersInterrupted(false, '')).toBe(false);
  });

  test('the prose sniff still covers a caller that cannot tell', () => {
    // The send-failure path has only a message.
    expect(rendersInterrupted(undefined, 'Request aborted')).toBe(true);
    expect(rendersInterrupted(undefined, 'Payment required')).toBe(false);
  });
});

describe('wiring', () => {
  test('the banner prefers the explicit signal', () => {
    expect(code(BANNER)).toContain('isAbort ?? looksLikeAbortText(text)');
  });

  test('the transcript reads the structured error name', () => {
    const src = code(CHAT);
    // Narrowed to a string before the comparison — comparing the raw `unknown`
    // to a literal is the inconvertible-types smell CodeQL flags, and it would
    // read false for a boxed String.
    expect(src).toContain("typeof name === 'string' && name === 'AbortError'");
  });

  test('BOTH render sites pass it', () => {
    // There are two: the compact row and the full transcript. Wiring one leaves
    // the other sniffing prose, and which one you see depends on the layout.
    const hits = [...code(CHAT).matchAll(/isAbort=\{turnErrorIsAbort\}/g)];
    expect(hits.length).toBe(2);
  });

  test('the sniff is no longer named as if it were authoritative', () => {
    // It was `isAbortError`, which read like a fact. It is a guess.
    expect(code(BANNER)).not.toContain('function isAbortError(');
  });
});
