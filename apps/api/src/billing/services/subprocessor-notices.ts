/**
 * The 30-day notice before a new subprocessor processes customer personal data
 * (DPA section 7.3). The list and its rules live in
 * `@kortix/shared/subprocessors`: a row with a `noticeDate` is announced from
 * that day until it takes effect.
 *
 * Each open notice goes to the billing managers (owners and admins) of every
 * paid account, once: a claim row in `chat_event_dedup` makes it once-only
 * across replicas and sweeps. Prod only, so a dev or staging deploy of the list
 * emails nobody.
 */
import { creditAccounts } from '@kortix/db';
import {
  formatSubprocessorDate,
  subprocessorEffectiveDate,
  SUBPROCESSORS_CORE,
  SUBPROCESSORS_OPTIONAL,
  type Subprocessor,
} from '@kortix/shared/subprocessors';
import { isNotNull, notInArray, and } from 'drizzle-orm';
import { config } from '../../config';
import { renderEmail, renderText, S, actionButton } from '../../lib/email/template';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';
import { claimOnce } from './access-notices';
import { emailBillingManagers } from './owner-alerts';

const PRIVACY_EMAIL = 'privacy@kortix.com';

export type SubprocessorNotice = { noticeDate: string; effectiveDate: string; rows: Subprocessor[] };

/** The notices open on `today` (`YYYY-MM-DD`): announced, not yet in effect. One per notice date. */
export function openSubprocessorNotices(rows: readonly Subprocessor[], today: string): SubprocessorNotice[] {
  const byDate = new Map<string, SubprocessorNotice>();
  for (const row of rows) {
    const effectiveDate = subprocessorEffectiveDate(row);
    if (!row.noticeDate || !effectiveDate || row.noticeDate > today || effectiveDate <= today) continue;
    const notice = byDate.get(row.noticeDate) ?? { noticeDate: row.noticeDate, effectiveDate, rows: [] };
    notice.rows.push(row);
    byDate.set(row.noticeDate, notice);
  }
  return [...byDate.values()];
}

function compose(notice: SubprocessorNotice, accountName: string) {
  const url = `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/legal/subprocessors`;
  const effective = formatSubprocessorDate(notice.effectiveDate);
  const title = 'New Kortix subprocessors';
  const intro = `Kortix will add the subprocessors below on ${effective}. Until then they process no customer personal data. This notice concerns ${accountName}, as our Data Processing Addendum (section 7.3) requires.`;
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
    for (const { accountId } of paid) {
      if (!(await claimOnce(`legal:subprocessor-notice:${notice.noticeDate}:${accountId}`))) continue;
      await emailBillingManagers(accountId, (accountName) => compose(notice, accountName))
        .then((sent) => { if (sent > 0) accountsNotified++; })
        .catch((err) => logger.warn('[subprocessor-notices] notice failed', { accountId, error: (err as Error).message }));
    }
  }
  if (accountsNotified > 0) logger.info('[subprocessor-notices] notices sent', { accountsNotified });
  return { accountsNotified };
}
