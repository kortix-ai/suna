import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ProjectSnapshotBuild, SandboxRuntimeStatus } from '@kortix/sdk';

import { TooltipProvider } from '@/components/ui/tooltip';

import type { FailedBuildRelevance } from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import type { SandboxProviderMode } from '../../customize/sections/view/sandbox-provider-coverage';
import { BuildRow, SnapshotsTabView, isProjectAcceleratorBuild } from './snapshots-tab';

/**
 * Carries forward ALL of `sandbox-view.test.tsx`'s coverage (deleted — see
 * Task 20's brief) — same assertions, import path updated from
 * `./sandbox-view` to `./snapshots-tab` since `BuildRow`/
 * `isProjectAcceleratorBuild` are Snapshots-half symbols per JAY-508.
 */
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

const runtimeStatus = (overrides: Partial<SandboxRuntimeStatus> = {}): SandboxRuntimeStatus => ({
  state: 'ready',
  snapshot_name: 'kortix-tpl-abc123',
  current_failure: null,
  stale_failure: null,
  stale_reason: null,
  ready_providers: [],
  building_providers: [],
  failed_providers: [],
  fix_with_agent_available: false,
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

function renderBuildRow(
  providerMode: SandboxProviderMode,
  overrides?: Partial<ProjectSnapshotBuild>,
  relevance?: FailedBuildRelevance | null,
) {
  return renderToStaticMarkup(
    // The app mounts one provider in the root layout (src/app/layout.tsx).
    createElement(
      TooltipProvider,
      null,
      createElement(BuildRow, { build: build(overrides), providerMode, relevance }),
    ),
  );
}

describe('failed build rows that no longer apply', () => {
  // A red row is a claim that something is wrong right now. A build that failed
  // against a definition nobody boots anymore makes that claim falsely — which
  // is how an 11-day-old failure read as a live outage.
  test('drops the red tile for a superseded or resolved failure', () => {
    for (const [relevance, label] of [
      ['superseded', 'superseded'],
      ['recovered', 'resolved'],
      ['retrying', 'retrying'],
    ] as const) {
      const html = renderBuildRow('automatic', {}, relevance);

      expect(html).toContain(label);
      expect(html).not.toContain('bg-kortix-red/15');
      expect(html).not.toContain('text-kortix-red');
    }
  });

  test('keeps the red tile while the failure still blocks sessions', () => {
    const html = renderBuildRow('automatic', {}, 'blocking');

    expect(html).toContain('bg-kortix-red/15');
    expect(html).not.toContain('superseded');
  });

  test('leaves an unclassified failure exactly as it was', () => {
    expect(renderBuildRow('automatic', {}, null)).toContain('bg-kortix-red/15');
  });
});

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

/**
 * `SnapshotsTabView` — the pure half of the split. Unlike `SandboxTabView`,
 * no slots are needed — `BuildRow`/`SandboxStatusBanner` are already
 * props-only (see this tab's header comment) — so these tests exercise the
 * whole build log directly through data props.
 */
describe('SnapshotsTabView', () => {
  test('renders the build log for a template build', () => {
    const out = renderToStaticMarkup(
      <TooltipProvider>
        <SnapshotsTabView templateBuilds={[build()]} />
      </TooltipProvider>,
    );
    expect(out).toContain('essentia');
    expect(out).toContain('Build log');
  });

  test('renders the empty build-log fallback when there are no builds', () => {
    const out = renderToStaticMarkup(<SnapshotsTabView />);
    expect(out).toContain('No builds recorded yet.');
  });

  test('renders the project accelerator section only when accelerator builds exist', () => {
    const withAccelerator = renderToStaticMarkup(
      <TooltipProvider>
        <SnapshotsTabView
          acceleratorBuilds={[
            build({
              slug: 'default-warm',
              snapshot_name: 'kortix-ppwarm-abc123',
            }),
          ]}
        />
      </TooltipProvider>,
    );
    expect(withAccelerator).toContain('Project accelerator');
    expect(withAccelerator).toContain('Repository accelerator');

    const without = renderToStaticMarkup(<SnapshotsTabView />);
    expect(without).not.toContain('Project accelerator');
  });

  test('shows the blocked status banner with a Rebuild action for a manager', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView
        canManage
        status={runtimeStatus({ state: 'blocked', failed_providers: ['daytona'] })}
      />,
    );
    expect(out).toContain('Sessions can’t start');
    expect(out).toContain('Rebuild');
  });

  test('hides the Rebuild action for a non-manager', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView
        canManage={false}
        status={runtimeStatus({ state: 'blocked', failed_providers: ['daytona'] })}
      />,
    );
    expect(out).not.toContain('Rebuild');
  });

  test('shows no status banner for a healthy project', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView status={runtimeStatus({ state: 'ready' })} />,
    );
    expect(out).not.toContain('Sessions can’t start');
    expect(out).not.toContain('Some sessions won’t start');
  });

  test('loading state shows a skeleton, not the build log', () => {
    const out = renderToStaticMarkup(<SnapshotsTabView isLoading templateBuilds={[build()]} />);
    expect(out).not.toContain('essentia');
  });

  test('error state shows a retry action', () => {
    const out = renderToStaticMarkup(<SnapshotsTabView isError errorMessage="boom" />);
    expect(out).toContain('Retry');
    expect(out).toContain('boom');
  });

  test('never renders the template form or template vocabulary — that lives in SandboxTabView', () => {
    const out = renderToStaticMarkup(<SnapshotsTabView templateBuilds={[build()]} />);
    expect(out).not.toContain('New template');
    expect(out).not.toContain('Sandbox templates');
    expect(out).not.toContain('No templates resolved yet.');
  });
});
