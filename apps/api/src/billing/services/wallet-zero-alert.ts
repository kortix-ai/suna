/**
 * Tell the account owners when the wallet reaches $0 (KRTX-1718). Agents
 * pause and triggers stop starting sessions; before this, nobody was told
 * until a member hit the out-of-credits notice.
 *
 * Once per account per UTC day. Not on a free plan, where the one owner sees
 * the notice themselves, and not while auto top-up is on: it refills the
 * wallet, and its own email covers a card that fails.
 */
import { chatEventDedup } from '@kortix/db';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';
import { getCreditAccount } from '../repositories/credit-accounts';
import { resolveAccountBilling } from './billing-cache';
import { billingPaneUrl, emailAccountOwners } from './owner-alerts';
import { isPaidTier } from './tiers';

// replica-local: accounts this process already handled today, so a drained
// wallet that keeps settling does not repeat the checks on every debit. The
// claim row is what makes the email once-only across replicas.
const handled = new Set<string>();
const HANDLED_MAX = 10_000;

/** Forget what this process saw, so a test can prove the cross-replica claim. */
export function forgetHandledWalletAlertsForTest(): void {
  handled.clear();
}

/** Email the owners once today if `balance` is $0 or less. Returns how many were emailed. */
export async function alertWalletAtZero(accountId: string, balance: number): Promise<number> {
  if (balance > 0) return 0;
  const key = `billing:wallet-zero:${accountId}:${new Date().toISOString().slice(0, 10)}`;
  if (handled.has(key)) return 0;
  if (handled.size >= HANDLED_MAX) handled.clear();
  handled.add(key);

  const account = await getCreditAccount(accountId);
  if (!account || account.autoTopupEnabled) return 0;
  const { plan } = await resolveAccountBilling(accountId, { row: account });
  if (!isPaidTier(plan.key)) return 0;
  const claimed = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt: new Date(Date.now() + 2 * 86_400_000) })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  if (claimed.length === 0) return 0;

  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(balance);
  const url = billingPaneUrl(accountId);
  const title = 'Out of credits';
  const stopped = 'Agents pause, and triggers stop starting sessions, until credits are added.';
  const note = 'Buy credits, or turn on auto top-up so the balance refills itself.';
  return emailAccountOwners(accountId, (accountName) => ({
    subject: `${accountName} is out of credits`,
    category: 'billing-wallet-zero',
    html: renderEmail({
      kicker: 'Billing',
      title,
      body: `
        <p style="${S.p}">
          The balance of <span style="${S.strong}">${escapeHtml(accountName)}</span> reached
          <span style="${S.strong}">${escapeHtml(amount)}</span>.
        </p>
        <p style="${S.p}">${escapeHtml(stopped)}</p>
        ${actionButton(url, 'Open billing')}
        <p style="${S.smallNote}">${escapeHtml(note)}</p>
      `,
    }),
    text: renderText({
      title,
      paragraphs: [`The balance of ${accountName} reached ${amount}.`, stopped],
      cta: { url, label: 'Open billing' },
      note,
    }),
  }));
}
