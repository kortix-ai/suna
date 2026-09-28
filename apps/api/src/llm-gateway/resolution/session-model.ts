import type { ManagedModel } from '../models/managed-models';
import { retiredManagedModelReplacement } from '../models/managed-models';

export type SessionModelDecision =
  | { kind: 'kept' }
  | { kind: 'repoint'; to: string; reason: 'successor' | 'project_default' };

/**
 * PURE. What a session's pinned model should become at boot, mirroring
 * config-releases/session-agent.ts's resolveSessionReleaseAgent for the
 * MODEL layer: a lineup rotation must re-point a session, never leave it
 * dead on its next turn (the evidence: 4/9 real-project turn failures swept
 * 2026-09-28 were a session pinned to an id the runtime lineup dropped).
 *
 * `storedWireModel` is the session's stored model, reduced to its bare
 * gateway wire id (`effective.ts`'s `toWireModel`). `served` is the runtime-
 * servable managed lineup (`SERVED_MANAGED_MODELS`). `projectDefaultWireModel`
 * is the project's current declared default, also reduced to its wire id —
 * consulted ONLY when the id has no declared successor
 * (`managed-models.ts`'s `LEGACY_MANAGED_IDS`) that is itself servable here.
 *
 * Never fires for a BYOK/codex ref or a managed id still in the lineup —
 * both are `kept`. A retired id with nothing to move to is also `kept`: the
 * turn-time error (`resolve-candidates.ts`'s `model_retired`) names the real
 * cause instead of this function inventing a fuzzy match.
 */
export function resolveSessionManagedModel(
  storedWireModel: string,
  served: readonly ManagedModel[],
  projectDefaultWireModel: string | null,
): SessionModelDecision {
  const successor = retiredManagedModelReplacement(storedWireModel, served);
  if (successor) return { kind: 'repoint', to: successor, reason: 'successor' };
  if (projectDefaultWireModel && projectDefaultWireModel !== storedWireModel) {
    return { kind: 'repoint', to: projectDefaultWireModel, reason: 'project_default' };
  }
  return { kind: 'kept' };
}
