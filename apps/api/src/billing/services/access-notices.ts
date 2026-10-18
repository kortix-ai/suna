/**
 * Notices before and after an Enterprise license ends
 * (.agents/skills/billing/references/plans-and-access.md): a license never
 * ends silently.
 *
 *   license  30, 7 and 1 days before a term that does not renew, and when it ends
 *
 * Each notice goes to the account's billing managers (owners and admins) and to
 * Kortix sales (`DEMO_LEAD_NOTIFY_EMAIL`), once: a claim row in
 * `chat_event_dedup` makes it once-only across replicas and sweeps.
 */
import { logger } from '../../lib/logger';
import { chatEventDedup, enterpriseContracts } from '@kortix/db';
import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { config } from '../../config';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';
import { endExpiredManualContracts } from './enterprise-contracts';
import { billingPaneUrl, emailBillingManagers, sendAlertEmail } from './owner-alerts';
import { ACCESS_GRACE_DAYS } from './resolve-billing';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CONTRACT_WARNING_DAYS = [30, 7, 1] as const;

/** Whole days until `endsAt`, rounded up (0 once it has passed). */
export function daysLeft(endsAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - nowMs) / DAY_MS));
}

/** The smallest warning threshold `left` days falls under, or null when none applies yet. */
export function warningThreshold(left: number, thresholds: readonly number[]): number | null {
  const due = thresholds.filter((t) => left <= t);
  return due.length > 0 ? Math.min(...due) : null;
}

export async function claimOnce(key: string): Promise<boolean> {
  const claimed = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt: new Date(Date.now() + 120 * DAY_MS) })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  return claimed.length > 0;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

type Notice = { subject: string; title: string; paragraphs: string[]; cta: string };

async function send(accountId: string, category: string, notice: (accountName: string) => Notice): Promise<number> {
  const url = billingPaneUrl(accountId);
  let accountLabel = accountId;
  const sent = await emailBillingManagers(accountId, (accountName) => {
    accountLabel = accountName;
    const n = notice(accountName);
    return {
      subject: n.subject,
      category,
      html: renderEmail({
        kicker: 'Billing',
        title: n.title,
        body: `${n.paragraphs.map((p) => `<p style="${S.p}">${escapeHtml(p)}</p>`).join('')}${actionButton(url, n.cta)}`,
      }),
      text: renderText({ title: n.title, paragraphs: n.paragraphs, cta: { url, label: n.cta } }),
    };
  });
  // Kortix sales hears about every one, so an expiring contract customer gets a call, not just an email.
  const ops = (config.DEMO_LEAD_NOTIFY_EMAIL || '').split(',').map((e) => e.trim()).filter(Boolean);
  if (ops.length > 0) {
    const n = notice(accountLabel);
    await sendAlertEmail({
      to: ops,
      subject: `[Kortix billing] ${n.subject}`,
      category: `${category}-ops`,
      html: renderEmail({
        kicker: 'Billing ops',
        title: n.title,
        body: `<p style="${S.p}">Account <span style="${S.strong}">${escapeHtml(accountLabel)}</span> (${escapeHtml(accountId)}).</p>${n.paragraphs.map((p) => `<p style="${S.p}">${escapeHtml(p)}</p>`).join('')}`,
      }),
      text: renderText({ title: n.title, paragraphs: [`Account ${accountLabel} (${accountId}).`, ...n.paragraphs] }),
    }).catch((err) => logger.warn('[access-notices] ops email failed', { error: (err as Error).message }));
  }
  return sent;
}

export async function notifyContractEnding(accountId: string, endsAt: string, left: number) {
  return send(accountId, 'billing-contract-ending', (accountName) => ({
    subject: `${accountName}: your Enterprise license ends in ${left} day${left === 1 ? '' : 's'}`,
    title: `Your Enterprise license ends ${formatDate(endsAt)}`,
    paragraphs: [
      `The Enterprise license of ${accountName} ends on ${formatDate(endsAt)} and does not renew on its own.`,
      `Contact us to renew. Without a renewal the Enterprise features turn off; SSO and SCIM stay on for ${ACCESS_GRACE_DAYS} more days. Credits and the plan are not affected.`,
    ],
    cta: 'Open billing',
  }));
}

export async function notifyContractEnded(accountId: string, graceEnds: string) {
  return send(accountId, 'billing-contract-ended', (accountName) => ({
    subject: `${accountName}: your Enterprise license has ended`,
    title: 'Your Enterprise license has ended',
    paragraphs: [
      `The Enterprise license of ${accountName} has ended, so its Enterprise features are off. Credits and the plan are not affected.`,
      `SSO and SCIM stay on until ${formatDate(graceEnds)}. Contact us to renew.`,
    ],
    cta: 'Open billing',
  }));
}

/**
 * The hourly access sweep: end manual licenses whose term is over, and send the
 * warnings that are due.
 */
export async function runAccessSweep(now: Date = new Date()): Promise<{
  contractsEnded: number;
  warningsSent: number;
}> {
  const nowMs = now.getTime();
  const contractsEnded = await endExpiredManualContracts(now);
  let warningsSent = 0;

  const contracts = await db
    .select({ id: enterpriseContracts.id, accountId: enterpriseContracts.accountId, endsAt: enterpriseContracts.endsAt })
    .from(enterpriseContracts)
    .where(
      and(
        eq(enterpriseContracts.status, 'active'),
        eq(enterpriseContracts.autoRenews, false),
        isNotNull(enterpriseContracts.endsAt),
        gt(enterpriseContracts.endsAt, now.toISOString()),
        lte(enterpriseContracts.endsAt, new Date(nowMs + Math.max(...CONTRACT_WARNING_DAYS) * DAY_MS).toISOString()),
      ),
    );
  for (const contract of contracts) {
    if (!contract.endsAt) continue;
    const left = daysLeft(contract.endsAt, nowMs);
    const threshold = warningThreshold(left, CONTRACT_WARNING_DAYS);
    if (threshold === null) continue;
    if (!(await claimOnce(`billing:contract-ending:${contract.id}:${new Date(contract.endsAt).getTime()}:${threshold}`))) continue;
    await notifyContractEnding(contract.accountId, contract.endsAt, left)
      .then(() => warningsSent++)
      .catch((err) => logger.warn('[access-notices] contract warning failed', { error: (err as Error).message }));
  }

  return { contractsEnded, warningsSent };
}
