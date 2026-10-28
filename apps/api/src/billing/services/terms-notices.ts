/**
 * The 30-day notice of a material change to the Terms of Service (Terms
 * section 16). The version, its effective date and the changes live in
 * `@kortix/shared/terms`: a version with changes is announced from the first
 * sweep that sees it on prod until it takes effect.
 *
 * Every signed-up user gets it once, free or paid: a claim row in
 * `chat_event_dedup` per user. Each sweep sends at most `batch` emails, so a
 * large user base drains over several hourly sweeps instead of one burst.
 * Prod only. Evidence: a `legal.terms_notice.sent` audit event per user, and
 * a summary to legal@kortix.com for every sweep that sent.
 */
import { chatEventDedup } from '@kortix/db';
import { formatSubprocessorDate } from '@kortix/shared/subprocessors';
import { TERMS_CHANGES, TERMS_EFFECTIVE, TERMS_NOTICE_DAYS, TERMS_VERSION } from '@kortix/shared/terms';
import { eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import { renderEmail, renderText, S, actionButton } from '../../lib/email/template';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import { escapeHtml } from '../../shared/html';
import { claimOnce } from './access-notices';
import { sendAlertEmail } from './owner-alerts';

const LEGAL_EMAIL = 'legal@kortix.com';
// ponytail: fixed batch, 48k emails a day; raise it if the email provider's quota allows and the notice runs late.
const BATCH = 2000;

export type TermsChange = { version: string; effectiveDate: string; changes: readonly string[] };

const CURRENT: TermsChange = { version: TERMS_VERSION, effectiveDate: TERMS_EFFECTIVE, changes: TERMS_CHANGES };

function compose(change: TermsChange) {
  const url = `${(config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '')}/legal?tab=terms`;
  const effective = formatSubprocessorDate(change.effectiveDate);
  const title = 'Kortix Terms of Service update';
  const intro = `We are updating the Kortix Terms of Service. Version ${change.version} takes effect on ${effective} and applies to every Kortix account, free or paid. You receive this notice because you have a Kortix account, as section 16 of the Terms requires.`;
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

/** The hourly sweep: email an open Terms change to the next `batch` users that have not had it. */
export async function runTermsNoticeSweep(
  now: Date = new Date(),
  change: TermsChange = CURRENT,
  batch: number = BATCH,
): Promise<{ usersNotified: number }> {
  if (config.INTERNAL_KORTIX_ENV !== 'prod') return { usersNotified: 0 };
  const today = now.toISOString().slice(0, 10);
  if (change.changes.length === 0 || change.version > today || change.effectiveDate <= today) return { usersNotified: 0 };

  const prefix = `legal:terms-notice:${change.version}:`;
  const users = (await db.execute(sql`
    SELECT u.id::text AS id, u.email
      FROM auth.users u
     WHERE u.email IS NOT NULL AND u.deleted_at IS NULL AND NOT coalesce(u.is_anonymous, false)
       AND NOT EXISTS (SELECT 1 FROM kortix.chat_event_dedup d WHERE d.event_id = ${prefix} || u.id::text)
     ORDER BY u.created_at
     LIMIT ${batch}
  `)) as unknown as Array<{ id: string; email: string }>;

  const message = compose(change);
  let usersNotified = 0;
  for (const user of users) {
    const claim = `${prefix}${user.id}`;
    if (!(await claimOnce(claim))) continue;
    try {
      const result = await sendAlertEmail({ ...message, to: [user.email] });
      // Not sent: release the claim so a later sweep retries the user.
      if (!result.ok) {
        await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claim));
        continue;
      }
      usersNotified++;
      await recordAuditEvent({
        actorType: 'system',
        action: 'legal.terms_notice.sent',
        resourceType: 'terms_notice',
        resourceId: change.version,
        outputSummary: { user_id: user.id, effective_date: change.effectiveDate },
      });
    } catch (err) {
      await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claim));
      logger.warn('[terms-notices] notice failed', { userId: user.id, error: (err as Error).message });
    }
  }
  // One report when the backlog is done, and one per sweep while the notice runs late.
  const late = daysLeft(change, now) < TERMS_NOTICE_DAYS;
  if (usersNotified > 0 && (users.length < batch || late)) {
    const [{ total }] = (await db.execute(sql`
      SELECT count(*)::int AS total FROM kortix.chat_event_dedup WHERE event_id LIKE ${prefix + '%'}
    `)) as unknown as Array<{ total: number }>;
    await reportToLegal(change, total, users.length < batch, now);
  }
  return { usersNotified };
}

function daysLeft(change: TermsChange, now: Date): number {
  return Math.floor((Date.parse(`${change.effectiveDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
}

/** The compliance record: how many users have the notice, and how much notice it gave. */
async function reportToLegal(change: TermsChange, users: number, done: boolean, now: Date) {
  const days = daysLeft(change, now);
  const late = days < TERMS_NOTICE_DAYS;
  const title = late ? `Terms notice gave only ${days} days` : `Terms notice sent to ${users} users`;
  const paragraphs = [
    `The notice for Terms version ${change.version} has gone to ${users} users${done ? ', every signed-up user' : ' so far'}. It takes effect ${formatSubprocessorDate(change.effectiveDate)}, ${days} days from now.`,
    ...change.changes,
    ...(late
      ? [`Terms section 16 promises ${TERMS_NOTICE_DAYS} days. Move TERMS_EFFECTIVE in packages/shared/src/terms.ts to at least ${TERMS_NOTICE_DAYS} days from now, and do not rely on the new terms before then.`]
      : []),
    'Each notified user has a legal.terms_notice.sent audit event.',
  ];
  logger.info('[terms-notices] notices sent', { version: change.version, users, days });
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
