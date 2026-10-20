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
 * `resolve`: a resting pool, a login that needs reconnection, a retired
 * model), the session row records the fallback as its model, with source
 * `fallback` and the model it stood in for. The composer shows it and sends it
 * from the next prompt on. A one-off transient failure (`dispatch`: 429, 5xx,
 * busy) does not switch. Neither does a `held` route: it replays a failure
 * from up to 10 minutes ago (pipeline/route-memory.ts) and outlives a revert,
 * so switching on it moved a session back to the fallback seconds after the
 * original model served again (measured on a local session). The session's
 * first request for a resting model resolves fresh, because the hold is per
 * session, so a `resolve` failure always comes first.
 * `projects/lib/session-model-fallback-revert.ts` moves the session back once
 * the original model can serve again: at a turn end, and on an idle session
 * from `workers/session-model-fallback-worker.ts`.
 *
 * No push to the box: each prompt carries its model, so the next one runs on
 * the fallback without an OpenCode restart.
 */
import { projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { MAX_HOLD_SECONDS, SETUP_HOLD_SECONDS, type GatewayTrace } from '@kortix/llm-gateway';
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
  until: 'opencode_model_fallback_until',
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
  /** How long the gateway holds the route on the fallback (pipeline/route-memory.ts). The revert waits for it. */
  holdSeconds: number;
}

/** PURE. The switch a trace asks for, or null. */
export function fallbackSwitchOf(
  trace: Pick<GatewayTrace, 'ok' | 'sessionId' | 'projectId' | 'accountId' | 'requestedModel' | 'servedModel' | 'fallbackFrom' | 'attemptFailures'>,
): FallbackSwitch | null {
  if (!trace.ok || !trace.sessionId || !trace.projectId || !trace.servedModel || !trace.fallbackFrom) return null;
  const first = trace.attemptFailures?.[0];
  if (first?.stage !== 'resolve') return null;
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
    // A trace from a gateway that does not record the hold: its rule, at most.
    holdSeconds: first.holdSeconds ?? (first.code === 'provider_pool_rate_limited' ? MAX_HOLD_SECONDS : SETUP_HOLD_SECONDS),
  };
}

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
 *
 * A session already on this fallback gets a fresh `at` and a later `until`
 * only: each gateway task holds the route on its own first failure
 * (pipeline/route-memory.ts), so the revert waits for the latest hold. That write audits nothing. It runs
 * at most once per gateway task per session per hold, so no memo saves it.
 */
export async function switchSessionToFallback(change: FallbackSwitch, nowMs = Date.now()): Promise<boolean> {
  try {
    const promptRef = await latestPromptModelRef(change.sessionId);
    if (promptRef !== null && promptRef !== change.from) return false;
    const metadata = projectSessions.metadata;
    const wasFallback = sql`${metadata}->>'opencode_model_source' = 'fallback'`;
    // Never NULL: `NOT already` must hold for a row with no pin or no source.
    const already = sql`(${metadata}->>'opencode_model' IS NOT DISTINCT FROM ${change.to}::text AND ${metadata}->>'opencode_model_source' IS NOT DISTINCT FROM 'fallback')`;
    const session = and(eq(projectSessions.sessionId, change.sessionId), eq(projectSessions.projectId, change.projectId));
    const until = nowMs + change.holdSeconds * 1000;
    const notify = { notified: sql`pg_notify(${SESSION_CHANGED_CHANNEL}, ${projectSessions.sessionId}::text)` };

    const refreshed = await db
      .update(projectSessions)
      .set({
        metadata: sql`${metadata} || jsonb_build_object(
          ${FALLBACK_KEYS.reason}::text, ${change.reason}::text,
          ${FALLBACK_KEYS.at}::text, ${nowMs}::bigint,
          ${FALLBACK_KEYS.until}::text, GREATEST(coalesce((${metadata}->>${FALLBACK_KEYS.until}::text)::bigint, 0), ${until}::bigint)
        )`,
      })
      .where(and(session, already))
      .returning(notify);
    if (refreshed.length > 0) return false;

    const updated = await db
      .update(projectSessions)
      .set({
        metadata: sql`coalesce(${metadata}, '{}'::jsonb) || jsonb_build_object(
          'opencode_model', ${change.to}::text,
          'opencode_model_source', 'fallback',
          ${FALLBACK_KEYS.from}::text, CASE WHEN ${wasFallback} THEN ${metadata}->${FALLBACK_KEYS.from}::text ELSE to_jsonb(${change.from}::text) END,
          ${FALLBACK_KEYS.fromSource}::text, CASE
            WHEN ${wasFallback} THEN ${metadata}->${FALLBACK_KEYS.fromSource}::text
            WHEN ${metadata}->>'opencode_model' IS NOT DISTINCT FROM ${change.from}::text THEN coalesce(${metadata}->'opencode_model_source', 'null'::jsonb)
            -- The prompt named another model than the pin: a person picked it.
            ELSE to_jsonb('explicit'::text)
          END,
          ${FALLBACK_KEYS.reason}::text, ${change.reason}::text,
          ${FALLBACK_KEYS.at}::text, ${nowMs}::bigint,
          ${FALLBACK_KEYS.until}::text, ${until}::bigint
        )`,
      })
      .where(
        and(
          session,
          sql`NOT ${already}`,
          // A prompt that named no model runs on the pin: switch only from it.
          promptRef === null ? sql`${metadata}->>'opencode_model' = ${change.from}::text` : undefined,
        ),
      )
      .returning(notify);
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
