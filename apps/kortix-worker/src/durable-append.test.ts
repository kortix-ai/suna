/**
 * The durable transcript is APPEND-ONLY, so a hole in it is permanent.
 *
 * The old loop swallowed a failed append and then advanced the watermark past
 * it anyway:
 *
 *   for (let i = persisted; i < all.length; i++)
 *     await session.appendMessage(...).catch(log)   // ← swallowed
 *   persisted = all.length                          // ← advanced regardless
 *
 * One 5xx from the store on the assistant message that carries a `toolCall`,
 * with the following `toolResult` appending fine, leaves a toolResult whose
 * toolCall is missing. On the next boot `restoredMessagesFromEntries` seeds the
 * agent with that hole and the provider rejects the request — Anthropic and
 * OpenAI both 400 on a tool result with no preceding tool use. Every later turn
 * in that session then fails, and because the corruption is IN the append-only
 * log, restarting the box does not clear it.
 *
 * The watermark must therefore never move past a message that did not land.
 */
import { describe, expect, test } from 'bun:test';
import { persistNewMessages } from './durable-append.ts';

const toDurable = (m: unknown) => m;

function store(failOn: Set<number> = new Set()) {
  const appended: unknown[] = [];
  let n = 0;
  return {
    appended,
    async appendMessage(m: unknown) {
      const index = n++;
      if (failOn.has(index)) throw new Error(`store 500 at call ${index}`);
      appended.push(m);
    },
  };
}

describe('persistNewMessages', () => {
  test('appends every new message and advances the watermark', async () => {
    const s = store();
    const result = await persistNewMessages(s, ['a', 'b', 'c'], 0, toDurable);
    expect(s.appended).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ persisted: 3, error: null });
  });

  test('starts from the watermark, never re-appending what is already stored', async () => {
    const s = store();
    const result = await persistNewMessages(s, ['a', 'b', 'c'], 2, toDurable);
    expect(s.appended).toEqual(['c']);
    expect(result).toEqual({ persisted: 3, error: null });
  });

  // THE BUG: the watermark must stop AT the failure, not past it.
  test('stops at the first failure and leaves the watermark on it', async () => {
    const s = store(new Set([1])); // 'b' fails
    const result = await persistNewMessages(s, ['a', 'b', 'c'], 0, toDurable);
    expect(s.appended).toEqual(['a']);
    // 1, not 3: 'b' must be retried, and 'c' must NOT be written above a hole.
    expect(result.persisted).toBe(1);
    expect(result.error?.message).toBe('store 500 at call 1');
  });

  test('never writes a later message over a hole', async () => {
    const s = store(new Set([0]));
    const result = await persistNewMessages(s, ['toolCall', 'toolResult'], 0, toDurable);
    // The toolResult must not land without its toolCall — that is the exact
    // shape that makes every subsequent provider request 400.
    expect(s.appended).toEqual([]);
    expect(result.persisted).toBe(0);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('the next attempt resumes from the failed index and completes', async () => {
    const failing = store(new Set([0]));
    const after = await persistNewMessages(failing, ['a', 'b'], 0, toDurable);
    expect(after.persisted).toBe(0);
    // The store recovers; the same call retries from the watermark.
    const healthy = store();
    const done = await persistNewMessages(healthy, ['a', 'b'], after.persisted, toDurable);
    expect(healthy.appended).toEqual(['a', 'b']);
    expect(done).toEqual({ persisted: 2, error: null });
  });

  test('returns the failure so the worker can fail closed without losing the watermark', async () => {
    const s = store(new Set([0]));
    const lines: string[] = [];
    const result = await persistNewMessages(s, ['a'], 0, toDurable, (l) => lines.push(l));
    expect(result.persisted).toBe(0);
    expect(result.error).toBeInstanceOf(Error);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('store 500');
  });

  test('nothing new is a no-op', async () => {
    const s = store();
    expect(await persistNewMessages(s, ['a'], 1, toDurable)).toEqual({
      persisted: 1,
      error: null,
    });
    expect(s.appended).toEqual([]);
  });
});
