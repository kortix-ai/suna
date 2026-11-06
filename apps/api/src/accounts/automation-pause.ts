/**
 * Pause all triggers (KRTX-1721): one switch per account stops every
 * automatic fire in every project of the account — schedules and reminders,
 * webhooks, app events and monitors. A manual fire still runs, as with a
 * project's own pause. A schedule slot missed while paused fires once on
 * resume, like downtime.
 *
 * `accounts.automations_paused_at` is the switch; `automations_paused_by` says
 * who flipped it. Pausing an already paused account keeps the first stamp.
 */
import { type AnyColumn, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../shared/db';
import { accountsView, updateAccountRowsReturning } from '../workspaces/rows';

export const ACCOUNT_AUTOMATIONS_PAUSED_REASON = 'account automations are paused';

export interface AccountAutomationPause {
  pausedAt: Date;
  pausedBy: string | null;
}

export async function readAccountAutomationPause(accountId: string): Promise<AccountAutomationPause | null> {
  const [row] = await db
    .select({ pausedAt: accountsView.automationsPausedAt, pausedBy: accountsView.automationsPausedBy })
    .from(accountsView)
    .where(eq(accountsView.accountId, accountId))
    .limit(1);
  return row?.pausedAt ? { pausedAt: row.pausedAt, pausedBy: row.pausedBy } : null;
}

/** Pause or resume; returns the pause now in effect (null = running). */
export async function setAccountAutomationsPaused(input: {
  accountId: string;
  paused: boolean;
  userId: string;
}): Promise<AccountAutomationPause | null> {
  const [row] = await updateAccountRowsReturning(
    eq(accountsView.accountId, input.accountId),
    input.paused
      ? {
          automationsPausedAt: sql`coalesce(${accountsView.automationsPausedAt}, now())`,
          automationsPausedBy: sql`case when ${accountsView.automationsPausedAt} is null then ${input.userId}::uuid else ${accountsView.automationsPausedBy} end`,
        }
      : { automationsPausedAt: null, automationsPausedBy: null },
  );
  return row?.automationsPausedAt ? { pausedAt: row.automationsPausedAt, pausedBy: row.automationsPausedBy } : null;
}

/** For a claim query: true while the account behind `accountId` lets automations run. */
export function accountAutomationsRunSql(accountId: AnyColumn): SQL {
  return sql`not exists (select 1 from ${accountsView} where ${accountsView.accountId} = ${accountId} and ${accountsView.automationsPausedAt} is not null)`;
}
