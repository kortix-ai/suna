import { projectSessions, usageEvents } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { ttlMemo } from './ttl-memo';

export interface UsageEventInput {
  accountId: string;
  projectId?: string | null;
  sessionId?: string | null;
  /** KaaB per-end-user attribution — see the column comment on
   *  usage_events.origin_ref. MUST be a server-derived value; never accept it
   *  from a request. Callers whose session identity is client-supplied (the
   *  legacy router path) leave it unset, and those rows stay unattributed. */
  originRef?: string | null;
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
}

function positiveInteger(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export async function recordUsageEvent(input: UsageEventInput): Promise<string | null> {
  const [row] = await db
    .insert(usageEvents)
    .values({
      accountId: input.accountId,
      projectId: input.projectId || null,
      sessionId: input.sessionId || null,
      originRef: input.originRef || null,
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
    })
    .returning({ eventId: usageEvents.eventId });
  return row?.eventId ?? null;
}

/**
 * Resolve a session's `origin_ref` for usage attribution.
 *
 * ONLY safe to call with a SERVER-DERIVED session id — on the gateway path the
 * executor token is minted with `sessionId = sandboxId = project session id`, so
 * the caller cannot choose it. Do NOT call this with the legacy router's
 * session id, which comes from the request body / X-Session-ID header: an
 * end-user could then name a peer's session and bill their spend to that peer.
 *
 * Scoped by accountId as defence in depth, and memoized because origin_ref is
 * written once at session insert and never updated — so a per-session lookup is
 * immutable and safe to cache for the life of a session's traffic burst.
 */
export const resolveSessionOriginRef = ttlMemo({
  ttlMs: 10 * 60 * 1000,
  keyFn: (accountId: string, sessionId: string) => `${accountId}|${sessionId}`,
  loader: async (accountId: string, sessionId: string): Promise<string | null> => {
    const [row] = await db
      .select({ originRef: projectSessions.originRef })
      .from(projectSessions)
      .where(
        and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.accountId, accountId)),
      )
      .limit(1);
    return row?.originRef ?? null;
  },
});
