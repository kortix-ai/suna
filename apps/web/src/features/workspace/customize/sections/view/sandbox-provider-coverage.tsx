import type { SandboxTemplate } from '@kortix/sdk/projects-client';

import { Badge } from '@/components/ui/badge';

export type ProviderCoverageEntry = NonNullable<SandboxTemplate['provider_coverage']>[number];
export type ProviderCoverageStatus = ProviderCoverageEntry['status'];
export type SandboxProvider = ProviderCoverageEntry['provider'];

export type SandboxProviderMode = 'automatic' | 'pinned';

export function sandboxProviderLabel(provider: SandboxProvider): 'Daytona' | 'Platinum' | 'E2B' {
  switch (provider) {
    case 'daytona':
      return 'Daytona';
    case 'platinum':
      return 'Platinum';
    case 'e2b':
      return 'E2B';
  }
}

export function describeProviderMode(
  mode: SandboxProviderMode,
  selectedProvider: SandboxProvider | null,
): { label: string; selectedProvider: string | null } {
  if (mode === 'automatic') return { label: 'Automatic', selectedProvider: null };
  const selected = selectedProvider ? sandboxProviderLabel(selectedProvider) : null;
  return {
    label: 'Pinned provider',
    selectedProvider: selected,
  };
}

export function describeProviderCoverage(status: ProviderCoverageStatus): {
  label: string;
  tone: 'ok' | 'busy' | 'fail' | 'idle';
} {
  switch (status) {
    case 'ready':
      return { label: 'Latest', tone: 'ok' };
    case 'building':
      return { label: 'Building', tone: 'busy' };
    case 'failed':
      return { label: 'Failed', tone: 'fail' };
    case 'not_built':
      return { label: 'Current image not built', tone: 'idle' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'idle' };
    case 'unknown':
      return { label: 'Unknown', tone: 'idle' };
  }
}

export function availableProviderCoverage(
  coverage: SandboxTemplate['provider_coverage'] | null | undefined,
): ProviderCoverageEntry[] {
  return (coverage ?? []).filter((item) => item.available);
}

function providerCoverageVariant(
  tone: ReturnType<typeof describeProviderCoverage>['tone'],
): 'success' | 'warning' | 'destructive' | 'muted' {
  if (tone === 'ok') return 'success';
  if (tone === 'busy') return 'warning';
  if (tone === 'fail') return 'destructive';
  return 'muted';
}

export function SandboxTemplateProviderCoverage({
  providerMode,
  coverage,
  selectedProvider,
  formatObservedAt,
}: {
  providerMode: SandboxProviderMode;
  coverage: SandboxTemplate['provider_coverage'] | null | undefined;
  selectedProvider: SandboxProvider | null;
  formatObservedAt?: (observedAt: string) => string;
}) {
  if (providerMode !== 'pinned') return null;

  const availableCoverage = availableProviderCoverage(coverage);
  if (availableCoverage.length === 0) return null;

  const observedAt = availableCoverage
    .map((item) => item.observed_at)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">Provider images</span>
      {availableCoverage.map((item) => {
        const state = describeProviderCoverage(item.status);
        const provider = sandboxProviderLabel(item.provider);
        const selected = item.provider === selectedProvider;

        return (
          <Badge
            key={item.provider}
            variant={providerCoverageVariant(state.tone)}
            size="xs"
            aria-label={`${provider}${selected ? ' selected' : ''}: ${state.label}`}
          >
            {provider}
            {selected ? (
              <>
                <span className="opacity-50" aria-hidden="true">
                  &bull;
                </span>
                Selected
              </>
            ) : null}
            <span className="opacity-50" aria-hidden="true">
              &bull;
            </span>
            {state.label}
          </Badge>
        );
      })}
      {observedAt ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          Checked {formatObservedAt ? formatObservedAt(observedAt) : observedAt}
        </span>
      ) : null}
    </div>
  );
}

export function SandboxTemplateProviderModeBadge({
  providerMode,
  coverage,
  selectedProvider,
}: {
  providerMode: SandboxProviderMode;
  coverage: SandboxTemplate['provider_coverage'] | null | undefined;
  selectedProvider: SandboxProvider | null;
}) {
  if (providerMode === 'automatic' || availableProviderCoverage(coverage).length === 0) {
    const providerModeInfo = describeProviderMode(providerMode, selectedProvider);

    return (
      <Badge variant="muted" size="sm">
        {providerModeInfo.label}
      </Badge>
    );
  }

  return null;
}
