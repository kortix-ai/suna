/**
 * Integration test (real local DB): which account brands a self-host
 * instance's sign-in page (`GET /v1/access/branding`).
 *
 * The rule is a permission decision: the sign-in page is the instance's face,
 * so only accounts the operator controls may set it. Those are team accounts
 * (on a self-host instance only a platform admin creates one) and the personal
 * account of a self-host operator (`KORTIX_PLATFORM_ADMIN_EMAILS`, never an SSO
 * identity: KRTX-1715). A member's own personal account never counts. Among the
 * accounts that count, the oldest one wins.
 *
 * A self-host customer ran the company in the operator's personal account, and
 * the first version of this rule (team accounts only) ignored it.
 */
import { describe, expect, test } from 'bun:test';
import { accounts } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { loadOldestOperatorBranding } from '../accounts/instance-branding';
import { db } from '../shared/db';

const OPERATOR = '00000000-0000-4000-8000-00000000b001';
const MEMBER = '00000000-0000-4000-8000-00000000b002';
const SSO_LOOKALIKE = '00000000-0000-4000-8000-00000000b003';
const TEAM = '00000000-0000-4000-8000-00000000b101';

const OPERATOR_EMAIL = 'operator@example.test';

async function insertUser(id: string, email: string, sso = false): Promise<void> {
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role, is_sso_user, raw_app_meta_data)
    values (${id}::uuid, ${email}, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${sso}, ${JSON.stringify({ provider: sso ? 'sso:00000000-0000-4000-8000-0000000000aa' : 'email' })}::jsonb)
    on conflict (id) do nothing`);
}

async function insertAccount(id: string, name: string, createdAt: string, appName: string): Promise<void> {
  await db
    .insert(accounts)
    .values({ accountId: id, name, createdAt: new Date(createdAt), branding: { app_name: appName } })
    .onConflictDoUpdate({
      target: accounts.accountId,
      set: { createdAt: new Date(createdAt), branding: { app_name: appName } },
    });
}

const pick = async (operators: string[]) => (await loadOldestOperatorBranding(operators))?.app_name ?? null;

describe('instance branding: which account brands the sign-in page', () => {
  test('team accounts and an operator personal account count; a member or SSO lookalike never does', async () => {
    // The oldest branded account is a member's personal account: it never counts.
    await insertUser(MEMBER, 'member@example.test');
    await insertAccount(MEMBER, 'Member', '2026-01-01T00:00:00Z', 'Member Brand');
    expect(await pick([OPERATOR_EMAIL])).toBeNull();

    // An SSO identity that asserts the operator's address is not the operator.
    await insertUser(SSO_LOOKALIKE, OPERATOR_EMAIL, true);
    await insertAccount(SSO_LOOKALIKE, 'Lookalike', '2026-01-02T00:00:00Z', 'Lookalike Brand');
    expect(await pick([OPERATOR_EMAIL])).toBeNull();

    // A team account counts.
    await insertAccount(TEAM, 'Team', '2026-03-01T00:00:00Z', 'Team Brand');
    expect(await pick([OPERATOR_EMAIL])).toBe('Team Brand');

    // The operator's personal account counts too (email matched case-blind),
    // and it is older than the team account, so it wins.
    await insertUser(OPERATOR, 'Operator@Example.test');
    await insertAccount(OPERATOR, 'Company', '2026-02-01T00:00:00Z', 'Operator Brand');
    expect(await pick([OPERATOR_EMAIL])).toBe('Operator Brand');

    // With no operator configured, only team accounts count.
    expect(await pick([])).toBe('Team Brand');
  });
});
