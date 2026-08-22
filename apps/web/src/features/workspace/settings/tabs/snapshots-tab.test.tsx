import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ProjectSnapshotBuild, SandboxRuntimeStatus } from '@kortix/sdk';

import { TooltipProvider } from '@/components/ui/tooltip';

import type { FailedBuildRelevance } from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import type { SandboxProviderMode } from '../../customize/sections/view/sandbox-provider-coverage';
import {
  BuildDetails,
  BuildRow,
  SnapshotsTabView,
  describeBuildOutcome,
  isProjectAcceleratorBuild,
} from './snapshots-tab';

/**
 * Carries forward ALL of `sandbox-view.test.tsx`'s coverage (deleted — see
 * Task 20's brief), plus the coverage the disclosure rewrite needs.
 *
 * **The trap this file is written around.** `DisclosureContent` unmounts its
 * children while closed, so anything inside a build row's body is absent from a
 * collapsed `BuildRow`'s markup. Asserting `not.toContain('Daytona')` against a
 * collapsed row would therefore pass whatever the body does — a test that
 * cannot fail. Every assertion about a build's technical facts goes through
 * `BuildDetails` (the exported body) instead, and each negative assertion has a
 * positive counterpart proving the string can appear at all.
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

const accelerator = (overrides: Partial<ProjectSnapshotBuild> = {}): ProjectSnapshotBuild =>
  build({
    slug: 'default-warm',
    template_slug: 'default',
    snapshot_name: 'kortix-ppwarm-00ead866-f5c859f984f2',
    ...overrides,
  });

describe('project accelerator build presentation', () => {
  test('identifies historical and exact scoped project images as accelerators', () => {
    expect(isProjectAcceleratorBuild(accelerator())).toBe(true);
    expect(
      isProjectAcceleratorBuild(
        accelerator({ snapshot_name: 'kortix-ppwarm-historical-provider-value' }),
      ),
    ).toBe(true);
    expect(
      isProjectAcceleratorBuild(
        accelerator({
          snapshot_name:
            'kpp2-111111111111-222222222222-3333333333333333-4444444444444444',
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

  test('does not label malformed kpp2 values as project accelerators', () => {
    expect(
      isProjectAcceleratorBuild(accelerator({ snapshot_name: 'kpp2-not-an-image' })),
    ).toBe(false);
  });

  test.each([
    'kortix-ppwarm-00ead866-f5c859f984f2',
    'kpp2-111111111111-222222222222-3333333333333333-4444444444444444',
  ])('labels project image %s as a repository accelerator', (snapshotName) => {
    const html = renderBuildRow('automatic', {
      slug: 'default-warm',
      template_slug: 'default',
      snapshot_name: snapshotName,
    });

    expect(html).toContain('Repository accelerator');
    expect(html).not.toContain('>default-warm<');
  });
});

/**
 * The wording decision, tested without a DOM — the part most likely to drift
 * back into jargon. Same reasoning `disclosure.tsx` gives for extracting
 * `resolveDisclosureToggle`.
 */
