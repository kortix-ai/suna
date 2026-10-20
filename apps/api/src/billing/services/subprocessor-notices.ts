/**
 * The 30-day notice before a new subprocessor processes customer personal data
 * (DPA section 7.3). The list and its rules live in
 * `@kortix/shared/subprocessors`: a row with `addedOn` is announced from the
 * first sweep that sees it on prod until it takes effect.
 *
 * Each open notice goes to the billing managers (owners and admins) of every
 * paid account, once: a claim row in `chat_event_dedup` makes it once-only
 * across replicas and sweeps. Prod only, so a dev or staging deploy of the list
 * emails nobody.
 *
 * Evidence: each notified account gets a `legal.subprocessor_notice.sent`
 * audit event (it shows in that account's audit log), and privacy@kortix.com
 * gets a summary of every sweep that sent, flagged when it gave fewer than 30
 * days.
 */
import { chatEventDedup, creditAccounts } from '@kortix/db';
import {
  formatSubprocessorDate,
  SUBPROCESSOR_NOTICE_DAYS,
  subprocessorEffectiveDate,
  SUBPROCESSORS_CORE,
  SUBPROCESSORS_OPTIONAL,
  type Subprocessor,
} from '@kortix/shared/subprocessors';
import { isNotNull, notInArray, and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { renderEmail, renderText, S, actionButton } from '../../lib/email/template';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import { escapeHtml } from '../../shared/html';
import { claimOnce } from './access-notices';
import { emailBillingManagers, sendAlertEmail } from './owner-alerts';

const PRIVACY_EMAIL = 'privacy@kortix.com';

export type SubprocessorNotice = { addedOn: string; effectiveDate: string; rows: Subprocessor[] };

/** The notices open on `today` (`YYYY-MM-DD`): added, not yet in effect. One per `addedOn` day. */
export function openSubprocessorNotices(rows: readonly Subprocessor[], today: string): SubprocessorNotice[] {
  const byDate = new Map<string, SubprocessorNotice>();
  for (const row of rows) {
    const effectiveDate = subprocessorEffectiveDate(row);
    if (!row.addedOn || !effectiveDate || row.addedOn > today || effectiveDate <= today) continue;
    const notice = byDate.get(row.addedOn) ?? { addedOn: row.addedOn, effectiveDate, rows: [] };
    notice.rows.push(row);
    byDate.set(row.addedOn, notice);
  }
  return [...byDate.values()];
}

function compose(notice: SubprocessorNotice, accountName: string) {
  const url = `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/legal/subprocessors`;
  const effective = formatSubprocessorDate(notice.effectiveDate);
  const title = 'New Kortix subprocessors';
  const intro = `Kortix will add the subprocessors below on ${effective}. Until then they process no customer personal data. You receive this notice as an owner or admin of ${accountName}, as our Data Processing Addendum (section 7.3) requires.`;
  const outro = `To object, reply to this email or write to ${PRIVACY_EMAIL} before ${effective}.`;
  const items = notice.rows.map((row) => `${row.name}: ${row.purpose} (${row.location})`);
  return {
    subject: `Kortix subprocessor update, effective ${effective}`,
    category: 'legal-subprocessor-notice',
    replyTo: PRIVACY_EMAIL,
    html: renderEmail({
      kicker: 'Legal',
      title,
      body: `<p style="${S.p}">${escapeHtml(intro)}</p>${items.map((item) => `<p style="${S.p}">${escapeHtml(item)}</p>`).join('')}<p style="${S.p}">${escapeHtml(outro)}</p>${actionButton(url, 'View all subprocessors')}`,
    }),
    text: renderText({ title, paragraphs: [intro, ...items, outro], cta: { url, label: 'View all subprocessors' } }),
  };
}

/** The hourly sweep: email each open notice to every paid account that has not had it. */
export async function runSubprocessorNoticeSweep(
  now: Date = new Date(),
  rows: readonly Subprocessor[] = [...SUBPROCESSORS_CORE, ...SUBPROCESSORS_OPTIONAL],
): Promise<{ accountsNotified: number }> {
  if (config.INTERNAL_KORTIX_ENV !== 'prod') return { accountsNotified: 0 };
  const notices = openSubprocessorNotices(rows, now.toISOString().slice(0, 10));
  if (notices.length === 0) return { accountsNotified: 0 };

  const paid = await db
    .select({ accountId: creditAccounts.accountId })
    .from(creditAccounts)
    .where(and(isNotNull(creditAccounts.tier), notInArray(creditAccounts.tier, ['free', 'none'])));
  let accountsNotified = 0;
  for (const notice of notices) {
    let sentThisSweep = 0;
    for (const { accountId } of paid) {
      const claim = `legal:subprocessor-notice:${notice.addedOn}:${accountId}`;
      if (!(await claimOnce(claim))) continue;
      try {
        const recipients = await emailBillingManagers(accountId, (accountName) => compose(notice, accountName));
        // Nobody to email yet: release the claim so a later sweep retries the account.
        if (recipients === 0) {
          await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claim));
          continue;
        }
        sentThisSweep++;
        await recordAuditEvent({
          accountId,
          actorType: 'system',
          action: 'legal.subprocessor_notice.sent',
          resourceType: 'subprocessor_notice',
          resourceId: notice.addedOn,
          outputSummary: {
            recipients,
            effective_date: notice.effectiveDate,
            subprocessors: notice.rows.map((row) => row.name),
          },
        });
      } catch (err) {
        logger.warn('[subprocessor-notices] notice failed', { accountId, error: (err as Error).message });
      }
    }
    if (sentThisSweep > 0) await reportToPrivacy(notice, sentThisSweep, now);
    accountsNotified += sentThisSweep;
  }
  return { accountsNotified };
}

/** The compliance record: what went out, to how many accounts, and how much notice it gave. */
async function reportToPrivacy(notice: SubprocessorNotice, accounts: number, now: Date) {
  const days = Math.floor((Date.parse(`${notice.effectiveDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
  const late = days < SUBPROCESSOR_NOTICE_DAYS;
  const title = late
    ? `Subprocessor notice gave only ${days} days`
    : `Subprocessor notice sent to ${accounts} accounts`;
  const paragraphs = [
    `The notice for the subprocessors added ${notice.addedOn} went to the owners and admins of ${accounts} paid accounts in this sweep. It takes effect ${formatSubprocessorDate(notice.effectiveDate)}, ${days} days from now.`,
    ...notice.rows.map((row) => `${row.name}: ${row.purpose} (${row.location})`),
    ...(late
      ? [`The DPA promises ${SUBPROCESSOR_NOTICE_DAYS} days. Send no customer data to these subprocessors until ${SUBPROCESSOR_NOTICE_DAYS} days from now, and move their addedOn in packages/shared/src/subprocessors.ts so the page shows that date.`]
      : []),
    'Each notified account has a legal.subprocessor_notice.sent audit event.',
  ];
  logger.info('[subprocessor-notices] notices sent', { addedOn: notice.addedOn, accounts, days });
  await sendAlertEmail({
    to: [PRIVACY_EMAIL],
    subject: `[Kortix compliance] ${title}`,
    category: 'legal-subprocessor-notice-report',
    html: renderEmail({
      kicker: 'Compliance',
      title,
      body: paragraphs.map((p) => `<p style="${S.p}">${escapeHtml(p)}</p>`).join(''),
    }),
    text: renderText({ title, paragraphs }),
  }).catch((err) => logger.warn('[subprocessor-notices] privacy report failed', { error: (err as Error).message }));
}
