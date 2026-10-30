import { expect, test } from 'bun:test';
import { driveCommitAuthors } from '@kortix/db';
import { recordDriveCommitAuthor } from './events-store';

type Receipt = typeof driveCommitAuthors.$inferInsert;
type Writer = NonNullable<Parameters<typeof recordDriveCommitAuthor>[3]>;
const userId = '11111111-1111-4111-8111-111111111111';
const driveId = '22222222-2222-4222-8222-222222222222';

function receiptWriter() {
  const receipts = new Map<string, Receipt>();
  let inserts = 0;
  let ignoredConflicts = 0;
  const writer = { insert: (table: unknown) => {
    expect(table).toBe(driveCommitAuthors);
    inserts++;
    return { values: (receipt: Receipt) => ({ onConflictDoNothing: async () => {
      const key = `${receipt.driveId}:${receipt.commitId}`;
      if (receipts.has(key)) ignoredConflicts++;
      else receipts.set(key, receipt);
    } }) };
  } } as unknown as Writer;
  return { writer, receipts, get inserts() { return inserts; }, get ignoredConflicts() { return ignoredConflicts; } };
}

test('an explicit provider noop never attributes its existing base commit to the API caller', async () => {
  const state = receiptWriter();
  await recordDriveCommitAuthor(driveId, { commit_id: 'existing-system-commit', head_commit_id: 'newer-head', outcome: 'noop' }, { userId }, state.writer);
  await recordDriveCommitAuthor(driveId, undefined, { userId }, state.writer);
  expect(state.inserts).toBe(0);
  expect(state.receipts.size).toBe(0);
});

test('fast, merged, and queued writes attribute only the actual writer commit', async () => {
  const state = receiptWriter();
  for (const outcome of ['fast', 'merged', 'queued'] as const) {
    await recordDriveCommitAuthor(driveId, { commit_id: `writer-${outcome}`, head_commit_id: 'someone-elses-head', outcome }, { userId }, state.writer);
    expect(state.receipts.get(`${driveId}:writer-${outcome}`)).toEqual({ driveId, commitId: `writer-${outcome}`, authorUserId: userId, authorSessionId: null });
  }
  expect(state.inserts).toBe(3);
  expect(state.receipts.has(`${driveId}:someone-elses-head`)).toBe(false);
});

test('a session takes author precedence and a later caller cannot replace its receipt', async () => {
  const state = receiptWriter();
  const commit = { commit_id: 'writer-session', head_commit_id: 'merged-head', outcome: 'merged' as const };
  await recordDriveCommitAuthor(driveId, commit, { userId, sessionId: 'session-one' }, state.writer);
  await recordDriveCommitAuthor(driveId, commit, { userId }, state.writer);
  expect(state.receipts.get(`${driveId}:writer-session`)).toEqual({ driveId, commitId: 'writer-session', authorUserId: null, authorSessionId: 'session-one' });
  expect(state.receipts.size).toBe(1);
  expect(state.ignoredConflicts).toBe(1);
});

test('a committed write with no verified actor fails before inserting attribution', async () => {
  const state = receiptWriter();
  await expect(recordDriveCommitAuthor(driveId, { commit_id: 'writer-one', outcome: 'fast' }, {}, state.writer)).rejects.toThrow('needs a user or session');
  expect(state.inserts).toBe(0);
});
