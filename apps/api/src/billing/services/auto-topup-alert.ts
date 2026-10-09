/**
 * Tell the account owners when auto top-up turns itself off (KRTX-1718).
 *
 * A hard decline, or the third failed charge in a row, turns auto top-up off.
 * Before this, the only trace was a log line and a stored reason no screen
 * showed; the wallet then ran down to $0 and sessions and triggers stopped
 * with nobody told.
 */
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { escapeHtml } from '../../shared/html';
import { billingPaneUrl, emailAccountOwners } from './owner-alerts';

const REASON_TEXT: Record<string, string> = {
  insufficient_funds: 'The card has insufficient funds.',
  expired_card: 'The card has expired.',
  card_declined: 'The card was declined.',
  do_not_honor: 'The bank declined the charge.',
  incorrect_cvc: "The card's security code was rejected.",
  authentication_required: 'The bank asked for authentication, which an automatic charge cannot give.',
  no_payment_method: 'There is no saved payment method.',
};

/** Email every owner of the account. Returns how many emails were handed to the transport. */
export function notifyAutoTopupDisabled(accountId: string, reason: string): Promise<number> {
  const reasonText = REASON_TEXT[reason] ?? 'The charge failed.';
  const url = billingPaneUrl(accountId);
  const title = 'Auto top-up is off';
  const stopped =
    'Kortix turned auto top-up off so it stops charging. When the balance reaches $0, sessions and triggers stop.';
  const note = 'Update the payment method, then turn auto top-up back on.';
  return emailAccountOwners(accountId, (accountName) => ({
    subject: `Auto top-up is off for ${accountName}`,
    category: 'billing-auto-topup-disabled',
    html: renderEmail({
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
    }),
    text: renderText({
      title,
      paragraphs: [`The last automatic charge for ${accountName} failed. ${reasonText} (${reason})`, stopped],
      cta: { url, label: 'Open billing' },
      note,
    }),
  }));
}
