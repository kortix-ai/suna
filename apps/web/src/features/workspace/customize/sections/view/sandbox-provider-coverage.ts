import type { SandboxTemplate } from '@kortix/sdk/projects-client';

export type ProviderCoverageStatus = NonNullable<
  SandboxTemplate['provider_coverage']
>[number]['status'];

export function describeProviderCoverage(
  status: ProviderCoverageStatus,
): { label: string; tone: 'ok' | 'busy' | 'fail' | 'idle' } {
  switch (status) {
    case 'ready':
      return { label: 'Ready', tone: 'ok' };
    case 'building':
      return { label: 'Building', tone: 'busy' };
    case 'failed':
      return { label: 'Failed', tone: 'fail' };
    case 'not_built':
      return { label: 'Not built', tone: 'idle' };
    case 'unavailable':
      return { label: 'Unavailable', tone: 'idle' };
    case 'unknown':
      return { label: 'Unknown', tone: 'idle' };
  }
}
