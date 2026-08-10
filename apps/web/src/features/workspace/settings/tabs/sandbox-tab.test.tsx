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
} from '../../customize/sections/view/sandbox-provider-coverage';
import { SandboxTabView } from './sandbox-tab';

/**
 * Carries forward ALL of `sandbox-provider-coverage.test.tsx`'s coverage
 * (deleted — see Task 20's brief) — same assertions, same import path
 * (`sandbox-provider-coverage.tsx` itself did not move, only its test did,
 * since `SandboxTemplateProviderCoverage`/`SandboxTemplateProviderModeBadge`
 * are Sandbox-half symbols per JAY-508, used only by this tab's
 * `TemplateRow`).
 */
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
    expect(describeProviderCoverage('ready')).toEqual({ label: 'Ready', tone: 'ok' });
    expect(describeProviderCoverage('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeProviderCoverage('failed')).toEqual({ label: 'Failed', tone: 'fail' });
    expect(describeProviderCoverage('not_built')).toEqual({
      label: 'Not ready',
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

  test('renders automatic mode with runtime readiness for every routed provider', () => {
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
    expect(html).toContain('Session runtime');
    expect(html).toContain('Daytona');
    expect(html).toContain('Platinum');
    expect(html).not.toContain('E2B');
    expect(html).toContain('Ready');
    expect(html).toContain('Building');
    expect(html).not.toContain('Selected');
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

    expect(html).toContain('Session runtime');
    expect(html).toContain('Daytona');
    expect(html).toContain('Ready');
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
    expect(html).not.toContain('Session runtime');
    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('E2B');
    expect(html).not.toContain('Unavailable');
  });
});

/**
 * `SandboxTabView` — the pure half of the split. `templatesSlot` is a slot
 * (see this tab's header comment for why `TemplateRow` can't render under
 * `renderToStaticMarkup`); these tests pin everything the pure view DOES
 * own directly: loading/error/empty states, the manifest hint, and that no
 * build-log content ever appears here.
 */
describe('SandboxTabView', () => {
  test('renders the header and the templates slot', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView isEmpty={false} templatesSlot={<li>template-row-marker</li>} />,
    );
    expect(out).toContain('Sandbox templates');
    expect(out).toContain('template-row-marker');
  });

  test('renders the empty state with its action when there are no templates', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView isEmpty emptyAction={<button type="button">new-template-marker</button>} />,
    );
    expect(out).toContain('No templates resolved yet.');
    expect(out).toContain('new-template-marker');
  });

  test('renders the header action when provided', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView headerAction={<button type="button">header-action-marker</button>} />,
    );
    expect(out).toContain('header-action-marker');
  });

  test('reads the manifest hint from kortix.toml by default, kortix.yaml at manifest v2', () => {
    const v1 = renderToStaticMarkup(<SandboxTabView manifestVersion={1} />);
    expect(v1).toContain('kortix.toml');
    expect(v1).not.toContain('kortix.yaml');

    const v2 = renderToStaticMarkup(<SandboxTabView manifestVersion={2} />);
    expect(v2).toContain('kortix.yaml');
    expect(v2).not.toContain('kortix.toml');
  });

  test('surfaces a partial-read warning without failing the whole tab', () => {
    const out = renderToStaticMarkup(<SandboxTabView templatesError="permission denied" />);
    expect(out).toContain('permission denied');
  });

  test('loading state shows a skeleton, not the manifest hint', () => {
    const out = renderToStaticMarkup(<SandboxTabView isLoading />);
    expect(out).not.toContain('Sessions boot from a sandbox template');
  });

  test('error state shows a retry action', () => {
    const out = renderToStaticMarkup(<SandboxTabView isError errorMessage="boom" />);
    expect(out).toContain('Retry');
    expect(out).toContain('boom');
  });

  test('never renders the build log or its vocabulary — that lives in SnapshotsTabView', () => {
    const out = renderToStaticMarkup(<SandboxTabView isEmpty={false} />);
    expect(out).not.toContain('Session template builds');
    expect(out).not.toContain('Build log');
    expect(out).not.toContain('Project accelerator');
    expect(out).not.toContain('Snapshot quota reached');
    expect(out).not.toContain('Sessions can’t start');
  });
});
