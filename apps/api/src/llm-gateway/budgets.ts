import { and, eq, sql } from 'drizzle-orm';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import type { AuthedPrincipal } from '@kortix/llm-gateway';
import { db } from '../shared/db';

type Period = 'day' | 'week' | 'month';

async function spendForPeriod(
  projectId: string,
  subjectUserId: string | null,
  period: Period,
): Promise<number> {
  const conds = [
    eq(gatewayRequestLogs.projectId, projectId),
    sql`${gatewayRequestLogs.createdAt} >= date_trunc(${period}, now())`,
  ];
  if (subjectUserId) conds.push(eq(gatewayRequestLogs.actorUserId, subjectUserId));
  const [agg] = await db
    .select({ cost: sql<number>`coalesce(sum(${gatewayRequestLogs.finalCost}), 0)::float8` })
    .from(gatewayRequestLogs)
    .where(and(...conds));
  return agg?.cost ?? 0;
}

export async function checkBudget(
  principal: AuthedPrincipal,
): Promise<{ exceeded: boolean; message?: string }> {
  if (!principal.projectId) return { exceeded: false };

  const budgets = await db
    .select()
    .from(gatewayBudgets)
    .where(
      and(eq(gatewayBudgets.projectId, principal.projectId), eq(gatewayBudgets.action, 'block')),
    );
  if (budgets.length === 0) return { exceeded: false };

  for (const b of budgets) {
    if (b.scope === 'member' && b.subjectUserId !== principal.userId) continue;
    const subject = b.scope === 'member' ? b.subjectUserId : null;
    const spent = await spendForPeriod(principal.projectId, subject, b.period as Period);
    const limit = Number(b.limitUsd);
    if (spent >= limit) {
      const who = b.scope === 'member' ? 'Your' : "This project's";
      return {
        exceeded: true,
        message: `${who} gateway budget ($${limit}/${b.period}) is exhausted — $${spent.toFixed(2)} used this ${b.period}.`,
      };
    }
  }
  return { exceeded: false };
}
