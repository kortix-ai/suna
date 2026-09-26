import { usageEvents } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { errorSqlstate } from './error-cause';

export interface UsageEventInput {
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  provider: string;
  model: string;
  route: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  streaming?: boolean;
  upstreamStatus?: number | null;
  metadata?: Record<string, unknown>;
  /**
   * The LLM gateway request this row settles. At most one row exists per
   * request id: a repeated call returns the first row's id and writes nothing.
   */
  requestId?: string | null;
}

function positiveInteger(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export async function recordUsageEvent(input: UsageEventInput): Promise<string | null> {
  const values = {
    accountId: input.accountId,
    projectId: input.projectId || null,
    sessionId: input.sessionId || null,
    actorUserId: input.actorUserId || null,
    provider: input.provider,
    model: input.model,
    route: input.route,
    inputTokens: positiveInteger(input.inputTokens),
    outputTokens: positiveInteger(input.outputTokens),
    cachedTokens: positiveInteger(input.cachedTokens),
    cacheWriteTokens: positiveInteger(input.cacheWriteTokens),
    costUsd: String(input.costUsd ?? 0),
    streaming: input.streaming ?? false,
    upstreamStatus: input.upstreamStatus ?? null,
    metadata: input.metadata ?? {},
    requestId: input.requestId || null,
  };
  if (!values.requestId) {
    const [row] = await db.insert(usageEvents).values(values).returning({ eventId: usageEvents.eventId });
    return row?.eventId ?? null;
  }
  const requestId = values.requestId;
  try {
    const [row] = await db
      .insert(usageEvents)
      .values(values)
      .onConflictDoNothing({ target: usageEvents.requestId, where: sql`${usageEvents.requestId} is not null` })
      .returning({ eventId: usageEvents.eventId });
    if (row) return row.eventId;
  } catch (error) {
    // 42P10: no unique index matches the ON CONFLICT target — the index
    // migration has not run here, or its CONCURRENTLY build failed and left it
    // INVALID. Settlement must not stop for that: write the row without the
    // dedupe and say so.
    if (errorSqlstate(error) !== '42P10') throw error;
    console.error('[usage-events] uniq_usage_events_request_id is missing; usage settlement is not deduplicated');
    const [row] = await db.insert(usageEvents).values(values).returning({ eventId: usageEvents.eventId });
    return row?.eventId ?? null;
  }
  // A settlement of this request is already recorded: hand back its row, so
  // every downstream idempotency key derived from the row id repeats too.
  const [existing] = await db
    .select({ eventId: usageEvents.eventId })
    .from(usageEvents)
    .where(eq(usageEvents.requestId, requestId))
    .limit(1);
  return existing?.eventId ?? null;
}
