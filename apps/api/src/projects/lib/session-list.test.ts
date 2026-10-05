import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { accountGroupMembers, accounts, projectSessions } from '@kortix/db';
import * as realDb from '../../shared/db';

// The sessions list is polled, and every statement is a full round trip. These
// tests pin WHEN the first row chunk starts: beside the reads that depend only
// on the caller, and for the manager-only scope not before the verdict.
//
// A table-aware stand-in for the drizzle builder: chainable, and it runs when
// awaited. A gate holds one read open so a test can see what else has started.
// The queries themselves are proven on real rows by
// integration-session-list-filters.test.ts and -ancestors.test.ts.

let started: string[] = [];
let shareSubjectGate: Promise<void> | null = null;
let oversightGate: Promise<void> | null = null;

function query(table: unknown) {
  const run = async (): Promise<unknown[]> => {
    if (table === projectSessions) {
      started.push('first-chunk');
      return [];
    }
    if (table === accountGroupMembers) {
      started.push('share-subject');
      await shareSubjectGate;
      return [];
    }
    if (table === accounts) {
      started.push('oversight-policy');
      await oversightGate;
      return [];
    }
    throw new Error('session-list.test.ts: unexpected table in db.select().from()');
  };
  const builder = {
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      run().then(resolve, reject),
  };
  return builder;
}

mock.module('../../shared/db', () => ({
  ...realDb,
  db: { select: () => ({ from: (table: unknown) => query(table) }) },
}));

const { loadProjectSessionInventory } = await import('./session-list');

function gate(): { held: Promise<void>; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** Let every already-runnable continuation run; a held gate stays held. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const inventoryOf = (over: {
  scope: 'visible' | 'project';
  effectiveRole: 'manager' | 'member';
}) =>
  loadProjectSessionInventory({
    projectId: '00000000-0000-4000-a000-000000000201',
    accountId: '00000000-0000-4000-a000-000000000101',
    userId: '00000000-0000-4000-a000-000000000001',
    boundCredentialSessionId: null,
    probeManageCapability: async () => false,
    ...over,
  });

beforeEach(() => {
  started = [];
  shareSubjectGate = null;
  oversightGate = null;
});

describe('loadProjectSessionInventory — when the first chunk starts', () => {
  test('the visible list reads its first chunk beside the share subject, not after it', async () => {
    const subject = gate();
    shareSubjectGate = subject.held;

    const inventory = inventoryOf({ scope: 'visible', effectiveRole: 'member' });
    await settle();
    // The share subject is still out; the first chunk is already running.
    expect([...started].sort()).toEqual(['first-chunk', 'share-subject']);

    subject.release();
    const result = await inventory;
    expect(result.authorized).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    // One chunk read: the early read is the page's first chunk, not an extra one.
    expect(started.filter((read) => read === 'first-chunk')).toHaveLength(1);
  });

  test('scope=project without manager standing is refused before any row is read', async () => {
    const result = await inventoryOf({ scope: 'project', effectiveRole: 'member' });

    expect(result.authorized).toBe(false);
    expect(started).toEqual(['share-subject']);
  });

  test('scope=project with manager standing reads its first chunk and the oversight policy beside the share subject', async () => {
    const subject = gate();
    const oversight = gate();
    shareSubjectGate = subject.held;
    oversightGate = oversight.held;

    const inventory = inventoryOf({ scope: 'project', effectiveRole: 'manager' });
    await settle();
    // The verdict allowed the scan, so neither read waits for the share subject
    // and the chunk does not wait for the oversight verdict.
    expect([...started].sort()).toEqual(['first-chunk', 'oversight-policy', 'share-subject']);

    subject.release();
    oversight.release();
    const result = await inventory;
    expect(result.authorized).toBe(true);
    expect(started.filter((read) => read === 'first-chunk')).toHaveLength(1);
  });
});
