/**
 * Which model answered a session's requests, and what Kortix billed for them.
 * The runtime transcript does not know: a harness records the model it asked
 * for, and prices a turn from that. When the gateway answers from a fallback
 * model, only its request ledger (`gateway_request_logs`) holds the model that
 * answered and the cost that was debited.
 */
import { gatewayRequestLogs, sessionTurns } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { kortixBilledSpendSql, providerBilledSpendSql, totalSpendSql } from '../../shared/llm-spend';

export interface ServedModel {
  /** Route id of the model that answered, as the model picker names it. */
  served_model: string;
  /** The model the request was routed to, when a fallback model answered in its place. */
  fallback_from: string | null;
  at: string;
}

export interface TurnModelUsage {
  /** Route ids of the models that answered in this turn, most requests first. */
  served_models: string[];
  fallback_from: string | null;
  /** What Kortix debited for this turn's model calls, in USD. */
  billed_cost: number;
}

export interface SessionModelUsage {
  /** The newest answered request. Null before the first answer. */
  latest: ServedModel | null;
  billed_cost: number;
  /** Keyed by the runtime message id of the prompt that started the turn. */
  turns: Record<string, TurnModelUsage>;
}

const logs = gatewayRequestLogs;

// A trace records both ids since the gateway started writing them. An older
// row is read from its own columns: `resolved_model` is a route id only on a
// Kortix-served row (on an own key or ChatGPT plan it is the upstream's id),
// and a fallback always left a failed attempt behind.
const servedModelSql = sql<string>`coalesce(
  ${logs.metadata}->>'servedModel',
  case when ${logs.provider} = 'kortix' then ${logs.resolvedModel} else ${logs.requestedModel} end
)`;
const fallbackFromSql = sql<string | null>`case
  when ${logs.metadata} ? 'servedModel' then ${logs.metadata}->>'fallbackFrom'
  when ${logs.provider} = 'kortix'
    and ${logs.resolvedModel} <> ${logs.requestedModel}
    and jsonb_array_length(coalesce(${logs.metadata}->'attemptFailures', '[]'::jsonb)) > 0
    then ${logs.requestedModel}
end`;

export async function sessionModelUsage(session: {
  sessionId: string;
  projectId: string;
}): Promise<SessionModelUsage> {
  const ofSession = and(eq(logs.projectId, session.projectId), eq(logs.sessionId, session.sessionId));
  const [[latest], [total], perTurn] = await Promise.all([
    db
      .select({ served: servedModelSql, fallbackFrom: fallbackFromSql, at: logs.createdAt })
      .from(logs)
      .where(and(ofSession, eq(logs.ok, true)))
      .orderBy(desc(logs.createdAt))
      .limit(1),
    db.select({ cost: kortixBilledSpendSql }).from(logs).where(ofSession),
    // A request belongs to the last turn that started before it was logged. A
    // trace is written when its request ends, which can be after the turn's own
    // end was recorded, so the turn's end time is not a bound.
    db.execute<{ message_id: string; served: string; fallback_from: string | null; answered: number; cost: number }>(sql`
      select turn.message_id,
             ${servedModelSql} as served,
             min(${fallbackFromSql}) as fallback_from,
             count(*) filter (where ${logs.ok})::int as answered,
             ${kortixBilledSpendSql} as cost
      from ${logs}
      cross join lateral (
        select ${sessionTurns.messageId} as message_id
        from ${sessionTurns}
        where ${sessionTurns.sessionId} = ${logs.sessionId}
          and ${sessionTurns.messageId} is not null
          and ${sessionTurns.startedAt} <= ${logs.createdAt}
        order by ${sessionTurns.startedAt} desc
        limit 1
      ) turn
      where ${ofSession}
      group by turn.message_id, served
      order by answered desc
    `),
  ]);

  const turns: Record<string, TurnModelUsage> = {};
  for (const row of perTurn) {
    const turn = (turns[row.message_id] ??= { served_models: [], fallback_from: null, billed_cost: 0 });
    // A served model with no answered request is a failed attempt, not an answer.
    if (row.answered > 0) turn.served_models.push(row.served);
    turn.fallback_from ??= row.fallback_from;
    turn.billed_cost = Number((turn.billed_cost + Number(row.cost)).toFixed(10));
  }
  return {
    latest: latest
      ? { served_model: latest.served, fallback_from: latest.fallbackFrom ?? null, at: latest.at.toISOString() }
      : null,
    billed_cost: Number(total?.cost ?? 0),
    turns,
  };
}

/**
 * A project's model spend in the last `days`, grouped by the model that
 * answered. Grouped by the requested model, a fallback's Kortix charges read as
 * spend on the ChatGPT plan or own key that did not answer.
 */
export async function projectSpendByModel(projectId: string, days: number) {
  const rows = await db
    .select({
      model: servedModelSql,
      provider: logs.provider,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where not ${logs.ok})::int`,
      cost: totalSpendSql,
      kortixCost: kortixBilledSpendSql,
      providerCost: providerBilledSpendSql,
      tokens: sql<string>`coalesce(sum(${logs.inputTokens} + ${logs.outputTokens}), 0)`,
    })
    .from(logs)
    .where(and(eq(logs.projectId, projectId), sql`${logs.createdAt} >= now() - make_interval(days => ${days})`))
    .groupBy(servedModelSql, logs.provider)
    .orderBy(desc(sql`count(*)`))
    .limit(12);
  return rows.map((row) => ({
    model: row.model,
    provider: row.provider,
    requests: row.requests,
    errors: row.errors,
    cost: row.cost,
    kortix_cost: row.kortixCost,
    provider_cost: row.providerCost,
    tokens: Number(row.tokens),
  }));
}
