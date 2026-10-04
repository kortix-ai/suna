/**
 * Re-point a session's RETIRED model pin when the session is OPENED, and push
 * the replacement to a box that is already running.
 *
 * WHY THIS EXISTS, WHEN #7953 ALREADY RE-POINTS
 * ---------------------------------------------
 * #7953 put the re-point at `buildSessionSandboxEnvVars` — the one chokepoint
 * every PROVISIONING path shares. That is the right place for a cold boot and
 * the wrong place for everything else, because a session that is merely
 * RESUMED never rebuilds its env:
 *
 *   - Platinum suspends and resumes a VM, it does not reboot it, so the
 *     daemon's process env survives untouched;
 *   - `KORTIX_OPENCODE_MODEL` is read when the daemon builds OpenCode's config
 *     AT SPAWN (see `session-model-change.ts`), so the model a running box
 *     uses is the one baked at its ORIGINAL provision;
 *   - nothing re-pushed it, so the row and the box drift apart and stay apart.
 *
 * Measured on one real dev project, 2026-09-28. The session row said
 * `deepseek-v4-flash`; every message in the transcript mirror — including one
 * sent that morning — reported `grok-4.6`, the model baked in on 2026-08-21.
 * Three different models for one session: the row's pin, the box's env, and
 * OpenCode's own state. 108 of that project's 238 sessions (45%) were pinned
 * to a retired managed id, and a turn on a retired id cannot complete.
 *
 * THE SHAPE. This is the model layer of the rule the runtime layer already
 * follows: convergence is CONTINUOUS, never boot-time-only. Boot-time-only
 * logic never re-runs on a provider that resumes instead of rebooting.
 *
 * COST ON A HEALTHY SESSION: ZERO. The pin is already in the caller's hands,
 * and a pin that is not retired returns before any IO. The repair fires at
 * most once per session — once re-pointed, the pin is live and
 * `isRetiredManagedModelId` is false forever after.
 */
import { projectLlmGatewayEnabledById } from '../../llm-gateway/enablement';
import { isRetiredManagedModelId } from '../../llm-gateway/models/managed-models';
import { repointRetiredSessionModel } from '../../llm-gateway/resolution/session-model-repoint';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { logger } from '../../lib/logger';
import { pushSessionModelToSandbox } from '../sandboxes/sandbox-env-sync';

export interface SessionModelRepairInput {
  projectId: string;
  sessionId: string;
  accountId: string;
  userId: string;
  agentName: string | null;
  /** The session's current metadata — the pin is read from it, no extra read. */
  metadata: Record<string, unknown> | null;
}

export interface SessionModelRepairResult {
  /** The replacement pin, or null when nothing was re-pointed. */
  repointed: string | null;
  /** True only when a RUNNING box took the replacement. */
  pushed: boolean;
}

const NO_REPAIR: SessionModelRepairResult = { repointed: null, pushed: false };

/**
 * The bare gateway wire id behind a stored pin, or null when there is none.
 *
 * Deliberately NOT `toWireModel`: that applies `canonicalManagedModelId`, which
 * resolves a retired-with-successor id straight past the retirement check and
 * would blind this function to the pin that still needs re-pointing — the same
 * trap `session-model-repoint.ts` documents.
 */
export function storedPinWireId(metadata: Record<string, unknown> | null): string | null {
  const pin = metadata?.opencode_model;
  if (typeof pin !== 'string' || !pin) return null;
  return pin.startsWith('kortix/') ? pin.slice('kortix/'.length) : pin;
}

/** Is this stored pin one a session open must repair? Pure, no IO. */
export function pinNeedsRepair(metadata: Record<string, unknown> | null): boolean {
  const wire = storedPinWireId(metadata);
  return wire !== null && isRetiredManagedModelId(wire);
}

/**
 * NEVER THROWS. A session open is never refused because its model could not be
 * repaired — the turn's own `model_retired` error stays the fallback
 * explanation, exactly as it was before this ran.
 */
export async function repairRetiredSessionModelOnOpen(
  input: SessionModelRepairInput,
): Promise<SessionModelRepairResult> {
  // The fast path, and the one that runs for every healthy session: no IO.
  if (!pinNeedsRepair(input.metadata)) return NO_REPAIR;
  const pin = input.metadata?.opencode_model as string;
  try {
    // Native mode has no gateway and no managed catalog, so "retired managed
    // id" is not a concept there and the pin means something else entirely.
    if (!(await projectLlmGatewayEnabledById(input.projectId))) return NO_REPAIR;

    const next = await repointRetiredSessionModel(pin, {
      projectId: input.projectId,
      accountId: input.accountId,
      sessionId: input.sessionId,
      userId: input.userId,
      agentName: input.agentName ?? 'default',
      freeModelsOnly: !(await accountMayUseManagedModels(input.accountId)),
      metadata: input.metadata,
    });
    if (next === pin) return NO_REPAIR; // nothing servable to move to

    // The row is now right. A box that is already up still has the OLD model
    // baked into OpenCode's config, so push it — `refreshModels: true`
    // restarts OpenCode against the new env. `pushSessionModelToSandbox`
    // reports `applied: false` (never throws) for a box that is not active,
    // which is the ordinary, correct answer for a cold session: its next boot
    // reads the row.
    const push = await pushSessionModelToSandbox({
      projectId: input.projectId,
      sessionId: input.sessionId,
      model: next,
    });
    logger.info('[projects] repaired a retired session model on open', {
      session_id: input.sessionId,
      from: pin,
      to: next,
      pushed: push.applied,
      push_reason: push.reason,
    });
    return { repointed: next, pushed: push.applied };
  } catch (error) {
    logger.warn('[projects] retired session model repair failed', {
      session_id: input.sessionId,
      pin,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_REPAIR;
  }
}
