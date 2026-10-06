/**
 * Real-PostgreSQL proof that `withAccountSeatLock` serializes the seat check and
 * the membership insert per account, so concurrent callers cannot all pass a
 * "members < limit" check. A mocked `db` cannot show lock contention.
 */
import { describe, expect, test } from 'bun:test';
import { withAccountSeatLock } from './seat-lock';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withAccountSeatLock', () => {
  test('callers for one account run one at a time', async () => {
    const account = crypto.randomUUID();
    let inside = 0;
    let maxInside = 0;
    const run = () =>
      withAccountSeatLock(account, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(50);
        inside--;
      });
    await Promise.all([run(), run(), run()]);
    expect(maxInside).toBe(1);
  });

  test('different accounts do not block each other', async () => {
    let inside = 0;
    let maxInside = 0;
    const run = () =>
      withAccountSeatLock(crypto.randomUUID(), async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(100);
        inside--;
      });
    await Promise.all([run(), run()]);
    expect(maxInside).toBe(2);
  });
});
