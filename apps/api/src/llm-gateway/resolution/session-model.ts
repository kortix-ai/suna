export type SessionModelDecision =
  | { kind: 'kept' }
  | { kind: 'repoint'; to: string; reason: 'project_default' | 'platform_default' };

/**
 * PURE. What a session's pinned model should become at boot, mirroring
 * config-releases/session-agent.ts's resolveSessionReleaseAgent for the
 * MODEL layer: a lineup rotation must re-point a session, never leave it
 * dead on its next turn (the evidence: 4/9 real-project turn failures swept
 * 2026-09-28 were a session pinned to an id the runtime lineup dropped).
 *
 * `storedWireModel` is the session's stored model, reduced to its bare
 * gateway wire id (`effective.ts`'s `toWireModel`). `projectDefaultWireModel`
 * is the project's current declared default, also reduced to its wire id.
 * No successor is hardcoded: the platform default is the configured model when
 * Platinum serves it, else the first model Platinum lists.
 *
 * Never fires for a BYOK/codex ref or a managed id still in the lineup —
 * both are `kept`. A retired id with nothing to move to is also `kept`: the
 * turn-time error (`resolve-candidates.ts`'s `model_retired`) names the real
 * cause instead of this function inventing a fuzzy match.
 */
export function resolveSessionManagedModel(
  storedWireModel: string,
  projectDefaultWireModel: string | null,
  platformDefaultWireModel: string | null = null,
): SessionModelDecision {
  if (projectDefaultWireModel && projectDefaultWireModel !== storedWireModel) {
    return { kind: 'repoint', to: projectDefaultWireModel, reason: 'project_default' };
  }
  // The PLATFORM default is the floor, and it is reported as its own reason:
  // an audit row that says `project_default` for a value the project never set
  // sends the next reader to the wrong setting.
  if (platformDefaultWireModel && platformDefaultWireModel !== storedWireModel) {
    return { kind: 'repoint', to: platformDefaultWireModel, reason: 'platform_default' };
  }
  return { kind: 'kept' };
}
