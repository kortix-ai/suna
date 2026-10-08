/**
 * Email the owners of an account about its billing (KRTX-1718). `billing.write`
 * is owner-only by default, so the owners are the people who can add credits
 * or fix a card. One helper for every billing alert: auto top-up turned off,
 * a member asking for credits.
 */
import { accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
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

/** The account's Billing pane: the hub opened over the project list. */
export function billingPaneUrl(accountId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/projects?accountId=${encodeURIComponent(accountId)}&accountTab=billing`;
}

/**
 * Email every owner of the account the message `compose` builds from the
 * account's name. Returns how many emails were handed to the transport.
 */
export async function emailAccountOwners(
  accountId: string,
  compose: (accountName: string) => Omit<EmailMessage, 'to'>,
): Promise<number> {
  const owners = [...(await accountRoleMap(accountId))]
    .filter(([, role]) => role === 'owner')
    .map(([userId]) => userId);
  if (owners.length === 0) return 0;
  const [emails, [account]] = await Promise.all([
    lookupEmailsByUserIds(owners),
    db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, accountId)).limit(1),
  ]);
  const recipients = [...new Set([...emails.values()].filter((email): email is string => !!email))];
  if (recipients.length === 0) return 0;
  const message = compose(account?.name?.trim() || 'your Kortix account');
  await Promise.all(recipients.map((to) => send({ ...message, to: [to] })));
  return recipients.length;
}
