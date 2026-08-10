import type {
  WorkspaceSandboxHealth,
  WorkspaceSnapshotBuild,
  SandboxRuntimeStatus,
  SandboxStaleFailureReason,
} from '@kortix/sdk';

/**
 * Every sandbox alert in the product reads the server-derived `status` and
 * nothing else.
 *
 * The build log cannot answer "is my sandbox broken?" — a row records one past
 * ATTEMPT against one content identity. Reading `builds[0].status === 'failed'`
 * as the present tense is what put an 11-day-old error on screen ("the most
 * recent build is failing") while the image it named was live on Platinum and
 * sessions had been starting all along. The API observes the providers for the
 * CURRENT image and tells us whether a failure still applies; the UI's only job
 * is to render that answer honestly.
 */
export type SandboxAlertSeverity = 'critical' | 'warning' | 'building';

/** How a failed build relates to the image the workspace boots today. */
export type FailedBuildRelevance =
  /** Still the reason sessions can't start. */
  | 'blocking'
  /** Everything else is the API's own verdict: superseded / recovered / retrying. */
  | SandboxStaleFailureReason;

type StatusCarrier = { status?: SandboxRuntimeStatus | null } | null | undefined;

export function selectSandboxStatus(source: StatusCarrier): SandboxRuntimeStatus | null {
  return source?.status ?? null;
}

/** The failure worth showing a user — never merely the newest failed row. */
export function selectCurrentSandboxFailure(source: StatusCarrier): WorkspaceSnapshotBuild | null {
  return selectSandboxStatus(source)?.current_failure ?? null;
}

export function resolveSandboxAlertSeverity(
  health: WorkspaceSandboxHealth | null | undefined,
): SandboxAlertSeverity | null {
  switch (selectSandboxStatus(health)?.state) {
    case 'blocked':
      return 'critical';
    // Usable on some providers, failing on others: routing decides, so a share
    // of new sessions really will fail. Worth saying — quietly, not in red.
    case 'degraded':
      return 'warning';
    case 'building':
      return 'building';
    default:
      return null;
  }
}

/** Poll fast while something is in motion or broken; idle otherwise. */
export function sandboxHealthIsActive(health: WorkspaceSandboxHealth | null | undefined): boolean {
  const state = selectSandboxStatus(health)?.state;
  return state === 'building' || state === 'blocked' || state === 'degraded';
}

const PROVIDER_LABEL: Record<string, string> = {
  daytona: 'Daytona',
  platinum: 'Platinum',
  e2b: 'E2B',
};

export function formatSandboxProvider(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** `Daytona`, `Daytona and Platinum`, `Daytona, Platinum and E2B`. */
export function formatSandboxProviders(providers: readonly string[]): string {
  const names = providers.map(formatSandboxProvider);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function describeFailedBuild(
  build: Pick<WorkspaceSnapshotBuild, 'build_id' | 'snapshot_name' | 'status'>,
  status: SandboxRuntimeStatus | null | undefined,
): FailedBuildRelevance | null {
  if (build.status !== 'failed' || !status) return null;
  if (status.current_failure?.build_id === build.build_id) return 'blocking';
  // For the newest failed attempt the API has already said WHY it no longer
  // applies — echo that rather than guessing a second, possibly different answer.
  if (status.stale_failure?.build_id === build.build_id && status.stale_reason) {
    return status.stale_reason;
  }
  if (status.snapshot_name && build.snapshot_name !== status.snapshot_name) return 'superseded';
  return 'recovered';
}
