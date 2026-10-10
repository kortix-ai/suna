/**
 * "Ask an owner to top up" (KRTX-1718). A member blocked by an empty wallet
 * cannot buy credits (`billing.write` is owner-only by default) and had no way
 * to tell an owner from inside the product. This emails every owner, at most
 * once a day per member and account.
 */
import { chatEventDedup } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../../accounts/core/owner-emails';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';
import { getCreditAccount } from '../repositories/credit-accounts';
import { billingPaneUrl, emailAccountOwners } from './owner-alerts';

/** One request per member and account in this window. */
export const TOP_UP_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Claim this member's request for the window, in the shared single-winner
 * dedup table (no migration). An expired claim is taken over in the same
 * statement, so the window needs no reaper.
 */
async function claimTopUpRequest(accountId: string, userId: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + TOP_UP_REQUEST_WINDOW_MS);
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: `billing:top-up-request:${accountId}:${userId}`, expiresAt })
    .onConflictDoUpdate({
      target: chatEventDedup.eventId,
      set: { expiresAt },
      setWhere: sql`${chatEventDedup.expiresAt} < now()`,
    })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0;
}

/**
 * Email the owners that `requesterEmail` needs credits. Null when this member
 * already asked within the window. The caller has checked membership and that
 * the member cannot add credits themselves.
 */
export async function requestTopUp(input: {
  accountId: string;
  requesterUserId: string;
  requesterEmail: string | null;
}): Promise<{ notified: number } | null> {
  if (!(await claimTopUpRequest(input.accountId, input.requesterUserId))) return null;
  const account = await getCreditAccount(input.accountId);
  const balance = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(account?.balance) || 0,
  );
  const requester =
    input.requesterEmail?.trim() ||
    (await lookupEmailsByUserIds([input.requesterUserId])).get(input.requesterUserId) ||
    'A member';
  const url = billingPaneUrl(input.accountId);
  const title = 'Add credits';
  const note = 'Add credits, or turn on auto top-up so the balance refills itself.';
  const notified = await emailAccountOwners(input.accountId, (accountName) => ({
    subject: `${requester} asked you to add credits to ${accountName}`,
    category: 'billing-top-up-request',
    html: renderEmail({
      kicker: 'Billing',
      title,
      body: `
        <p style="${S.p}">
          <span style="${S.strong}">${escapeHtml(requester)}</span> can't run agents in
          <span style="${S.strong}">${escapeHtml(accountName)}</span>: the balance is
          <span style="${S.strong}">${escapeHtml(balance)}</span>.
        </p>
        ${actionButton(url, 'Open billing')}
        <p style="${S.smallNote}">${escapeHtml(note)}</p>
      `,
    }),
    text: renderText({
      title,
      paragraphs: [`${requester} can't run agents in ${accountName}: the balance is ${balance}.`],
      cta: { url, label: 'Open billing' },
      note,
    }),
  }));
  return { notified };
}