describe('describeBuildOutcome', () => {
  test('says what each state means in a plain sentence', () => {
    expect(describeBuildOutcome(build({ status: 'ready' }))).toMatchObject({
      title: 'essentia',
      summary: 'Ready for new sessions',
      stale: null,
    });
    expect(describeBuildOutcome(build({ status: 'building' })).summary).toBe('Being prepared now');
    expect(describeBuildOutcome(build({ status: 'failed' }), 'blocking').summary).toBe(
      'New sessions can’t start on this',
    );
  });

  test('a failure with no verdict from the API claims nothing about sessions', () => {
    const outcome = describeBuildOutcome(build({ status: 'failed' }), null);

    expect(outcome.summary).toBe('Didn’t finish');
    expect(outcome.stale).toBeNull();
  });

  test('explains a stale failure instead of labelling it with a term', () => {
    // These three words used to be Badges whose meaning sat behind a tooltip.
    for (const [relevance, expected] of [
      ['superseded', 'Didn’t finish, and a newer setup has replaced it'],
      ['recovered', 'Didn’t finish, but the environment is ready now'],
      ['retrying', 'Didn’t finish — a new attempt is running'],
    ] as const) {
      const outcome = describeBuildOutcome(build({ status: 'failed' }), relevance);

      expect(outcome.summary).toBe(expected);
      expect(outcome.stale).toBe(relevance);
    }
  });

  test('an accelerator failure says sessions are unaffected; a template failure does not', () => {
    expect(describeBuildOutcome(accelerator({ status: 'failed' }), null).summary).toBe(
      'Didn’t finish — sessions still start normally',
    );
    expect(describeBuildOutcome(build({ status: 'failed' }), null).summary).not.toContain(
      'sessions still start normally',
    );
  });

  test('names an accelerator by what it is, never by its slug', () => {
    expect(describeBuildOutcome(accelerator({ status: 'ready' }))).toMatchObject({
      title: 'Repository accelerator',
      summary: 'Head start ready for the next session',
    });
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

function renderBuildDetails(
  providerMode: SandboxProviderMode,
  overrides?: Partial<ProjectSnapshotBuild>,
) {
  return renderToStaticMarkup(
    createElement(BuildDetails, { build: build(overrides), providerMode }),
  );
}

describe('failed build rows that no longer apply', () => {
  // A red row is a claim that something is wrong right now. A build that failed
  // against a definition nobody boots anymore makes that claim falsely — which
  // is how an 11-day-old failure read as a live outage.
  test('drops the red tile for a superseded or resolved failure', () => {
    for (const [relevance, summary] of [
      ['superseded', 'newer setup has replaced it'],
      ['recovered', 'the environment is ready now'],
      ['retrying', 'a new attempt is running'],
    ] as const) {
      const html = renderBuildRow('automatic', {}, relevance);

      expect(html).toContain(summary);
      expect(html).not.toContain('bg-kortix-red/15');
      expect(html).not.toContain('text-kortix-red');
    }
  });

  test('keeps the red tile while the failure still blocks sessions', () => {
    const html = renderBuildRow('automatic', {}, 'blocking');

    expect(html).toContain('bg-kortix-red/15');
    expect(html).toContain('New sessions can’t start on this');
  });

  test('leaves an unclassified failure exactly as it was', () => {
    expect(renderBuildRow('automatic', {}, null)).toContain('bg-kortix-red/15');
  });
});

describe('every build row can be opened', () => {
  // A row that looked like its neighbour but silently refused to expand taught
  // readers the chevron meant nothing. Success rows carry facts too.
  test('a successful build row is a disclosure, not a dead end', () => {
    const html = renderBuildRow('automatic', { status: 'ready', error: null });

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Ready for new sessions');
  });

  test('the snapshot name is not on the collapsed row — it lives in the details', () => {
    expect(renderBuildRow('automatic', { status: 'ready' })).not.toContain('kortix-tpl-abc123');
    expect(renderBuildDetails('automatic', { status: 'ready' })).toContain('kortix-tpl-abc123');
  });
});

describe('BuildDetails', () => {
  test('never names the resolved provider when the project is on Automatic', () => {
    const html = renderBuildDetails('automatic');

    expect(html).not.toContain('Daytona');
    // Every other fact is still there — this is a scoping rule, not a blank body.
    expect(html).toContain('kortix-tpl-abc123');
    expect(html).toContain('Manual rebuild');
    expect(html).toContain('Triggered by');
  });

  test('names the resolved provider once the project has explicitly pinned one', () => {
    expect(renderBuildDetails('pinned')).toContain('Daytona');
  });

  test('omits the provider fact when the build predates provider tracking', () => {
    const html = renderBuildDetails('pinned', { provider: null });

    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Runs on');
  });

  test('explains a failure category in plain words beside the raw log', () => {
    const html = renderBuildDetails('automatic', {
      status: 'failed',
      error: 'exit code 1',
      error_category: 'quota',
    });

    expect(html).toContain('Snapshot quota reached');
    expect(html).toContain('as many prepared machines as its plan allows');
    expect(html).toContain('exit code 1');
  });

  test('an unclassified failure still gets an explanation, not a bare log', () => {
    const html = renderBuildDetails('automatic', { status: 'failed', error: 'boom' });

    expect(html).toContain('could not classify');
    expect(html).toContain('boom');
  });

  test('a successful build shows no failure explanation', () => {
    const html = renderBuildDetails('automatic', { status: 'ready', error: null });

    expect(html).not.toContain('Build failed');
    expect(html).not.toContain('could not classify');
  });
});

/**
 * `SnapshotsTabView` — the pure half of the split. Unlike `SandboxTabView`,
 * no slots are needed — every component it renders is props-only — so these
 * tests exercise the whole page directly through data props.
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
        <SnapshotsTabView acceleratorBuilds={[accelerator()]} />
      </TooltipProvider>,
    );
    expect(withAccelerator).toContain('Project accelerator');
    expect(withAccelerator).toContain('Repository accelerator');
    expect(withAccelerator).toContain('never stops a session');

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

  test('explains a blocking failure category in the banner, not just names it', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView
        status={runtimeStatus({
          state: 'blocked',
          current_failure: build({ error_category: 'git', error: 'permission denied' }),
        })}
      />,
    );
    expect(out).toContain('Repository access failed');
    expect(out).toContain('Check that the repository connection is still authorised');
  });

  test('tells a healthy project it is healthy instead of leaving the question open', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView status={runtimeStatus({ state: 'ready' })} />,
    );

    expect(out).toContain('This project’s environment is ready');
    expect(out).not.toContain('Sessions can’t start');
    expect(out).not.toContain('Some sessions won’t start');
  });

  test('says a build in flight makes sessions wait, not fail', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView status={runtimeStatus({ state: 'building' })} />,
    );
    expect(out).toContain('Preparing this project’s environment');
    expect(out).toContain('they don’t fail');
  });

  test('says nothing was prepared yet rather than implying something is wrong', () => {
    const out = renderToStaticMarkup(
      <SnapshotsTabView status={runtimeStatus({ state: 'not_built' })} />,
    );
    expect(out).toContain('Nothing prepared yet');
  });

  test('claims nothing when the API could not observe the providers', () => {
    // `unknown` means the providers were unreachable. A confident "ready" here
    // would be a fabrication, so the summary must be absent entirely.
    const unknown = renderToStaticMarkup(
      <SnapshotsTabView status={runtimeStatus({ state: 'unknown' })} />,
    );
    expect(unknown).not.toContain('environment is ready');
    expect(unknown).not.toContain('Nothing prepared yet');

    const absent = renderToStaticMarkup(<SnapshotsTabView status={null} />);
    expect(absent).not.toContain('environment is ready');
  });

  test('answers the three questions the log provokes', () => {
    const out = renderToStaticMarkup(<SnapshotsTabView />);

    expect(out).toContain('How this works');
    expect(out).toContain('What is a snapshot?');
    expect(out).toContain('One of them failed. Is that a problem?');
  });

  test('renders no pane heading of its own — SandboxTabView, mounted above it, owns the shared one', () => {
    // Snapshots merged into the Sandbox templates section on
    // `/projects/[id]/config`. `SandboxTabView` carries the shared heading
    // (title, description, and the `/docs/work/runtime` Docs link) for the
    // whole merged pane; a second one here would be a duplicate, not a fix.
    const out = renderToStaticMarkup(<SnapshotsTabView />);
    expect(out).not.toContain('>Docs<');
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
