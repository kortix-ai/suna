/**
 * Tell the account owners when auto top-up turns itself off (KRTX-1718).
 *
 * A hard decline, or the third failed charge in a row, turns auto top-up off.
 * Before this, the only trace was a log line and a stored reason no screen
 * showed; the wallet then ran down to $0 and sessions and triggers stopped
 * with nobody told. `billing.write` is owner-only by default, so the owners
 * are the people who can fix the card.
 */
import { accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../../accounts/core/owner-emails';
import { config } from '../../config';
import { accountRoleMap } from '../../iam/read-models';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { sendEmail } from '../../lib/email/transport';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';

const REASON_TEXT: Record<string, string> = {
  insufficient_funds: 'The card has insufficient funds.',
  expired_card: 'The card has expired.',
  card_declined: 'The card was declined.',
  do_not_honor: 'The bank declined the charge.',
  incorrect_cvc: "The card's security code was rejected.",
  authentication_required: 'The bank asked for authentication, which an automatic charge cannot give.',
  no_payment_method: 'There is no saved payment method.',
};

let send = sendEmail;

/** Capture the alert emails in a test; `null` restores the real transport. */
export function setAutoTopupAlertSenderForTest(sender: typeof sendEmail | null): void {
  send = sender ?? sendEmail;
}

/** The account's Billing pane: the hub opened over the project list. */
export function billingPaneUrl(accountId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/projects?accountId=${encodeURIComponent(accountId)}&accountTab=billing`;
}

/** Email every owner of the account. Returns how many emails were handed to the transport. */
export async function notifyAutoTopupDisabled(accountId: string, reason: string): Promise<number> {
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

  const accountName = account?.name?.trim() || 'your Kortix account';
  const reasonText = REASON_TEXT[reason] ?? 'The charge failed.';
  const url = billingPaneUrl(accountId);
  const title = 'Auto top-up is off';
  const stopped =
    'Kortix turned auto top-up off so it stops charging. When the balance reaches $0, sessions and triggers stop.';
  const note = 'Update the payment method, then turn auto top-up back on.';
  const html = renderEmail({
    kicker: 'Billing',
    title,
    body: `
      <p style="${S.p}">
        The last automatic charge for <span style="${S.strong}">${escapeHtml(accountName)}</span> failed.
        ${escapeHtml(reasonText)} (${escapeHtml(reason)})
      </p>
      <p style="${S.p}">${escapeHtml(stopped)}</p>
      ${actionButton(url, 'Open billing')}
      <p style="${S.smallNote}">${escapeHtml(note)}</p>
    `,
  });
  const text = renderText({
    title,
    paragraphs: [`The last automatic charge for ${accountName} failed. ${reasonText} (${reason})`, stopped],
    cta: { url, label: 'Open billing' },
    note,
  });

  await Promise.all(
    recipients.map((to) =>
      send({ to: [to], subject: `Auto top-up is off for ${accountName}`, html, text, category: 'billing-auto-topup-disabled' }),
    ),
  );
  return recipients.length;
}
