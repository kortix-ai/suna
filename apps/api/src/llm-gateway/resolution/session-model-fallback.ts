/**
 * A session whose model cannot serve moves to the fallback model that answered.
 *
 * THE PROBLEM. A prod session on a ChatGPT model kept failing over to the
 * project's fallback on every request while every ChatGPT account was at its
 * usage limit. The browser sends its chosen model with every prompt, so each
 * new prompt named the resting model again and paid the failover again.
 *
 * THE RULE. When a session's request is answered by a fallback because the
 * model it named is UNAVAILABLE (the gateway started the chain without it at
 * `resolve`, or a held route says it failed that way moments ago), the session
 * row records the fallback as its model, with source `fallback` and the model
 * it stood in for. The composer shows it and sends it from the next prompt on.
 * A one-off transient failure (`dispatch`: 429, 5xx, busy) does not switch.
 * When a turn ends, `projects/lib/session-model-fallback-revert.ts` moves the
 * session back once the original model can serve again.
 *
 * No push to the box: each prompt carries its model, so the next one runs on
 * the fallback without an OpenCode restart.
 */
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import type { GatewayTrace } from '@kortix/llm-gateway';
import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { SESSION_CHANGED_CHANNEL } from '../../shared/pg-broadcast';
import { toOpencodeModelRef } from './effective';

/** `project_sessions.metadata` keys this switch writes. */
export const FALLBACK_KEYS = {
  from: 'opencode_model_fallback_from',
  fromSource: 'opencode_model_fallback_from_source',
  reason: 'opencode_model_fallback_reason',
  at: 'opencode_model_fallback_at',
} as const;

/** Failure codes that mean the model cannot serve for a while (resting pool, sign-in, retired). */
const UNAVAILABLE_CODES = new Set([
  'provider_pool_rate_limited',
  'provider_reauth_required',
  'model_not_found',
  'model_retired',
  'model_disabled_on_deployment',
]);

export interface FallbackSwitch {
  sessionId: string;
  projectId: string;
  accountId: string;
  /** Opencode refs (`kortix/<wire>`). */
  from: string;
  to: string;
  reason: string;
}

/** PURE. The switch a trace asks for, or null. */
export function fallbackSwitchOf(
  trace: Pick<GatewayTrace, 'ok' | 'sessionId' | 'projectId' | 'accountId' | 'requestedModel' | 'servedModel' | 'fallbackFrom' | 'attemptFailures'>,
): FallbackSwitch | null {
  if (!trace.ok || !trace.sessionId || !trace.projectId || !trace.servedModel || !trace.fallbackFrom) return null;
  const first = trace.attemptFailures?.[0];
  if (!first || (first.stage !== 'resolve' && first.stage !== 'held')) return null;
  if (!UNAVAILABLE_CODES.has(String(first.code))) return null;
  const from = toOpencodeModelRef(trace.requestedModel);
  const to = toOpencodeModelRef(trace.servedModel);
  if (from === to) return null;
  return {
    sessionId: trace.sessionId,
    projectId: trace.projectId,
    accountId: trace.accountId,
    from,
    to,
    reason: String(first.code),
  };
}

// replica-local: a memo of switches this replica already wrote, so a held
// route's every request does not re-read the session. A miss costs one read
// and a no-op UPDATE; the TTL bounds a memo that another replica's revert made stale.
const written = new Map<string, { memo: string; untilMs: number }>();
const MAX_WRITTEN = 5_000;
const WRITTEN_TTL_MS = 5 * 60_000;

/** The model of the session's newest prompt, as an opencode ref, or null when it named none. */
async function latestPromptModelRef(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: sql<{ providerID?: unknown; modelID?: unknown } | null>`${sessionLifecycleCommands.payload}->'overrides'->'model'` })
    .from(sessionLifecycleCommands)
    .where(and(eq(sessionLifecycleCommands.sessionId, sessionId), eq(sessionLifecycleCommands.commandType, 'continue_session')))
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  const model = row?.model;
  return typeof model?.providerID === 'string' && typeof model.modelID === 'string'
    ? `${model.providerID}/${model.modelID}`
    : null;
}

/**
 * Records the switch on the session row. Idempotent, never throws. Only the
 * session's own model switches: a request for another model (a subagent's,
 * say) is not the one the composer sends.
 */
export async function switchSessionToFallback(change: FallbackSwitch, nowMs = Date.now()): Promise<boolean> {
  const memo = `${change.from}>${change.to}`;
  const seen = written.get(change.sessionId);
  if (seen?.memo === memo && seen.untilMs > nowMs) return false;
  try {
    const promptRef = await latestPromptModelRef(change.sessionId);
    if (promptRef !== null && promptRef !== change.from) return false;
    const metadata = projectSessions.metadata;
    const wasFallback = sql`${metadata}->>'opencode_model_source' = 'fallback'`;
    const updated = await db
      .update(projectSessions)
      .set({
        metadata: sql`coalesce(${metadata}, '{}'::jsonb) || jsonb_build_object(
          'opencode_model', ${change.to}::text,
          'opencode_model_source', 'fallback',
          ${FALLBACK_KEYS.from}::text, CASE WHEN ${wasFallback} THEN ${metadata}->${FALLBACK_KEYS.from}::text ELSE to_jsonb(${change.from}::text) END,
          ${FALLBACK_KEYS.fromSource}::text, CASE WHEN ${wasFallback} THEN ${metadata}->${FALLBACK_KEYS.fromSource}::text ELSE coalesce(${metadata}->'opencode_model_source', 'null'::jsonb) END,
          ${FALLBACK_KEYS.reason}::text, ${change.reason}::text,
          ${FALLBACK_KEYS.at}::text, ${nowMs}::bigint
        )`,
      })
      .where(
        and(
          eq(projectSessions.sessionId, change.sessionId),
          eq(projectSessions.projectId, change.projectId),
          // Already switched to this model: nothing to write.
          sql`(${metadata}->>'opencode_model' IS DISTINCT FROM ${change.to}::text OR ${metadata}->>'opencode_model_source' IS DISTINCT FROM 'fallback')`,
          // A prompt that named no model runs on the pin: switch only from it.
          promptRef === null ? sql`${metadata}->>'opencode_model' = ${change.from}::text` : undefined,
        ),
      )
      .returning({ notified: sql`pg_notify(${SESSION_CHANGED_CHANNEL}, ${projectSessions.sessionId}::text)` });
    written.delete(change.sessionId);
    if (written.size >= MAX_WRITTEN) written.delete(written.keys().next().value!);
    written.set(change.sessionId, { memo, untilMs: nowMs + WRITTEN_TTL_MS });
    if (updated.length === 0) return false;
    await recordAuditEvent({
      accountId: change.accountId,
      projectId: change.projectId,
      sessionId: change.sessionId,
      actorType: 'system',
      action: 'SESSION_MODEL_FALLBACK',
      resourceType: 'project_session',
      resourceId: change.sessionId,
      outcome: 'success',
      before: { opencode_model: change.from },
      after: { opencode_model: change.to },
      metadata: { reason: change.reason },
    }).catch((error: Error) =>
      logger.warn('[llm-gateway] session model fallback audit failed', { session_id: change.sessionId, error: error.message }),
    );
    return true;
  } catch (error) {
    logger.warn('[llm-gateway] session model fallback write failed', {
      session_id: change.sessionId,
      from: change.from,
      to: change.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Forget this replica's memo for a session: its model moved back. */
export function forgetFallbackSwitch(sessionId: string): void {
  written.delete(sessionId);
}
