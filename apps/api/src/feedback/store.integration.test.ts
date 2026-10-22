// `kortix.feedback` on PostgreSQL: the insert the route performs, the CHECK
// constraints it relies on, and the created_at index the triage read uses.
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { createFeedbackStore, type InsertFeedbackInput } from './index';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const store = createFeedbackStore(db);
const USER_A = '00000000-0000-4000-8000-00000000000a';

withDb('feedback store', () => {
  beforeEach(async () => {
    await db.execute(sql`delete from kortix.feedback where user_id = ${USER_A}`);
  });

  test('an insert persists every column and reads back', async () => {
    const row = await store.insert({
      userId: USER_A,
      accountId: '00000000-0000-4000-8000-0000000000aa',
      source: 'agent',
      kind: 'bug',
      message: 'the doctor command loses the host name',
      context: { session_id: 'sess-1', project_id: 'proj-1' },
    });
    expect(row.id).toBeString();
    const [read] = (await db.execute(
      sql`select * from kortix.feedback where user_id = ${USER_A}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(read).toMatchObject({
      id: row.id,
      user_id: USER_A,
      account_id: '00000000-0000-4000-8000-0000000000aa',
      source: 'agent',
      kind: 'bug',
      message: 'the doctor command loses the host name',
      context: { session_id: 'sess-1', project_id: 'proj-1' },
    });
    expect(read!.created_at).toBeTruthy();
  });

  test('a null context and account store as SQL NULL', async () => {
    const row = await store.insert({
      userId: USER_A,
      accountId: null,
      source: 'cli',
      kind: 'idea',
      message: 'no context attached',
      context: null,
    });
    const [read] = (await db.execute(
      sql`select * from kortix.feedback where id = ${row.id}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(read!.context).toBeNull();
    expect(read!.account_id).toBeNull();
  });

  test('the CHECK constraints reject an unknown source or kind', async () => {
    const constraintOf = async (bad: InsertFeedbackInput) => {
      const err = (await store.insert(bad).catch((e) => e)) as {
        cause?: { code?: string; constraint_name?: string };
      };
      // drizzle wraps the postgres error; the cause carries SQLSTATE 23514
      // (check_violation) and the constraint's own name.
      expect(err).toBeInstanceOf(Error);
      expect(err.cause?.code).toBe('23514');
      return err.cause?.constraint_name;
    };
    expect(
      await constraintOf({
        userId: USER_A,
        accountId: null,
        source: 'sms' as InsertFeedbackInput['source'],
        kind: 'bug',
        message: 'm',
        context: null,
      }),
    ).toBe('feedback_source');
    expect(
      await constraintOf({
        userId: USER_A,
        accountId: null,
        source: 'cli',
        kind: 'complaint' as InsertFeedbackInput['kind'],
        message: 'm',
        context: null,
      }),
    ).toBe('feedback_kind');
  });
});
