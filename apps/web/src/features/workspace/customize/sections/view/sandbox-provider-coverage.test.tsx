import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ProviderCoverageEntry,
  SandboxTemplateProviderCoverage,
  SandboxTemplateProviderModeBadge,
  describeProviderCoverage,
  describeProviderMode,
  sandboxProviderLabel,
} from './sandbox-provider-coverage';

const coverageEntry = (
  overrides: Partial<ProviderCoverageEntry> & Pick<ProviderCoverageEntry, 'provider'>,
): ProviderCoverageEntry => {
  const { provider, ...rest } = overrides;

  return {
    provider,
    available: true,
    snapshot_name: `${provider}-snapshot`,
    state: 'active',
    status: 'ready',
    launch_ready: true,
    observed_at: '2026-07-14T10:00:00.000Z',
    ...rest,
  };
};

function renderProviderPresentation({
  providerMode,
  coverage,
  selectedProvider,
}: {
  providerMode: 'automatic' | 'pinned';
  coverage: ProviderCoverageEntry[];
  selectedProvider: ProviderCoverageEntry['provider'] | null;
}) {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(SandboxTemplateProviderCoverage, {
        providerMode,
        coverage,
        selectedProvider,
        formatObservedAt: () => 'now',
      }),
      createElement(SandboxTemplateProviderModeBadge, {
        providerMode,
        coverage,
        selectedProvider,
      }),
    ),
  );
}

describe('sandbox template provider coverage presentation', () => {
  test('uses explicit launch-readiness language for every provider state', () => {
    expect(describeProviderCoverage('ready')).toEqual({ label: 'Latest', tone: 'ok' });
    expect(describeProviderCoverage('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeProviderCoverage('failed')).toEqual({ label: 'Failed', tone: 'fail' });
    expect(describeProviderCoverage('not_built')).toEqual({
      label: 'Current image not built',
      tone: 'idle',
    });
    expect(describeProviderCoverage('unavailable')).toEqual({ label: 'Unavailable', tone: 'idle' });
    expect(describeProviderCoverage('unknown')).toEqual({ label: 'Unknown', tone: 'idle' });
  });

  test('keeps Automatic and Pinned badges neutral while preserving selected metadata', () => {
    expect(describeProviderMode('automatic', 'daytona')).toEqual({
      label: 'Automatic',
      selectedProvider: null,
    });
    expect(describeProviderMode('pinned', 'e2b')).toEqual({
      label: 'Pinned provider',
      selectedProvider: 'E2B',
    });
    expect(sandboxProviderLabel('e2b')).toBe('E2B');
  });

  test('renders automatic mode as neutral without provider names or matrix', () => {
    const html = renderProviderPresentation({
      providerMode: 'automatic',
      selectedProvider: 'daytona',
      coverage: [
        coverageEntry({ provider: 'daytona', status: 'ready' }),
        coverageEntry({ provider: 'platinum', status: 'building' }),
        coverageEntry({ provider: 'e2b', available: false, status: 'unavailable' }),
      ],
    });

    expect(html).toContain('Automatic');
    expect(html).not.toContain('Provider images');
    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('E2B');
    expect(html).not.toContain('Latest');
    expect(html).not.toContain('Building');
  });

  test('renders pinned matrix with only available providers and their states', () => {
    const html = renderProviderPresentation({
      providerMode: 'pinned',
      selectedProvider: 'daytona',
      coverage: [
        coverageEntry({ provider: 'daytona', available: true, status: 'ready' }),
        coverageEntry({ provider: 'platinum', available: false, status: 'ready' }),
        coverageEntry({
          provider: 'e2b',
          available: true,
          status: 'building',
          state: 'building',
          launch_ready: false,
        }),
      ],
    });

    expect(html).toContain('Provider images');
    expect(html).toContain('Daytona');
    expect(html).toContain('Latest');
    expect(html).toContain('E2B');
    expect(html).toContain('Building');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('Pinned provider');
  });

  test('renders pinned with no available providers as a neutral generic badge', () => {
    const html = renderProviderPresentation({
      providerMode: 'pinned',
      selectedProvider: 'e2b',
      coverage: [
        coverageEntry({ provider: 'daytona', available: false, status: 'unavailable' }),
        coverageEntry({ provider: 'platinum', available: false, status: 'unavailable' }),
        coverageEntry({ provider: 'e2b', available: false, status: 'unavailable' }),
      ],
    });

    expect(html).toContain('Pinned provider');
    expect(html).toContain('bg-muted/50');
    expect(html).not.toContain('Provider images');
    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('E2B');
    expect(html).not.toContain('Unavailable');
  });
});
