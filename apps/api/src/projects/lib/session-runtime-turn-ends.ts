/** Replica-local runtime end frames, owned and expired by the control reconciler. */
// replica-local: streams observe end frames here; durable turn authority remains in the DB.
const runtimeTurnEnds = new Map<string, Map<string, number>>();

export function sessionRuntimeTurnEnds(sessionId: string): ReadonlyMap<string, number> {
  return runtimeTurnEnds.get(sessionId) ?? new Map();
}

export function registerSessionRuntimeTurnEnds(sessionId: string, ends: Map<string, number>): void {
  runtimeTurnEnds.set(sessionId, ends);
}

export function forgetSessionRuntimeTurnEnds(sessionId: string): void {
  runtimeTurnEnds.delete(sessionId);
}
