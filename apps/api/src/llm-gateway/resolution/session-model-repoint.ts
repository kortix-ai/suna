/**
 * A session's stored model, re-pointed at boot when the runtime lineup
 * retired it — the model-layer twin of config-releases/repoint.ts's agent
 * re-point.
 *
 * THE PROBLEM (measured, 2026-09-28 sweep of 9 real sessions in one project):
 * 4/5 turn failures were a session pinned to a managed model id the runtime
 * lineup no longer serves — `project_sessions.metadata.opencode_model` is
 * write-once at create and PUT /model, so a lineup rotation leaves it dead
 * forever. `resolveCandidates` (resolve-candidates.ts) already tells a live
 * turn apart with the distinct `model_retired` code; this module is what
 * stops the session from ever reaching that dead end in the first place.
 *
 * THE DECISION. Re-point, at the SAME boot chokepoint config-releases uses
 * ("once per boot/converge"): `buildSessionSandboxEnvVars` is the one
 * function every provisioning path (create, restart, resume, open/ensure)
 * already funnels through to build `KORTIX_OPENCODE_MODEL` — so this is
 * called from there, not from each of its three call sites separately, and
 * not again at turn start (a session that changes model mid-run restarts
 * opencode anyway; re-pointing there too would duplicate this exact write).
 * Idempotent: once the stored id is servable again, `isRetiredManagedModelId`
 * is false and this is a no-op.
 *
 * VISIBLE, NOT SILENT: the write records `opencode_model_source: 'repointed'`
 * and `opencode_model_repointed_from` in the session's own metadata (already
 * returned by the session read/open-bundle routes), plus an audit event —
 * mirroring repoint.ts's `SESSION_AGENT_REPOINTED`.
 */
import { projectSessions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { recordAuditEvent } from '../../services/audit/audit';
import { db } from '../../lib/db';
import { logger } from '../../lib/logger';
import { isRetiredManagedModelId } from '../models/managed-models';
import { SERVED_MANAGED_MODELS, platformDefaultModelId } from '../models/served-managed-models';
import { resolveEffectiveModel } from './default-model';
import { toOpencodeModelRef, toWireModel } from './effective';
import { resolveSessionManagedModel } from './session-model';

export interface RepointModelSubject {
  projectId: string;
  accountId: string;
  sessionId: string;
  /** Resolves the project's default-model chain as this principal. */
  userId: string;
  agentName: string;
  freeModelsOnly: boolean;
  /** The session's CURRENT metadata, for a merge-safe write. */
  metadata: Record<string, unknown> | null;
}

/**
 * Returns the opencode model ref to boot with: `opencodeModelRef` unchanged,
 * or a durably re-pointed replacement. Never throws — a resolution hiccup
 * just keeps the session on its current (possibly still-dead) pin, and the
 * turn's own `model_retired` error remains the fallback explanation.
 */
export async function repointRetiredSessionModel(
  opencodeModelRef: string,
  subject: RepointModelSubject,
): Promise<string> {
  // The RAW bare id, not `toWireModel`'s canonicalized wire form: `toWireModel`
  // already applies `canonicalManagedModelId` internally, which would resolve
  // a retired-with-successor id (e.g. deepseek-v4-flash-0731) straight past
  // this check before it ever sees the id was retired at all — that's a
  // FEATURE for the live gateway path (a request naming it transparently
  // succeeds on the successor, see resolve-candidates.ts), but it must not
  // blind this function to the fact that the STORED pin still needs its own
  // durable, visible re-point.
  const wire = opencodeModelRef.startsWith('kortix/') ? opencodeModelRef.slice('kortix/'.length) : opencodeModelRef;
  if (!isRetiredManagedModelId(wire)) return opencodeModelRef; // the overwhelming common case, no IO at all

  let decision = resolveSessionManagedModel(wire, SERVED_MANAGED_MODELS, null);
  if (decision.kind === 'kept') {
    // No servable declared successor — the project's current default is the
    // only remaining fallback (same chain PUT /model and session create use).
    const resolved = await resolveEffectiveModel({
      userId: subject.userId,
      accountId: subject.accountId,
      projectId: subject.projectId,
      agentName: subject.agentName,
      explicit: null,
      freeModelsOnly: subject.freeModelsOnly,
    }).catch(() => ({ model: null, source: 'platform' as const }));
    // …and the PLATFORM default under that. A project that never set a default
    // (the common case — `projects.metadata.default_model` is null for most)
    // otherwise left this chain with nothing to return, so a retired id with no
    // declared successor stayed pinned and every turn on it died. Measured on
    // one real dev project, 2026-09-28: 20 of 238 sessions were pinned to a
    // retired id with NO successor and no project default, i.e. permanently
    // unable to complete a turn until a human changed the model by hand.
    const projectDefault = resolved.model ? toWireModel(resolved.model) : null;
    decision = resolveSessionManagedModel(
      wire,
      SERVED_MANAGED_MODELS,
      projectDefault,
      platformDefaultModelId(),
    );
  }
  if (decision.kind === 'kept') return opencodeModelRef; // nothing usable to move to; the turn error names the cause

  const nextRef = toOpencodeModelRef(decision.to);
  let updated: { sessionId: string }[];
  try {
    updated = await db
      .update(projectSessions)
      .set({
        metadata: {
          ...(subject.metadata ?? {}),
          opencode_model: nextRef,
          opencode_model_source: 'repointed',
          opencode_model_repointed_from: wire,
        },
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, subject.sessionId))
      .returning({ sessionId: projectSessions.sessionId });
  } catch (error) {
    logger.warn('[llm-gateway] session model re-point write failed', {
      session_id: subject.sessionId,
      from: wire,
      to: decision.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return opencodeModelRef;
  }
  if (updated.length === 0) return opencodeModelRef;

  await recordAuditEvent({
    accountId: subject.accountId,
    projectId: subject.projectId,
    sessionId: subject.sessionId,
    actorType: 'system',
    action: 'SESSION_MODEL_REPOINTED',
    resourceType: 'project_session',
    resourceId: subject.sessionId,
    outcome: 'success',
    before: { opencode_model: wire },
    after: { opencode_model: decision.to },
    metadata: { reason: decision.reason, retired_model: wire, repointed_to: decision.to },
  }).catch((error: Error) =>
    logger.warn('[llm-gateway] session model re-point audit failed', {
      session_id: subject.sessionId,
      error: error.message,
    }),
  );

  return nextRef;
}
