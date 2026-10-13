import { describe, expect, test } from 'bun:test';
import { stabilizeTurns } from './stable-turns';

/** A message as the store hands it over: a fresh wrapper around stable innards. */
const msg = (info: unknown, parts: unknown) => ({ info, parts });

const turn = (
  userMessage: { info: unknown; parts: unknown },
  assistantMessages: { info: unknown; parts: unknown }[] = [],
) => ({ userMessage, assistantMessages });

describe('stabilizeTurns', () => {
  // `info` and `parts` are what keep identity across a rebuild; the wrapper
  // around them is thrown away and re-made every frame.
  const u1 = msg({ id: 'u1' }, []);
  const u2 = msg({ id: 'u2' }, []);
  const a1 = msg({ id: 'a1' }, []);
  const a2 = msg({ id: 'a2' }, []);
  /** The same message as the store would re-wrap it — new object, same innards. */
  const rewrap = (m: { info: unknown; parts: unknown }) => msg(m.info, m.parts);

  test('an unchanged list keeps every object AND the array itself', () => {
    // The array identity matters too: a `useMemo` keyed on `turns` holds only
    // if the array is the same one.
    const prev = [turn(u1, [a1]), turn(u2, [a2])];
    const next = [turn(u1, [a1]), turn(u2, [a2])];
    const out = stabilizeTurns(next, prev);
    expect(out).toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  test('only the turn that changed gets a new identity', () => {
    // This is the streaming case: the last turn grew, the rest did not.
    const prev = [turn(u1, [a1]), turn(u2, [a2])];
    const grown = turn(u2, [a2, msg({ id: 'a3' }, [])]);
    const out = stabilizeTurns([turn(u1, [a1]), grown], prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(grown);
    expect(out).not.toBe(prev);
  });

  test('a re-WRAPPED message is still the same message', () => {
    // The store hands over a new `{info, parts}` object for every message on
    // every frame. Comparing wrappers by identity would make this module a
    // no-op that still passes every other test in this file.
    const prev = [turn(u1, [a1])];
    const next = [turn(rewrap(u1), [rewrap(a1)])];
    expect(stabilizeTurns(next, prev)).toBe(prev);
  });

  test('a replaced parts array breaks identity — the turn really changed', () => {
    const prev = [turn(u1, [a1])];
    const next = [turn(u1, [msg(a1.info, [{ id: 'p1' }])])];
    expect(stabilizeTurns(next, prev)[0]).not.toBe(prev[0]);
  });

  test('a new turn appended leaves the earlier ones alone', () => {
    const prev = [turn(u1, [a1])];
    const next = [turn(u1, [a1]), turn(u2, [])];
    const out = stabilizeTurns(next, prev);
    expect(out[0]).toBe(prev[0]);
    expect(out).toHaveLength(2);
  });

  test('a removed turn (rewind) shortens the list without reusing the wrong slot', () => {
    const prev = [turn(u1, [a1]), turn(u2, [a2])];
    const out = stabilizeTurns([turn(u1, [a1])], prev);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(prev[0]);
  });

  test('it is idempotent — safe to run during a StrictMode double render', () => {
    const prev = [turn(u1, [a1])];
    const raw = [turn(u1, [a1])];
    const once = stabilizeTurns(raw, prev);
    const twice = stabilizeTurns(raw, once);
    expect(twice).toBe(once);
  });

  test('an empty previous list returns the new one', () => {
    const next = [turn(u1, [a1])];
    expect(stabilizeTurns(next, [])).toEqual(next);
  });
});
