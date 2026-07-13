import type { SandboxProviderName } from '../config';
import type { ProviderState, SandboxProviderAdapter } from './providers';

export const SANDBOX_TEMPLATE_PROVIDERS = ['daytona', 'platinum', 'e2b'] as const;

export type SandboxTemplateProvider = (typeof SANDBOX_TEMPLATE_PROVIDERS)[number];
export type SandboxTemplateProviderCoverageStatus =
  | 'ready'
  | 'building'
  | 'failed'
  | 'not_built'
  | 'unavailable'
  | 'unknown';

export interface SandboxTemplateProviderCoverage {
  provider: SandboxTemplateProvider;
  available: boolean;
  snapshot_name: string;
  state: ProviderState | null;
  status: SandboxTemplateProviderCoverageStatus;
  launch_ready: boolean;
  observed_at: string | null;
}

export interface ProviderCoverageDependencies {
  isProviderEnabled: (provider: SandboxTemplateProvider) => boolean;
  getProvider: (provider: SandboxTemplateProvider) => Pick<SandboxProviderAdapter, 'getSnapshotState'>;
  now: () => Date;
}

/**
 * A reusable sandbox template is provider-neutral infrastructure. Keep its
 * content identity synchronized on every enabled provider, regardless of where
 * an individual project is pinned. Provider pins apply only to session routing
 * and project-specific warm images.
 */
export function enabledTemplateBuildProviders(opts: {
  allowed: readonly string[];
  isEnabled: (provider: string) => boolean;
}): SandboxTemplateProvider[] {
  return SANDBOX_TEMPLATE_PROVIDERS.filter(
    (provider) => opts.allowed.includes(provider) && opts.isEnabled(provider),
  );
}

function coverageStatus(state: ProviderState): SandboxTemplateProviderCoverageStatus {
  switch (state) {
    case 'active':
      return 'ready';
    case 'building':
      return 'building';
    case 'build_failed':
      return 'failed';
    case 'missing':
    case 'removing':
      return 'not_built';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Observe the expected current content-addressed image independently on every
 * supported provider. Probe errors remain `unknown`; they must never be
 * presented as proof that an image is absent or launch-ready.
 */
export async function observeTemplateProviderCoverage(
  snapshotName: string,
  dependencies: ProviderCoverageDependencies,
): Promise<SandboxTemplateProviderCoverage[]> {
  return Promise.all(
    SANDBOX_TEMPLATE_PROVIDERS.map(async (provider) => {
      if (!dependencies.isProviderEnabled(provider)) {
        return {
          provider,
          available: false,
          snapshot_name: snapshotName,
          state: null,
          status: 'unavailable' as const,
          launch_ready: false,
          observed_at: null,
        };
      }

      try {
        const state = await dependencies.getProvider(provider).getSnapshotState(snapshotName);
        return {
          provider,
          available: true,
          snapshot_name: snapshotName,
          state,
          status: coverageStatus(state),
          launch_ready: state === 'active',
          observed_at: dependencies.now().toISOString(),
        };
      } catch {
        return {
          provider,
          available: true,
          snapshot_name: snapshotName,
          state: null,
          status: 'unknown' as const,
          launch_ready: false,
          observed_at: dependencies.now().toISOString(),
        };
      }
    }),
  );
}

type RoutedCoverage = Pick<SandboxTemplateProviderCoverage, 'provider' | 'available' | 'state'>;

/**
 * Collapse per-provider truth into the legacy single-state field without lying:
 * a pinned project follows its selected provider; Automatic is `active` only
 * when every enabled provider it may route to is launch-ready.
 */
export function resolveRoutedTemplateState(
  coverage: readonly RoutedCoverage[],
  selectedProvider: SandboxTemplateProvider | null,
): ProviderState {
  if (selectedProvider) {
    return coverage.find((item) => item.provider === selectedProvider && item.available)?.state
      ?? 'missing';
  }

  const states = coverage.filter((item) => item.available).map((item) => item.state);
  if (states.length === 0) return 'missing';
  if (states.every((state) => state === 'active')) return 'active';
  if (states.some((state) => state === 'building')) return 'building';
  if (states.some((state) => state === 'removing')) return 'removing';
  if (states.some((state) => state === 'build_failed')) return 'build_failed';
  if (states.some((state) => state === 'unknown' || state === null)) return 'unknown';
  return 'missing';
}

/** Resolve the same usable explicit pin as session creation. null is Automatic. */
export function resolveUsableProjectProviderPin(
  metadata: Record<string, unknown> | null | undefined,
  isProviderEnabled: (provider: SandboxProviderName) => boolean,
): SandboxTemplateProvider | null {
  const raw = metadata?.default_sandbox_provider;
  if (
    typeof raw !== 'string' ||
    !SANDBOX_TEMPLATE_PROVIDERS.includes(raw as SandboxTemplateProvider)
  ) {
    return null;
  }
  const provider = raw as SandboxTemplateProvider;
  return isProviderEnabled(provider) ? provider : null;
}
