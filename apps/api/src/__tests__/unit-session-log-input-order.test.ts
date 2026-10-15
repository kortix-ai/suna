import { describe, expect, test } from 'bun:test';
import { toolInputOrderOf, withToolInputOrder } from '../projects/session-log-input-order';

const call = (input: unknown) => ({ type: 'tool_call', input });
/** What a jsonb column does to an object: keys sorted by length, then bytes, at every depth. */
const jsonbSorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(jsonbSorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)).map(([k, x]) => [k, jsonbSorted(x)]))
  : v;
const restored = (input: unknown, order: unknown[] | null) =>
  JSON.stringify((withToolInputOrder({ blocks: [call(jsonbSorted(input))] }, order).blocks[0] as { input: unknown }).input);

describe('tool_call input key order', () => {
  test('an array without objects is one leaf: 20,000 numbers give a shape of a few bytes', () => {
    const input = { values: Array.from({ length: 20_000 }, (_, i) => i), name: 'n' };
    const order = toolInputOrderOf({ blocks: [call(input)] });
    expect(JSON.stringify(order)).toBe('[{"values":0,"name":0}]');
    expect(restored(input, order)).toBe(JSON.stringify(input));
  });

  test('nested objects and objects in arrays restore in the written order', () => {
    const input = { zeta: 1, list: [{ to: 'b', from: 'a' }, 'x', [{ yy: 1, a: 2 }]], opts: { depth: 2, all: true } };
    const order = toolInputOrderOf({ blocks: [{ type: 'text' }, call(input), call('freeform')] });
    expect(order?.[0]).toBeNull();
    expect(order?.[2]).toBeNull();
    expect(restored(input, order!.slice(1))).toBe(JSON.stringify(input));
  });

  test('a stale shape (another key set: an old replica rewrote the record) leaves that object in jsonb order', () => {
    const before = { zeta: 1, opts: { depth: 2, all: true } };
    const after = { zeta: 1, alpha: 0, opts: { depth: 3, all: false } };
    const order = toolInputOrderOf({ blocks: [call(before)] });
    // The top level is stale and keeps jsonb order; no value is lost.
    expect(restored(after, order)).toBe(JSON.stringify(jsonbSorted(after)));
    expect(JSON.parse(restored(after, order))).toEqual(after);
  });
});
