/**
 * Email the people who manage a project's gateway budgets when one reaches
 * 80% and 100% of its limit, once per threshold per period (KRTX-1718).
 *
 * A 'warn' budget used to produce one log line per request and nothing a
 * person saw; a 'block' budget refused requests with nobody told in advance.
 * The recipients are the account owners and admins and the project managers:
 * the people who can change a budget.
 */
import { chatEventDedup, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../accounts/core/owner-emails';
import { sendAlertEmail } from '../billing/services/owner-alerts';
import { config } from '../config';
import { accountRoleMap, isAccountManagerRole, projectRoleGrants } from '../iam/read-models';
import { actionButton, renderEmail, renderText, S } from '../lib/email/template';
import { db } from '../shared/db';
import { escapeHtml } from '../shared/html';
import type { BudgetCrossing, Period } from './budgets';

const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 31 };
const PERIOD_WORD: Record<Period, string> = { day: 'daily', week: 'weekly', month: 'monthly' };

/** The start of the budget's current period, as `date_trunc(period, now())` in UTC. */
export function startOfBudgetPeriod(period: Period, now: Date = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === 'month') start.setUTCDate(1);
  return start;
}

// replica-local: crossings this process already claimed or saw claimed, so a
// busy project does not write the claim row on every request. The claim row
// is what makes the email once-only across replicas.
const handled = new Set<string>();
const HANDLED_MAX = 10_000;

/** Forget what this process saw, so a test can prove the cross-replica claim. */
export function forgetHandledBudgetAlertsForTest(): void {
  handled.clear();
}

async function claimOnce(key: string, expiresAt: Date): Promise<boolean> {
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0;
}

/** Tell the budget's managers about each crossing not told yet this period. Never throws. */
export async function alertBudgetCrossings(projectId: string, crossings: BudgetCrossing[]): Promise<number> {
  let sent = 0;
  for (const crossing of crossings) {
    const start = startOfBudgetPeriod(crossing.period);
    const key = `billing:budget-alert:${crossing.budgetId}:${crossing.threshold}:${start.toISOString()}`;
    if (handled.has(key)) continue;
    if (handled.size >= HANDLED_MAX) handled.clear();
    handled.add(key);
    const expiresAt = new Date(start.getTime() + (PERIOD_DAYS[crossing.period] + 1) * 86_400_000);
    if (!(await claimOnce(key, expiresAt))) continue;
    sent += await emailBudgetManagers(projectId, crossing);
  }
  return sent;
}

async function emailBudgetManagers(projectId: string, crossing: BudgetCrossing): Promise<number> {
  const [project] = await db
    .select({ name: projects.name, accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return 0;
  const [accountRoles, grants] = await Promise.all([
    accountRoleMap(project.accountId),
    projectRoleGrants({ accountId: project.accountId, projectId }),
  ]);
  const managerIds = [
    ...[...accountRoles].filter(([, role]) => isAccountManagerRole(role)).map(([userId]) => userId),
    ...grants.filter((g) => g.projectRole === 'manager').map((g) => g.userId),
  ];
  const emails = await lookupEmailsByUserIds([
    ...managerIds,
    ...(crossing.subjectUserId ? [crossing.subjectUserId] : []),
  ]);
  const recipients = [...new Set(managerIds.map((id) => emails.get(id)).filter((e): e is string => !!e))];
  if (recipients.length === 0) return 0;

  const projectName = project.name?.trim() || 'a project';
  const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  const member = crossing.subjectUserId ? emails.get(crossing.subjectUserId) || 'A member' : null;
  const whose = member ? `${member}'s ${PERIOD_WORD[crossing.period]} budget in ${projectName}` : `The ${PERIOD_WORD[crossing.period]} budget of ${projectName}`;
  const status = `${whose} is at ${usd(crossing.spentUsd)} of ${usd(crossing.limitUsd)} (${Math.floor((crossing.spentUsd / crossing.limitUsd) * 100)}%).`;
  const consequence =
    crossing.action === 'warn'
      ? 'It is a warn-only budget: requests keep running.'
      : crossing.threshold === 100
        ? `It blocks: new requests are refused until the ${crossing.period} resets.`
        : `At 100% it blocks new requests until the ${crossing.period} resets.`;
  const subject = member
    ? `${member} reached ${crossing.threshold}% of a gateway budget in ${projectName}`
    : `${projectName} reached ${crossing.threshold}% of its gateway budget`;
  const url = `${(config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/projects/${projectId}/customize/models`;
  const title = `Gateway budget at ${crossing.threshold}%`;
  const html = renderEmail({
    kicker: 'Budget',
    title,
    body: `
      <p style="${S.p}">${escapeHtml(status)}</p>
      <p style="${S.p}">${escapeHtml(consequence)}</p>
      ${actionButton(url, 'Open budgets')}
    `,
  });
  const text = renderText({ title, paragraphs: [status, consequence], cta: { url, label: 'Open budgets' } });
  await Promise.all(
    recipients.map((to) => sendAlertEmail({ to: [to], subject, html, text, category: 'billing-budget-alert' })),
  );
  return recipients.length;
}
