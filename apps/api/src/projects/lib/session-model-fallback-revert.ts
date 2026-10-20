/**
 * The other half of `llm-gateway/resolution/session-model-fallback.ts`: move a
 * session that a fallback took over back to the model it stood in for once
 * that model can serve again. Two callers: every closed turn end, and
 * `workers/session-model-fallback-worker.ts` for a session that sits idle.
 * A pool that is cooling down cannot serve, so the session stays on the
 * fallback. Neither can a route the gateway still holds: it answers the
 * original model with the fallback until the hold ends
 * (pipeline/route-memory.ts), so moving back sooner shows a model that does
 * not answer (measured: a reconnect cleared the cooldown, the next prompt
 * named Sol and DeepSeek answered it). The hold is up to MAX_HOLD_SECONDS
 * for a resting pool and SETUP_HOLD_SECONDS for every other reason, counted
 * from the latest `resolve` failure (the switch refreshes `at`).
 *
 * The restored source is the one the pin had, except a source the composer
 * ranks below the last prompt (`project`, `account`, `platform`): that one
 * restores as `explicit`, or the composer would show the fallback the last
 * prompts ran on. No pin follows a later default change (session-create.ts
 * resolves it once), so this changes the ranking only.
 */
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { MAX_HOLD_SECONDS, SETUP_HOLD_SECONDS } from '@kortix/llm-gateway';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { logger } from '../../lib/logger';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { FALLBACK_KEYS } from '../../llm-gateway/resolution/session-model-fallback';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { SESSION_CHANGED_CHANNEL } from '../../shared/pg-broadcast';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { activeTurnAuthorityPredicate } from '../reaping/box-queries';
import { resolveSessionPersonalOwner } from './personal-resources';

/** Sources the composer ranks above the last prompt's model; any other restores as `explicit`. */
const RESTORABLE_SOURCES = new Set(['explicit', 'repointed']);

/** How long the gateway holds the route after a `resolve` failure with this code (simple-handler.ts). */
export function holdSecondsFor(reason: unknown): number {
  return reason === 'provider_pool_rate_limited' ? MAX_HOLD_SECONDS : SETUP_HOLD_SECONDS;
}

/** Never throws. Returns the restored model ref, or null when the session stays. */
export async function revertSessionModelFallback(sessionId: string, nowMs = Date.now()): Promise<string | null> {
  try {
    const [row] = await db
      .select({
        projectId: projectSessions.projectId,
        accountId: projectSessions.accountId,
        createdBy: projectSessions.createdBy,
        metadata: projectSessions.metadata,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
    if (!row || metadata.opencode_model_source !== 'fallback') return null;
    const from = metadata[FALLBACK_KEYS.from];
    const at = metadata[FALLBACK_KEYS.at];
    if (typeof from !== 'string' || !from) return null;
    if (typeof at === 'number' && nowMs - at < holdSecondsFor(metadata[FALLBACK_KEYS.reason]) * 1000) return null;

    const personalUserId = await resolveSessionPersonalOwner({
      projectId: row.projectId,
      accountId: row.accountId,
      sessionId,
      legacyUserId: row.createdBy,
    }).catch(() => null);
    const servable = await isModelServableForAccount({
      userId: row.createdBy ?? personalUserId ?? '',
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId,
      freeModelsOnly: !(await accountMayUseManagedModels(row.accountId)),
      model: from,
      personalUserId,
      restingIsServable: false,
    });
    if (!servable) return null;

    const previous = metadata[FALLBACK_KEYS.fromSource];
    const source = typeof previous === 'string' && RESTORABLE_SOURCES.has(previous) ? previous : 'explicit';
    const updated = await db
      .update(projectSessions)
      .set({
        metadata: sql`(${projectSessions.metadata} - ${FALLBACK_KEYS.from}::text - ${FALLBACK_KEYS.fromSource}::text - ${FALLBACK_KEYS.reason}::text - ${FALLBACK_KEYS.at}::text)
          || jsonb_build_object('opencode_model', ${from}::text, 'opencode_model_source', ${source}::text)`,
      })
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          // Compare-and-set: a newer switch, or a person's pick, wins.
          sql`${projectSessions.metadata}->>'opencode_model_source' = 'fallback'`,
          sql`${projectSessions.metadata}->${FALLBACK_KEYS.at}::text IS NOT DISTINCT FROM ${JSON.stringify(at ?? null)}::jsonb`,
        ),
      )
      .returning({ notified: sql`pg_notify(${SESSION_CHANGED_CHANNEL}, ${projectSessions.sessionId}::text)` });
    if (updated.length === 0) return null;
    await recordAuditEvent({
      accountId: row.accountId,
      projectId: row.projectId,
      sessionId,
      actorType: 'system',
      action: 'SESSION_MODEL_FALLBACK_REVERTED',
      resourceType: 'project_session',
      resourceId: sessionId,
      outcome: 'success',
      before: { opencode_model: metadata.opencode_model },
      after: { opencode_model: from },
      metadata: { reason: metadata[FALLBACK_KEYS.reason] ?? null },
    }).catch((error: Error) =>
      logger.warn('[projects] session model fallback revert audit failed', { session_id: sessionId, error: error.message }),
    );
    return from;
  } catch (error) {
    logger.warn('[projects] session model fallback revert failed', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const SWEEP_LIMIT = 200;

/**
 * Worker tick: try the revert on every live, idle session a fallback took
 * over, so one that sits idle moves back without another turn. Scoped to live
 * sessions (the status index; ~100 rows in prod, 10 ms): a stopped session
 * becomes live again on open and the next tick takes it. A session mid-turn
 * waits for its turn end, which runs the revert itself.
 */
export async function revertIdleSessionFallbacks(nowMs = Date.now()): Promise<number> {
  const rows = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        inArray(projectSessions.status, ['queued', 'branching', 'provisioning', 'running']),
        sql`${projectSessions.metadata}->>'opencode_model_source' = 'fallback'`,
        sql`NOT EXISTS (SELECT 1 FROM ${sessionSandboxes}
          WHERE ${qualifiedColumn(sessionSandboxes.sessionId)} = ${qualifiedColumn(projectSessions.sessionId)} AND ${activeTurnAuthorityPredicate()})`,
      ),
    )
    .limit(SWEEP_LIMIT);
  let reverted = 0;
  for (const { sessionId } of rows) {
    if (await revertSessionModelFallback(sessionId, nowMs)) reverted += 1;
  }
  return reverted;
}
