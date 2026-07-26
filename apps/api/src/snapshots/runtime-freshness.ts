export type RuntimeSnapshotBuildSource =
  | 'session-start'
  | 'project-create'
  | 'cr-merge'
  | 'manual'
  | 'background'
  | 'startup';

/**
 * A compatibility session can boot the previous active runtime while the new
 * content-addressed image builds. ACP sessions require the current daemon
 * because pending JSON-RPC request replay is part of the transport contract.
 */
export function canServeLastKnownGoodRuntime(input: {
  source: RuntimeSnapshotBuildSource;
  requireCurrentRuntime: boolean;
}): boolean {
  return input.source === 'session-start' && !input.requireCurrentRuntime;
}
