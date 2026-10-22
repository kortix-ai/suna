/**
 * Email the billing managers of an account (KRTX-1718): the owners and admins,
 * the two roles that hold `billing.write` and can add credits, fix a card or
 * accept a plan. One helper for every billing alert: auto top-up turned off,
 * a member asking for credits, a trial or contract about to end.
 */
import { accounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../../accounts/core/owner-emails';
import { config } from '../../config';
import { accountRoleMap } from '../../iam/read-models';
import type { EmailMessage } from '../../lib/email/types';
import { sendEmail } from '../../lib/email/transport';
import { db } from '../../shared/db';

let send = sendEmail;

/** Capture the alert emails in a test; `null` restores the real transport. */
export function setOwnerAlertSenderForTest(sender: typeof sendEmail | null): void {
  send = sender ?? sendEmail;
}

/** Hand one billing alert email to the transport (the seam above captures it in tests). */
export function sendAlertEmail(message: EmailMessage) {
  return send(message);
}

/** The account's Billing pane: the hub opened over the project list. */
export function billingPaneUrl(accountId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/projects?accountId=${encodeURIComponent(accountId)}&accountTab=billing`;
}

/**
 * Email every billing manager (owner or admin) of the account the message
 * `compose` builds from the account's name. Returns how many emails were
 * handed to the transport.
 */
export async function emailBillingManagers(
  accountId: string,
  compose: (accountName: string) => Omit<EmailMessage, 'to'>,
): Promise<number> {
  let managers = [...(await accountRoleMap(accountId))]
    .filter(([, role]) => role === 'owner' || role === 'admin')
    .map(([userId]) => userId);
  // A Suna-era account still billed has its owner only in basejump.account_user.
  if (managers.length === 0) managers = await legacyOwners(accountId);
  if (managers.length === 0) return 0;
  const [emails, [account]] = await Promise.all([
    lookupEmailsByUserIds(managers),
    db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, accountId)).limit(1),
  ]);
  const recipients = [...new Set([...emails.values()].filter((email): email is string => !!email))];
  if (recipients.length === 0) return 0;
  const message = compose(account?.name?.trim() || 'your Kortix account');
  await Promise.all(recipients.map((to) => send({ ...message, to: [to] })));
  return recipients.length;
}

async function legacyOwners(accountId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT user_id::text AS user_id FROM basejump.account_user
     WHERE account_id = ${accountId}::uuid AND account_role = 'owner'
  `)) as unknown as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}
