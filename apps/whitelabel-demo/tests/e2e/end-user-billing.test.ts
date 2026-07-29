import { describe, expect, test } from 'bun:test';
import { splitEndUserBills } from '../../src/server/end-user-billing';

describe('splitEndUserBills', () => {
  test('applies the markup per end-user', () => {
    const { bills } = splitEndUserBills([{ end_user_ref: 'u1', cost: 10, count: 2 }], 1.5);
    expect(bills[0]).toEqual({ endUserRef: 'u1', rawCost: 10, billedCost: 15, sessions: 2 });
  });

  test('drops unattributed spend instead of spreading it across users', () => {
    // It is Lumen's own cost. Charging it to whoever sorts first would be worse
    // than not billing it — so it is reported separately, not absorbed.
    const { bills, unattributedCost } = splitEndUserBills(
      [{ end_user_ref: 'u1', cost: 4 }, { cost: 6 }],
      1,
    );
    expect(bills.map((b) => b.endUserRef)).toEqual(['u1']);
    expect(unattributedCost).toBe(6);
  });

  test('reads the deprecated origin_ref when that is all upstream sends', () => {
    const { bills } = splitEndUserBills([{ origin_ref: 'legacy', cost: 2 }], 1);
    expect(bills[0]?.endUserRef).toBe('legacy');
  });

  test('sorts by what the customer is charged, biggest first', () => {
    const { bills } = splitEndUserBills(
      [{ end_user_ref: 'small', cost: 1 }, { end_user_ref: 'big', cost: 9 }],
      2,
    );
    expect(bills.map((b) => b.endUserRef)).toEqual(['big', 'small']);
  });

  test('ties break on id so the invoice order never flickers', () => {
    const { bills } = splitEndUserBills(
      [{ end_user_ref: 'b', cost: 5 }, { end_user_ref: 'a', cost: 5 }],
      1,
    );
    expect(bills.map((b) => b.endUserRef)).toEqual(['a', 'b']);
  });

  test('rounds money to cents rather than leaking float noise onto an invoice', () => {
    const { bills } = splitEndUserBills([{ end_user_ref: 'u', cost: 0.1 }], 1.15);
    expect(bills[0]?.billedCost).toBe(0.12);
  });

  test('no rows is empty, not a crash', () => {
    expect(splitEndUserBills(undefined, 1.5)).toEqual({ bills: [], unattributedCost: 0 });
  });

  test('a whitespace-only handle counts as unattributed, not as a user named " "', () => {
    const { bills, unattributedCost } = splitEndUserBills([{ end_user_ref: '  ', cost: 3 }], 1);
    expect(bills).toHaveLength(0);
    expect(unattributedCost).toBe(3);
  });
});

describe('the usage route must narrow the rollup to the caller', () => {
  // Regression guard. The first version passed only { groupBy: 'end_user_ref' },
  // which is ACCOUNT-WIDE — any signed-in user could read every other
  // end-user's id and spend from the main nav. `projects` in the same route was
  // already scoped to owned projects; this had to be too.
  test('the route asks upstream for the caller only', async () => {
    const source = await Bun.file(
      new URL('../../src/app/api/usage/route.ts', import.meta.url).pathname,
    ).text();
    const call = source.slice(source.indexOf('usageRollup'));
    expect(call).toContain('endUserRef');
    expect(call.slice(0, 200)).toContain('session.userId');
  });
});
