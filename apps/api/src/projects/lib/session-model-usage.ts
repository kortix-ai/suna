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
  /** Route id recorded for the request — the model that answered it, or on an
   *  unanswered request the model it was being served by. */
  served_model: string;
  /** The model the request was rerouted to after a failed attempt, whether or
   *  not the fallback answered. */
  fallback_from: string | null;
  at: string;
  /** How the request ended: `answered` (a model answered it), `client_aborted`
   *  (the caller canceled it) or `error` (it failed outright). A cancel is not
   *  a model failure — the UI must not present one as such (KRTX-2572). */
  outcome: 'answered' | 'client_aborted' | 'error';
}

export interface TurnModelUsage {
  /** Route ids of the models that answered in this turn, most requests first. */
  served_models: string[];
  fallback_from: string | null;
  /** Successful fallback requests in chronological order. No raw provider errors. */
  fallbacks?: { requested_model: string; served_model: string; error_code: string }[];
  /** What Kortix debited for this turn's model calls, in USD. */
  billed_cost: number;
}

export interface SessionModelUsage {
  /** The newest request and how it ended. Null before the first request. */
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
export const servedModelSql = sql<string>`coalesce(
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

// Provider codes are untrusted too: only known public categories may leave the ledger.
function publicFailureCode(failures: unknown, requested: string): string {
  const failure = Array.isArray(failures)
    ? failures.find((value) => value && typeof value === 'object' && value.routeModel === requested)
    : undefined;
  const code: unknown = failure?.code;
  if (code === 429) return 'rate_limit_exceeded';
  if (code === 401 || code === 403) return 'authentication_error';
  switch (code) {
    case 'provider_pool_rate_limited':
    case 'provider_reauth_required':
    case 'provider_not_connected':
    case 'model_busy':
    case 'model_unavailable':
    case 'rate_limit_exceeded':
    case 'context_length_exceeded':
    case 'upstream_timeout':
    case 'upstream_inactivity_timeout':
    case 'upstream_incomplete_stream':
    case 'upstream_stream_error':
      return code;
    default:
      return 'upstream_error';
  }
}

export async function sessionModelUsage(session: {
  sessionId: string;
  projectId: string;
}): Promise<SessionModelUsage> {
  const ofSession = and(eq(logs.projectId, session.projectId), eq(logs.sessionId, session.sessionId));
  const [[latest], [total], perTurn, fallbackRequests] = await Promise.all([
    // Include canceled requests so latest cannot stay pinned to an older answer.
    db
      .select({ served: servedModelSql, fallbackFrom: fallbackFromSql, at: logs.createdAt, ok: logs.ok, errorCode: logs.errorCode })
      .from(logs)
      .where(ofSession)
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
    // Keep route pairs on the same successful request, not on independent
    // aggregates. Use the same turn attribution as spend, including late logs.
    db.execute<{ message_id: string; requested: string; served: string; failures: unknown }>(sql`
      select turn.message_id, ${fallbackFromSql} as requested,
             ${servedModelSql} as served, ${logs.metadata}->'attemptFailures' as failures
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
      where ${ofSession} and ${logs.ok}
        and ${fallbackFromSql} is not null
      order by ${logs.createdAt}, ${logs.requestId}
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
  for (const row of fallbackRequests) {
    const turn = turns[row.message_id];
    if (!turn) continue;
    (turn.fallbacks ??= []).push({
      requested_model: row.requested,
      served_model: row.served,
      error_code: publicFailureCode(row.failures, row.requested),
    });
  }
  return {
    latest: latest
      ? {
          served_model: latest.served,
          fallback_from: latest.fallbackFrom ?? null,
          at: latest.at.toISOString(),
          outcome: latest.ok ? 'answered' : latest.errorCode === 'client_aborted' ? 'client_aborted' : 'error',
        }
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
