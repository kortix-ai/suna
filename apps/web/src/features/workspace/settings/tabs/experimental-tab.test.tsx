import type { FeatureFlagView } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExperimentalTabView } from './experimental-tab';

const betaFeature: FeatureFlagView = {
  key: 'voice',
  name: 'Voice',
  description: 'Talk to your agent.',
  stability: 'beta',
  available: true,
  enabled: true,
  overridden: true,
};

const experimentalFeature: FeatureFlagView = {
  key: 'apps',
  name: 'Apps',
  description: 'Early-access app discovery.',
  stability: 'experimental',
  available: true,
  enabled: false,
  overridden: false,
};

/**
 * `ExperimentalTabView` is the pure, props-only half — no hooks, no data
 * fetching (see this tab's header comment). `features` is passed in already
 * filtered to `available` entries and already carrying any optimistic
 * `enabled` override — that filtering/override logic lives in
 * `ExperimentalTab` (the container) and is untestable here by design, same
 * as every other tab's real container (see `api-keys-tab.test.tsx`).
 */
describe('ExperimentalTabView', () => {
  test('renders the header title and description', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView />);
    expect(out).toContain('Experimental');
    expect(out).toContain('Features you can switch on before they are generally available.');
  });

  test('renders one row per feature, each with its name, description, and stability badge', () => {
    const out = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature, experimentalFeature]} />,
    );
    expect(out).toContain('Voice');
    expect(out).toContain('Talk to your agent.');
    expect(out).toContain('Beta');
    expect(out).toContain('Apps');
    expect(out).toContain('Early-access app discovery.');
    expect(out).toContain('Experimental');
  });

  test('rows render in the same order as the features array', () => {
    const out = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature, experimentalFeature]} />,
    );
    expect(out.indexOf('Voice')).toBeLessThan(out.indexOf('Apps'));
  });

  test('a feature switch reflects its enabled state via aria-checked', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView features={[betaFeature]} />);
    expect(out).toContain('aria-checked="true"');
  });

  test('a disabled feature switch reflects aria-checked="false"', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView features={[experimentalFeature]} />);
    expect(out).toContain('aria-checked="false"');
  });

  test('a pending feature key disables its own switch', () => {
    const out = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature]} pendingKeys={['voice']} canManage />,
    );
    expect(out).toMatch(/role="switch"[^>]*disabled/);
  });

  test('canManage false disables every switch, even with no pending key', () => {
    const out = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature]} canManage={false} />,
    );
    expect(out).toMatch(/role="switch"[^>]*disabled/);
  });

  test('renders an empty state with no features and no table markup', () => {
    // The shared `EmptyState` primitive since the `main` merge — ported from
    // that branch's `feature-flags-view.tsx`, replacing a bare sentence.
    const out = renderToStaticMarkup(<ExperimentalTabView features={[]} />);
    expect(out).toContain('data-slot="empty"');
    expect(out).toContain('No experimental features');
    expect(out).toContain('This deployment exposes no per-project feature flags.');
    expect(out).not.toContain('<table');
  });

  test('loading state shows a skeleton, not any feature row', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView isLoading features={[betaFeature]} />);
    expect(out).not.toContain('Voice');
  });

  test('error state shows a retry action, not any feature row', () => {
    const out = renderToStaticMarkup(
      <ExperimentalTabView isError errorMessage="boom" features={[betaFeature]} />,
    );
    expect(out).toContain('Retry');
    expect(out).toContain('boom');
    expect(out).not.toContain('Voice');
  });

  test('every stability the API can serve has its own badge, including stable', () => {
    // Ported from `main`'s `feature-flags-view.test.ts`. `FeatureFlagStability`
    // is experimental | beta | stable; the two-way ternary this replaced
    // rendered a `stable` flag as "Experimental" — a wrong label, not a
    // compile error.
    const stable: FeatureFlagView = {
      key: 'teams',
      name: 'Teams',
      description: 'Shipped, still behind a switch.',
      stability: 'stable',
      available: true,
      enabled: true,
      overridden: false,
    };
    const out = renderToStaticMarkup(<ExperimentalTabView features={[stable]} />);
    expect(out).toContain('Stable');
  });

  test('each row states whether it is a default or a project override', () => {
    // Ported from `main`'s `feature-flags-view.test.ts`. `overridden` reports
    // WHETHER the project set a choice, not what the default was.
    const overridden = renderToStaticMarkup(<ExperimentalTabView features={[betaFeature]} />);
    expect(overridden).toContain('Overridden for this project');

    const inherited = renderToStaticMarkup(
      <ExperimentalTabView features={[experimentalFeature]} />,
    );
    expect(inherited).toContain('Default off');
    expect(
      renderToStaticMarkup(
        <ExperimentalTabView features={[{ ...experimentalFeature, enabled: true }]} />,
      ),
    ).toContain('Default on');
  });

  test('the customize-write notice renders only when the probe has resolved to a denial', () => {
    // Ported from `main`'s `feature-flags-view.tsx`. While the IAM probe is in
    // flight the switches are already disabled (fail-closed) but the reason is
    // unknown, so the line must stay off rather than assert a denial.
    const denied = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature]} canManage={false} showPermissionNotice />,
    );
    expect(denied).toContain('customize-write permission');

    const probing = renderToStaticMarkup(
      <ExperimentalTabView features={[betaFeature]} canManage={false} />,
    );
    expect(probing).not.toContain('customize-write permission');
  });

  test('does not render General-tab markers — the sandbox-provider pin and Delete workspace live there instead', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView features={[betaFeature]} />);
    expect(out).not.toContain('Delete workspace');
    expect(out).not.toContain('Sandbox provider');
  });
});
