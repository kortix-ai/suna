import type { ProjectSandboxHealth, ProjectSnapshotBuild } from '@kortix/sdk/projects-client';

export type SandboxAlertSeverity = 'critical' | 'building';

function isProjectAcceleratorBuild(build: ProjectSnapshotBuild | null | undefined): boolean {
  return build?.snapshot_name.startsWith('kortix-ppwarm-') ?? false;
}

export function selectCurrentSandboxFailure(
  health: ProjectSandboxHealth | null | undefined,
): ProjectSnapshotBuild | null {
  const failure = health?.latest_failure ?? null;
  if (!failure) return null;
  if (isProjectAcceleratorBuild(failure)) return null;

  const latest = health?.latest_build ?? null;
  if (latest && latest.build_id !== failure.build_id) return null;

  return failure;
}

export function resolveSandboxAlertSeverity(
  health: ProjectSandboxHealth | null | undefined,
): SandboxAlertSeverity | null {
  if (!health) return null;
  if (selectCurrentSandboxFailure(health) && !health.ready) return 'critical';
  if (health.building && !health.ready && !isProjectAcceleratorBuild(health.latest_build)) {
    return 'building';
  }
  return null;
}

export function currentFailedBuild<T extends { status: ProjectSnapshotBuild['status'] }>(
  builds: readonly T[],
): T | null {
  const latest =
    builds.find(
      (build) =>
        !(
          'snapshot_name' in build &&
          typeof build.snapshot_name === 'string' &&
          build.snapshot_name.startsWith('kortix-ppwarm-')
        ),
    ) ?? null;
  return latest?.status === 'failed' ? latest : null;
}
