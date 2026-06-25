import { beforeEach, describe, expect, mock, test } from 'bun:test';

// resolveSlackActor is the authoritative security gate: it must return a userId
// ONLY when the Slack user is linked AND a member of the project's account.

let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'set', 'values', 'returning', 'onConflictDoUpdate']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

const { resolveSlackActor } = await import('../identity');

beforeEach(() => {
  dbResults = [];
});

describe('resolveSlackActor', () => {
  test('no Slack user → unlinked, without touching the db', async () => {
    const r = await resolveSlackActor('T1', '', 'acct1');
    expect(r).toEqual({ reason: 'unlinked' });
  });

  test('no mapping row → unlinked', async () => {
    dbResults = [[]]; // identity lookup misses
    const r = await resolveSlackActor('T1', 'U1', 'acct1');
    expect(r).toEqual({ reason: 'unlinked' });
  });

  test('linked but NOT a member of the account → not_member', async () => {
    dbResults = [[{ userId: 'u1' }], []]; // identity hit, membership miss
    const r = await resolveSlackActor('T1', 'U1', 'acct1');
    expect(r).toEqual({ reason: 'not_member' });
  });

  test('linked AND a member → returns the Kortix userId', async () => {
    dbResults = [[{ userId: 'u1' }], [{ userId: 'u1' }]]; // identity hit, membership hit
    const r = await resolveSlackActor('T1', 'U1', 'acct1');
    expect(r).toEqual({ userId: 'u1' });
  });
});
