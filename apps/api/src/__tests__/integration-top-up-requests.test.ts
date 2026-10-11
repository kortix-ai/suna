/**
 * Integration test (real local DB): a member out of credits asks the owners
 * (KRTX-1718). One request per member and account a day; an expired claim is
 * taken over without a reaper. Captured: the email transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, chatEventDedup, creditAccounts } from '@kortix/db';
import { eq, like, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { requestTopUp } from '../billing/services/top-up-requests';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const email = (id: string, label: string) => `top-up-${label}-${id.slice(0, 8)}@example.test`;

let team: SeededProject;
let sent: EmailMessage[] = [];

beforeAll(async () => {
  team = await seedProject('top-up-requests');
  const user = (id: string, label: string) =>
    sql`(${id}::uuid, ${email(id, label)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`;
  await db.execute(sql`
    insert into auth.users (id, email, instance_id, aud, role)
    values ${user(OWNER, 'owner')}, ${user(MEMBER, 'member')}, ${user(OTHER, 'other')}`);
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: team.account_id, accountRole: 'owner' });
  for (const id of [MEMBER, OTHER]) {
    await insertIntoView(db, accountMembers, { userId: id, accountId: team.account_id, accountRole: 'member' });
  }
  await db.insert(creditAccounts).values({ accountId: team.account_id, tier: 'pro', balance: '0.42' });
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  if (!team) return;
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `billing:top-up-request:${team.account_id}:%`));
  await db.delete(creditAccounts).where(eq(creditAccounts.accountId, team.account_id));
  await removeSeeded([team]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${MEMBER}::uuid, ${OTHER}::uuid)`);
});

const ask = (userId: string) =>
  requestTopUp({ accountId: team.account_id, requesterUserId: userId, requesterEmail: null });

describe('a member asks the owners for credits', () => {
  test('the owner gets one email naming the member, the account and the balance', async () => {
    expect(await ask(MEMBER)).toEqual({ notified: 1 });
    expect(sent.map((m) => m.to)).toEqual([[email(OWNER, 'owner')]]);
    expect(sent[0]!.subject).toBe(`${email(MEMBER, 'member')} asked you to add credits to top-up-requests-account`);
    expect(sent[0]!.text).toContain("can't run agents in top-up-requests-account: the balance is $0.42.");
    expect(sent[0]!.text).toContain(`/projects?accountId=${team.account_id}&accountTab=billing`);
    expect(sent[0]!.category).toBe('billing-top-up-request');
  });

  test('the same member again within the day is refused, and nobody is emailed', async () => {
    expect(await ask(MEMBER)).toBeNull();
    expect(sent).toEqual([]);
  });

  test('another member has a request of their own', async () => {
    expect(await ask(OTHER)).toEqual({ notified: 1 });
  });

  test('a day later the claim is taken over: the member can ask again', async () => {
    await db
      .update(chatEventDedup)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(chatEventDedup.eventId, `billing:top-up-request:${team.account_id}:${MEMBER}`));
    expect(await ask(MEMBER)).toEqual({ notified: 1 });
    expect(await ask(MEMBER)).toBeNull();
  });
});
