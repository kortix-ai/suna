/**
 * The 30-day notice of a material change to the Terms of Service (Terms
 * section 16). The version, its effective date and the changes live in
 * `@kortix/shared/terms`: a version with changes is announced from the first
 * sweep that sees it on prod until it takes effect.
 *
 * Same rules as `subprocessor-notices.ts`: the billing managers (owners and
 * admins) of every paid account, once (a claim row in `chat_event_dedup`),
 * prod only. Evidence: a `legal.terms_notice.sent` audit event per account,
 * and a summary to legal@kortix.com for every sweep that sent.
 */
import { chatEventDedup, creditAccounts } from '@kortix/db';
import { formatSubprocessorDate } from '@kortix/shared/subprocessors';
import { TERMS_CHANGES, TERMS_EFFECTIVE, TERMS_NOTICE_DAYS, TERMS_VERSION } from '@kortix/shared/terms';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { config } from '../../config';
import { renderEmail, renderText, S, actionButton } from '../../lib/email/template';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import { escapeHtml } from '../../shared/html';
import { claimOnce } from './access-notices';
import { emailBillingManagers, sendAlertEmail } from './owner-alerts';

const LEGAL_EMAIL = 'legal@kortix.com';

export type TermsChange = { version: string; effectiveDate: string; changes: readonly string[] };

const CURRENT: TermsChange = { version: TERMS_VERSION, effectiveDate: TERMS_EFFECTIVE, changes: TERMS_CHANGES };

function compose(change: TermsChange, accountName: string) {
  const url = `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/legal?tab=terms`;
  const effective = formatSubprocessorDate(change.effectiveDate);
  const title = 'Kortix Terms of Service update';
  const intro = `We are updating the Kortix Terms of Service. Version ${change.version} takes effect on ${effective}. You receive this notice as an owner or admin of ${accountName}, as section 16 of the Terms requires.`;
  const outro = `Questions or objections: reply to this email or write to ${LEGAL_EMAIL} before ${effective}. If you keep using Kortix after that date, the new version applies.`;
  return {
    subject: `Kortix Terms of Service update, effective ${effective}`,
    category: 'legal-terms-notice',
    replyTo: LEGAL_EMAIL,
    html: renderEmail({
      kicker: 'Legal',
      title,
      body: `<p style="${S.p}">${escapeHtml(intro)}</p>${change.changes.map((item) => `<p style="${S.p}">${escapeHtml(item)}</p>`).join('')}<p style="${S.p}">${escapeHtml(outro)}</p>${actionButton(url, 'Read the Terms')}`,
    }),
    text: renderText({ title, paragraphs: [intro, ...change.changes, outro], cta: { url, label: 'Read the Terms' } }),
  };
}

/** The hourly sweep: email an open Terms change to every paid account that has not had it. */
export async function runTermsNoticeSweep(
  now: Date = new Date(),
  change: TermsChange = CURRENT,
): Promise<{ accountsNotified: number }> {
  if (config.INTERNAL_KORTIX_ENV !== 'prod') return { accountsNotified: 0 };
  const today = now.toISOString().slice(0, 10);
  if (change.changes.length === 0 || change.version > today || change.effectiveDate <= today) return { accountsNotified: 0 };

  const paid = await db
    .select({ accountId: creditAccounts.accountId })
    .from(creditAccounts)
    .where(and(isNotNull(creditAccounts.tier), notInArray(creditAccounts.tier, ['free', 'none'])));
  let accountsNotified = 0;
  for (const { accountId } of paid) {
    const claim = `legal:terms-notice:${change.version}:${accountId}`;
    if (!(await claimOnce(claim))) continue;
    try {
      const recipients = await emailBillingManagers(accountId, (accountName) => compose(change, accountName));
      // Nobody to email yet: release the claim so a later sweep retries the account.
      if (recipients === 0) {
        await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claim));
        continue;
      }
      accountsNotified++;
      await recordAuditEvent({
        accountId,
        actorType: 'system',
        action: 'legal.terms_notice.sent',
        resourceType: 'terms_notice',
        resourceId: change.version,
        outputSummary: { recipients, effective_date: change.effectiveDate },
      });
    } catch (err) {
      logger.warn('[terms-notices] notice failed', { accountId, error: (err as Error).message });
    }
  }
  if (accountsNotified > 0) await reportToLegal(change, accountsNotified, now);
  return { accountsNotified };
}

/** The compliance record: what went out, to how many accounts, and how much notice it gave. */
async function reportToLegal(change: TermsChange, accounts: number, now: Date) {
  const days = Math.floor((Date.parse(`${change.effectiveDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
  const late = days < TERMS_NOTICE_DAYS;
  const title = late ? `Terms notice gave only ${days} days` : `Terms notice sent to ${accounts} accounts`;
  const paragraphs = [
    `The notice for Terms version ${change.version} went to the owners and admins of ${accounts} paid accounts in this sweep. It takes effect ${formatSubprocessorDate(change.effectiveDate)}, ${days} days from now.`,
    ...change.changes,
    ...(late
      ? [`Terms section 16 promises ${TERMS_NOTICE_DAYS} days. Move TERMS_EFFECTIVE in packages/shared/src/terms.ts to at least ${TERMS_NOTICE_DAYS} days from now, and do not rely on the new terms before then.`]
      : []),
    'Each notified account has a legal.terms_notice.sent audit event.',
  ];
  logger.info('[terms-notices] notices sent', { version: change.version, accounts, days });
  await sendAlertEmail({
    to: [LEGAL_EMAIL],
    subject: `[Kortix compliance] ${title}`,
    category: 'legal-terms-notice-report',
    html: renderEmail({
      kicker: 'Compliance',
      title,
      body: paragraphs.map((p) => `<p style="${S.p}">${escapeHtml(p)}</p>`).join(''),
    }),
    text: renderText({ title, paragraphs }),
  }).catch((err) => logger.warn('[terms-notices] legal report failed', { error: (err as Error).message }));
}
