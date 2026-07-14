import type { SandboxTemplate } from '@kortix/sdk/projects-client';

export type ProviderCoverageStatus = NonNullable<
  SandboxTemplate['provider_coverage']
>[number]['status'];

export type SandboxProviderMode = 'automatic' | 'pinned';

export function sandboxProviderLabel(
  provider: 'daytona' | 'platinum' | 'e2b',
): 'Daytona' | 'Platinum' | 'E2B' {
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
  selectedProvider: 'daytona' | 'platinum' | 'e2b' | null,
): { label: string; selectedProvider: string | null } {
  if (mode === 'automatic') return { label: 'Automatic', selectedProvider: null };
  const selected = selectedProvider ? sandboxProviderLabel(selectedProvider) : null;
  return {
    label: selected ? `${selected} selected` : 'Pinned provider',
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
