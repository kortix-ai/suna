import { usageEvents } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';

export interface UsageEventInput {
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  actorUserId?: string | null;
  provider: string;
  model: string;
  route: string;
  /** Server-owned key. Duplicate writes return the original durable event. */
  idempotencyKey?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  streaming?: boolean;
  upstreamStatus?: number | null;
  metadata?: Record<string, unknown>;
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
    idempotencyKey: input.idempotencyKey || null,
    inputTokens: positiveInteger(input.inputTokens),
    outputTokens: positiveInteger(input.outputTokens),
    cachedTokens: positiveInteger(input.cachedTokens),
    cacheWriteTokens: positiveInteger(input.cacheWriteTokens),
    costUsd: String(input.costUsd ?? 0),
    streaming: input.streaming ?? false,
    upstreamStatus: input.upstreamStatus ?? null,
    metadata: input.metadata ?? {},
  };
  if (!input.idempotencyKey) {
    const [row] = await db
      .insert(usageEvents)
      .values(values)
      .returning({ eventId: usageEvents.eventId });
    return row?.eventId ?? null;
  }

  const [inserted] = await db
    .insert(usageEvents)
    .values(values)
    .onConflictDoNothing({
      target: [usageEvents.accountId, usageEvents.idempotencyKey],
      where: sql`${usageEvents.idempotencyKey} is not null`,
    })
    .returning({ eventId: usageEvents.eventId });
  if (inserted) return inserted.eventId;

  const [existing] = await db
    .select({ eventId: usageEvents.eventId })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.accountId, input.accountId),
        eq(usageEvents.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  return existing?.eventId ?? null;
}
