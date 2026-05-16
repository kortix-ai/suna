import { usageEvents } from '@kortix/db';
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
  metadata?: Record<string, unknown>;
}

function positiveInteger(value: number | undefined) {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export async function recordUsageEvent(input: UsageEventInput) {
  await db.insert(usageEvents).values({
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
  });
}
