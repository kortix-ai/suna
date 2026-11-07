/**
 * DB suite: the workspace_id fill job (workspaces/id-fill.ts). Real schema,
 * real triggers. Synthetic accounts only.
 *
 *   - fills NULL workspace_id on a keyset table (credit_accounts) and a
 *     ctid-walked table (account_session_activity, composite key);
 *   - leaves a split_pending account's rows NULL;
 *   - the `workspace_id_fill` setting pauses it;
 *   - a batch that cannot take its row locks (lock_timeout) rolls back with
 *     its progress, and the next tick resumes at the same cursor.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, platformSettings, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '../shared/db';
import {
  runWorkspaceIdFillTick,
  WORKSPACE_ID_FILL_PROGRESS_KEY,
  WORKSPACE_ID_FILL_SETTING_KEY,
  workspaceIdFillProgress,
} from './id-fill';

const LIVE = crypto.randomUUID();
const LEGACY = crypto.randomUUID();
const USER = crypto.randomUUID();
const SESSIONS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

async function setControl(value: Record<string, unknown> | null) {
  if (value === null) {
    await db.delete(platformSettings).where(eq(platformSettings.key, WORKSPACE_ID_FILL_SETTING_KEY));
    return;
  }
  await db
    .insert(platformSettings)
    .values({ key: WORKSPACE_ID_FILL_SETTING_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

async function resetProgress() {
  await db.delete(platformSettings).where(eq(platformSettings.key, WORKSPACE_ID_FILL_PROGRESS_KEY));
}

/** Empty workspace_id on the suite's rows, as on a table the M7 column was just added to. */
async function clearFill() {
  await db.execute(sql`UPDATE kortix.credit_accounts SET workspace_id = NULL WHERE account_id IN (${LIVE}::uuid, ${LEGACY}::uuid)`);
  await db.execute(sql`UPDATE kortix.account_session_activity SET workspace_id = NULL WHERE account_id IN (${LIVE}::uuid, ${LEGACY}::uuid)`);
}

async function stamped(table: 'credit_accounts' | 'account_session_activity', accountId: string): Promise<Array<string | null>> {
  const rows = await db.execute<{ workspace_id: string | null }>(
    sql`SELECT workspace_id::text AS workspace_id FROM kortix.${sql.raw(table)} WHERE account_id = ${accountId}::uuid ORDER BY 1`,
  );
  return rows.map((row) => row.workspace_id);
}

async function runToEnd(limit = 2_000): Promise<number> {
  for (let i = 0; i < limit; i++) {
    const tick = await runWorkspaceIdFillTick();
    if (tick.state !== 'filled') return i;
  }
  throw new Error('the fill did not finish');
}

let liveWorkspace = '';

beforeAll(async () => {
  await db.execute(sql`insert into auth.users (id, email) values (${USER}::uuid, ${`fill-${USER.slice(0, 8)}@example.test`})`);
  await db.insert(accounts).values([
    { accountId: LIVE, name: 'fill-live' },
    { accountId: LEGACY, name: 'fill-legacy' },
  ]);
  await db.insert(projects).values({ projectId: crypto.randomUUID(), accountId: LIVE, name: 'fill-live', repoUrl: 'https://example.invalid/fill-live.git' });
  for (let i = 0; i < 2; i++) {
    await db.insert(projects).values({
      projectId: crypto.randomUUID(),
      accountId: LEGACY,
      name: `fill-legacy-${i}`,
      repoUrl: `https://example.invalid/fill-legacy-${i}.git`,
      splitPending: true,
    });
  }
  for (const accountId of [LIVE, LEGACY]) {
    await db.execute(sql`INSERT INTO kortix.credit_accounts (account_id) VALUES (${accountId}::uuid) ON CONFLICT (account_id) DO NOTHING`);
  }
  for (const sessionId of SESSIONS) {
    await db.execute(sql`INSERT INTO kortix.account_session_activity (account_id, user_id, session_id) VALUES (${LIVE}::uuid, ${USER}::uuid, ${sessionId}::uuid)`);
  }
  await db.execute(sql`INSERT INTO kortix.account_session_activity (account_id, user_id, session_id) VALUES (${LEGACY}::uuid, ${USER}::uuid, ${crypto.randomUUID()}::uuid)`);
  const [row] = await db.execute<{ id: string }>(sql`SELECT kortix.workspace_id_of_account(${LIVE}::uuid)::text AS id`);
  liveWorkspace = row!.id;
  expect(liveWorkspace).toMatch(/^[0-9a-f-]{36}$/);
  await setControl({ batch_rows: 1_000 });
});

