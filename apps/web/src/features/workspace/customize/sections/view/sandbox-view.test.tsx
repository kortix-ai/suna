import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ProjectSnapshotBuild } from '@kortix/sdk/projects-client';

import { BuildRow, isProjectAcceleratorBuild } from './sandbox-view';
import type { SandboxProviderMode } from './sandbox-provider-coverage';

const build = (overrides: Partial<ProjectSnapshotBuild> = {}): ProjectSnapshotBuild => ({
  build_id: 'build-1',
  slug: 'essentia',
  template_slug: 'essentia',
  snapshot_name: 'kortix-tpl-abc123',
  content_hash: 'abc123',
  status: 'failed',
  error: null,
  error_category: null,
  fixable_by_agent: false,
  source: 'manual',
  provider: 'daytona',
  started_at: '2026-07-13T10:00:00.000Z',
  finished_at: '2026-07-13T10:05:00.000Z',
  ...overrides,
});

describe('project accelerator build presentation', () => {
  test('identifies only ppwarm snapshots as project accelerators', () => {
    expect(
      isProjectAcceleratorBuild(
        build({
          slug: 'default-warm',
          template_slug: 'default',
          snapshot_name: 'kortix-ppwarm-00ead866-f5c859f984f2',
        }),
      ),
    ).toBe(true);
    expect(
      isProjectAcceleratorBuild(
        build({
          slug: 'worker-warm',
          template_slug: 'worker-warm',
          snapshot_name: 'kortix-tpl-worker',
        }),
      ),
    ).toBe(false);
  });

  test('labels a ppwarm build as a repository accelerator', () => {
    const html = renderBuildRow('automatic', {
      slug: 'default-warm',
      template_slug: 'default',
      snapshot_name: 'kortix-ppwarm-00ead866-f5c859f984f2',
    });

    expect(html).toContain('Repository accelerator');
    expect(html).not.toContain('>default-warm<');
  });
});

function renderBuildRow(providerMode: SandboxProviderMode, overrides?: Partial<ProjectSnapshotBuild>) {
  return renderToStaticMarkup(createElement(BuildRow, { build: build(overrides), providerMode }));
}

describe('sandbox template build row provider disclosure', () => {
  test('never names the resolved provider when the project is on Automatic', () => {
    const html = renderBuildRow('automatic');

    expect(html).not.toContain('Daytona');
    // Everything else about the build should still render.
    expect(html).toContain('essentia');
    expect(html).toContain('kortix-tpl-abc123');
    expect(html).toContain('Manual rebuild');
  });

  test('names the resolved provider once the project has explicitly pinned one', () => {
    const html = renderBuildRow('pinned');

    expect(html).toContain('Daytona');
  });

  test('does not render a provider badge when the build predates provider tracking', () => {
    const html = renderBuildRow('pinned', { provider: null });

    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('E2B');
  });
});
