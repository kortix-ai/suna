import { describe, expect, test } from 'bun:test';

import { replyToInlinePermission } from './inline-permission-reply';

// Better Stack (Kortix Frontend prod), 2026-10-12: `Error: Permission request
// not found: per_<id>` as an UNHANDLED rejection from the inline permission card
// in the transcript. The card dropped the reply promise, so a runtime refusal
// (request already answered or expired) escaped, and the card stayed disabled.
describe('replyToInlinePermission', () => {
  test('resolves true when the runtime accepts the reply', async () => {
    const calls: unknown[][] = [];
    const ok = await replyToInlinePermission(async (...args) => { calls.push(args); }, 'per_1', 'once', () => {
      throw new Error('onFailure must not run');
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([['per_1', 'once']]);
  });

  test('never rejects: a refused reply reports the error and resolves false', async () => {
    const failures: unknown[] = [];
    const refusal = new Error('Permission request not found: per_1');
    const ok = await replyToInlinePermission(async () => { throw refusal; }, 'per_1', 'always', (e) => failures.push(e));
    expect(ok).toBe(false);
    expect(failures).toEqual([refusal]);
  });

  test('a synchronous throw and a missing handler also stay contained', async () => {
    const failures: unknown[] = [];
    expect(await replyToInlinePermission(() => { throw new Error('sync'); }, 'per_1', 'reject', (e) => failures.push(e))).toBe(false);
    expect(failures.length).toBe(1);
    expect(await replyToInlinePermission(undefined, 'per_1', 'once', () => failures.push('x'))).toBe(false);
    expect(failures.length).toBe(1);
  });
});