afterAll(async () => {
  await setControl(null);
  await resetProgress();
  await db.execute(sql`DELETE FROM kortix.account_session_activity WHERE account_id IN (${LIVE}::uuid, ${LEGACY}::uuid)`);
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id IN (${LIVE}::uuid, ${LEGACY}::uuid)`);
  await db.delete(projects).where(inArray(projects.accountId, [LIVE, LEGACY]));
  await db.delete(accounts).where(inArray(accounts.accountId, [LIVE, LEGACY]));
  await db.execute(sql`delete from auth.users where id = ${USER}::uuid`);
});

describe('the workspace_id fill job', () => {
  test('the M7 trigger stamps new rows; the fill stamps the NULL ones, a keyset table and a ctid table alike', async () => {
    expect(await stamped('credit_accounts', LIVE)).toEqual([liveWorkspace]);
    await clearFill();
    await resetProgress();
    expect(await stamped('account_session_activity', LIVE)).toEqual([null, null, null]);

    const ticks = await runToEnd();
    expect(ticks).toBeGreaterThan(0);
    expect(await stamped('credit_accounts', LIVE)).toEqual([liveWorkspace]);
    expect(await stamped('account_session_activity', LIVE)).toEqual([liveWorkspace, liveWorkspace, liveWorkspace]);
    const progress = await workspaceIdFillProgress();
    expect(progress?.finished_at).not.toBeNull();
    expect(progress!.rows).toBeGreaterThanOrEqual(4);
    expect(progress!.targets.every((target) => target.done)).toBe(true);
    const walks = Object.fromEntries(progress!.targets.map((target) => [target.table, target.walk]));
    expect(walks.credit_accounts).toBe('key');
    expect(walks.account_session_activity).toBe('ctid');
    // Finished: the next tick writes nothing and idles.
    expect((await runWorkspaceIdFillTick()).state).toBe('finished');
  });

  test('a split_pending account keeps NULL (the split fills it after its last move)', async () => {
    expect(await stamped('credit_accounts', LEGACY)).toEqual([null]);
    expect(await stamped('account_session_activity', LEGACY)).toEqual([null]);
  });

  test('paused: no batch runs; unpaused: the fill resumes', async () => {
    await clearFill();
    await resetProgress();
    await setControl({ paused: true, batch_rows: 1_000 });
    expect((await runWorkspaceIdFillTick()).state).toBe('paused');
    expect(await workspaceIdFillProgress()).toBeNull();
    expect(await stamped('credit_accounts', LIVE)).toEqual([null]);
    await setControl({ batch_rows: 1_000 });
    await runToEnd();
    expect(await stamped('credit_accounts', LIVE)).toEqual([liveWorkspace]);
  });

  test('a batch that cannot take its row locks rolls back with its progress; the next tick resumes there', async () => {
    await clearFill();
    await resetProgress();
    // Step to the credit_accounts batch.
    for (let i = 0; i < 2_000; i++) {
      const progress = await workspaceIdFillProgress();
      const current = progress?.targets.find((target) => !target.done);
      if (current?.table === 'credit_accounts') break;
      expect((await runWorkspaceIdFillTick()).state).toBe('filled');
    }
    const before = await workspaceIdFillProgress();
    expect(before?.targets.find((target) => !target.done)?.table).toBe('credit_accounts');

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM kortix.credit_accounts WHERE account_id = ${LIVE}::uuid FOR UPDATE`);
      locked();
      await released;
    });
    await holding;
    await expect(runWorkspaceIdFillTick()).rejects.toThrow();
    release();
    await holder;
    expect(await workspaceIdFillProgress()).toEqual(before);
    expect(await stamped('credit_accounts', LIVE)).toEqual([null]);

    await runToEnd();
    expect(await stamped('credit_accounts', LIVE)).toEqual([liveWorkspace]);
  }, 30_000);
});
