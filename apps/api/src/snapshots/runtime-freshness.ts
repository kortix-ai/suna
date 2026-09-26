export type RuntimeSnapshotBuildSource =
  | 'session-start'
  | 'project-create'
  | 'project-repository-replacement'
  | 'cr-merge'
  | 'manual'
  | 'background'
  | 'startup';

/** A session start can use the previous active image while the next image builds. */
export function canServeLastKnownGoodRuntime(input: {
  source: RuntimeSnapshotBuildSource;
}): boolean {
  return input.source === 'session-start';
}
