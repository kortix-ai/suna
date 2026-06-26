import { usageEvents } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from './db';

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
  // Request id — the idempotency key. When set, a UNIQUE index makes a replay a
  // no-op (onConflictDoNothing) so the caller can skip a duplicate debit.
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordUsageEventResult {
  /** The event id — of the newly-inserted row, or the pre-existing one on conflict. */
  eventId: string | null;
  /** True only when THIS call inserted the row. False = a duplicate request_id existed. */
  inserted: boolean;
}

function positiveInteger(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export async function recordUsageEvent(input: UsageEventInput): Promise<RecordUsageEventResult> {
  const requestId = input.requestId || null;
  const rows = await db
    .insert(usageEvents)
    .values({
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
      requestId,
      metadata: input.metadata ?? {},
    })
    // Idempotent on request_id. NULL request_ids never conflict (Postgres treats
    // NULLs as distinct), so non-metered events always insert.
    .onConflictDoNothing({ target: usageEvents.requestId })
    .returning({ eventId: usageEvents.eventId });

  const inserted = rows[0];
  if (inserted) return { eventId: inserted.eventId, inserted: true };

  // Conflict: a row with this request_id already exists. Return its id (for audit
  // linkage) and inserted:false so the caller skips re-debiting.
  if (requestId) {
    const [existing] = await db
      .select({ eventId: usageEvents.eventId })
      .from(usageEvents)
      .where(eq(usageEvents.requestId, requestId))
      .limit(1);
    return { eventId: existing?.eventId ?? null, inserted: false };
  }
  return { eventId: null, inserted: false };
}
