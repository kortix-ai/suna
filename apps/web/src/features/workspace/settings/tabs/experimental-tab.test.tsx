import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExperimentalFeatureView } from '@kortix/sdk';

import { ExperimentalTabView } from './experimental-tab';

const betaFeature: ExperimentalFeatureView = {
  key: 'voice',
  name: 'Voice',
  description: 'Talk to your agent.',
  stability: 'beta',
  available: true,
  enabled: true,
  overridden: true,
};

const experimentalFeature: ExperimentalFeatureView = {
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
    expect(out).toContain('Early-access capabilities that may change or be removed.');
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
    const out = renderToStaticMarkup(<ExperimentalTabView features={[]} />);
    expect(out).toContain('No experimental features are available on this project yet.');
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

  test('does not render General-tab markers — the sandbox-provider pin and Delete workspace live there instead', () => {
    const out = renderToStaticMarkup(<ExperimentalTabView features={[betaFeature]} />);
    expect(out).not.toContain('Delete workspace');
    expect(out).not.toContain('Sandbox provider');
  });
});
