/**
 * Notices before and after access ends (.agents/skills/billing/references/plans-and-access.md):
 * a trial or contract never ends silently.
 *
 *   trial     7, 3 and 1 days before the end, and when it ends
 *   contract  30, 7 and 1 days before a term that does not renew, and when it ends
 *
 * Each notice goes to the account's billing managers (owners and admins) and to
 * Kortix sales (`DEMO_LEAD_NOTIFY_EMAIL`), once: a claim row in
 * `chat_event_dedup` makes it once-only across replicas and sweeps.
 */
import { logger } from '../../lib/logger';
import { chatEventDedup, creditAccounts, enterpriseContracts } from '@kortix/db';
import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { config } from '../../config';
import { actionButton, renderEmail, renderText, S } from '../../lib/email/template';
import { db } from '../../shared/db';
import { escapeHtml } from '../../shared/html';
import { TRIAL_STATUS } from './effective-tier';
import { endExpiredManualContracts } from './enterprise-contracts';
import { billingPaneUrl, emailBillingManagers, sendAlertEmail } from './owner-alerts';
import { ACCESS_GRACE_DAYS } from './resolve-billing';
import { sweepExpiredTrials, trialPlanFor } from './trial-admin';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_WARNING_DAYS = [7, 3, 1] as const;
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

async function claimOnce(key: string): Promise<boolean> {
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

const planName = (plan: string | null) => (trialPlanFor(plan ?? '') === 'enterprise' ? 'Enterprise' : 'Credits');

export async function notifyTrialEnding(accountId: string, plan: string | null, endsAt: string, left: number) {
  const name = planName(plan);
  return send(accountId, 'billing-trial-ending', (accountName) => ({
    subject: `${accountName}: your ${name} trial ends in ${left} day${left === 1 ? '' : 's'}`,
    title: `Your ${name} trial ends ${formatDate(endsAt)}`,
    paragraphs: [
      `${accountName} is on a ${name} trial until ${formatDate(endsAt)}.`,
      name === 'Enterprise'
        ? `After that it returns to the plan it pays for. SSO and SCIM stay on for ${ACCESS_GRACE_DAYS} more days, so nobody is locked out.`
        : 'After that it returns to the plan it pays for.',
      'Upgrade now to keep everything, or reply to talk to us.',
    ],
    cta: 'Upgrade',
  }));
}

export async function notifyTrialEnded(accountId: string, plan: string | null, endedAt: string) {
  const name = planName(plan);
  const enterprise = name === 'Enterprise';
  const graceEnds = new Date(new Date(endedAt).getTime() + ACCESS_GRACE_DAYS * DAY_MS).toISOString();
  return send(accountId, 'billing-trial-ended', (accountName) => ({
    subject: `${accountName}: your ${name} trial has ended`,
    title: `Your ${name} trial has ended`,
    paragraphs: [
      `The ${name} trial of ${accountName} ended on ${formatDate(endedAt)}. The account is back on the plan it pays for.`,
      ...(enterprise ? [`SSO and SCIM stay on until ${formatDate(graceEnds)}.`] : []),
      'Upgrade to get it back.',
    ],
    cta: 'Upgrade',
  }));
}

export async function notifyContractEnding(accountId: string, endsAt: string, left: number) {
  return send(accountId, 'billing-contract-ending', (accountName) => ({
    subject: `${accountName}: your Enterprise contract ends in ${left} day${left === 1 ? '' : 's'}`,
    title: `Your Enterprise contract ends ${formatDate(endsAt)}`,
    paragraphs: [
      `The Enterprise contract of ${accountName} ends on ${formatDate(endsAt)} and does not renew on its own.`,
      `Contact us to renew. Without a renewal the account returns to the plan it pays for, and SSO and SCIM stay on for ${ACCESS_GRACE_DAYS} more days.`,
    ],
    cta: 'Open billing',
  }));
}

export async function notifyContractEnded(accountId: string, graceEnds: string) {
  return send(accountId, 'billing-contract-ended', (accountName) => ({
    subject: `${accountName}: your Enterprise contract has ended`,
    title: 'Your Enterprise contract has ended',
    paragraphs: [
      `The Enterprise contract of ${accountName} has ended. The account is back on the plan it pays for.`,
      `SSO and SCIM stay on until ${formatDate(graceEnds)}. Contact us to renew.`,
    ],
    cta: 'Open billing',
  }));
}

/**
 * The hourly access sweep: expire trials (and tell people), end manual
 * contracts whose term is over, and send the warnings that are due.
 */
export async function runAccessSweep(now: Date = new Date()): Promise<{
  trialsExpired: number;
  contractsEnded: number;
  warningsSent: number;
}> {
  const nowMs = now.getTime();
  const expired = await sweepExpiredTrials(now);
  for (const row of expired) {
    if (!row.trialEndsAt) continue;
    if (await claimOnce(`billing:trial-ended:${row.accountId}:${new Date(row.trialEndsAt).getTime()}`)) {
      await notifyTrialEnded(row.accountId, row.trialTier, row.trialEndsAt).catch((err) =>
        logger.warn('[access-notices] trial-ended notice failed', { error: (err as Error).message }),
      );
    }
  }

  const contractsEnded = await endExpiredManualContracts(now);
  let warningsSent = 0;

  const trials = await db
    .select({ accountId: creditAccounts.accountId, trialTier: creditAccounts.trialTier, trialEndsAt: creditAccounts.trialEndsAt })
    .from(creditAccounts)
    .where(
      and(
        eq(creditAccounts.trialStatus, TRIAL_STATUS.ACTIVE),
        gt(creditAccounts.trialEndsAt, now.toISOString()),
        lte(creditAccounts.trialEndsAt, new Date(nowMs + Math.max(...TRIAL_WARNING_DAYS) * DAY_MS).toISOString()),
      ),
    );
  for (const trial of trials) {
    if (!trial.trialEndsAt) continue;
    const left = daysLeft(trial.trialEndsAt, nowMs);
    const threshold = warningThreshold(left, TRIAL_WARNING_DAYS);
    if (threshold === null) continue;
    if (!(await claimOnce(`billing:trial-ending:${trial.accountId}:${new Date(trial.trialEndsAt).getTime()}:${threshold}`))) continue;
    await notifyTrialEnding(trial.accountId, trial.trialTier, trial.trialEndsAt, left)
      .then(() => warningsSent++)
      .catch((err) => logger.warn('[access-notices] trial warning failed', { error: (err as Error).message }));
  }

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

  return { trialsExpired: expired.length, contractsEnded, warningsSent };
}
