/**
 * DB suite: `POST /v1/setup/bootstrap-owner` creates the first owner's
 * workspace account EXPLICITLY (no account is created at sign-up any more).
 * The route and the database are real; only the Supabase auth admin client is
 * a stand-in, because this database's auth service already holds users and
 * the route refuses once any user exists.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { accounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

const ownerId = crypto.randomUUID();
const email = `owner-${ownerId}@example.test`;
const created: string[] = [];

const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({
  ...realSupabase,
  getSupabase: () => ({
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async (input: { email: string }) => {
          await db.execute(sql`insert into auth.users (id, email) values (${ownerId}::uuid, ${input.email})`);
          created.push(ownerId);
          return { data: { user: { id: ownerId, email: input.email } }, error: null };
        },
      },
    },
  }),
}));

const { db } = await import('../shared/db');
const { config } = await import('../config');
const { setupApp } = await import('./index');
const { accountRoleFor } = await import('../iam/read-models');

afterAll(async () => {
  const rows = await db.execute(sql`select account_id from kortix.account_members where user_id = ${ownerId}::uuid`);
  for (const row of rows as unknown as Array<{ account_id: string }>) {
    await db.delete(accounts).where(eq(accounts.accountId, row.account_id));
  }
  if (created.length) await db.execute(sql`delete from auth.users where id = ${ownerId}::uuid`);
});

describe('POST /v1/setup/bootstrap-owner', () => {
  test('creates the owner and their workspace account, owned by them, its id not their user id', async () => {
    const app = new Hono();
    app.route('/v1/setup', setupApp);
    const res = await app.request('/v1/setup/bootstrap-owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Kortix-Internal-Key': config.INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ email, password: 'long-enough-password' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, created: true, email });

    const rows = (await db.execute(
      sql`select a.account_id, a.name, a.setup_wizard_step from kortix.accounts a
          join kortix.account_members m on m.account_id = a.account_id where m.user_id = ${ownerId}::uuid`,
    )) as unknown as Array<{ account_id: string; name: string; setup_wizard_step: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).not.toBe(ownerId);
    expect(rows[0]!.name).toBe('My workspace');
    expect(rows[0]!.setup_wizard_step).toBe(2);
    expect(await accountRoleFor(rows[0]!.account_id, ownerId)).toBe('owner');
  });
});
