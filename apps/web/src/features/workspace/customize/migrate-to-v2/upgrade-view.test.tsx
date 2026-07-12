import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UpgradesViewContent } from './upgrade-view';

describe('UpgradesViewContent — per-state rendering', () => {
  test('v1 lists the manifest migration with a Run action, plus the one-off runner', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={1} onRun={() => {}} pending={false} canWrite />,
    );
    expect(html).toContain('Upgrades');
    expect(html).toContain('Migrate manifest to v2');
    expect(html).toContain('Run');
    // Applicable upgrades are surfaced as a highlighted, recommended action.
    expect(html).toContain('Recommended');
    expect(html).toContain('One-off upgrade');
    expect(html).not.toContain('up to date');
  });

  test('v2 shows the up-to-date empty state but keeps the one-off runner available', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={2} onRun={() => {}} pending={false} canWrite />,
    );
    expect(html).toContain('up to date');
    expect(html).not.toContain('Migrate manifest to v2');
    // No applicable upgrade ⇒ no recommended-action highlight.
    expect(html).not.toContain('Recommended');
    expect(html).toContain('One-off upgrade');
  });

  test('unresolved manifest read renders placeholders — no upgrade rows, no premature up-to-date claim', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={null} onRun={() => {}} pending={false} canWrite />,
    );
    expect(html).not.toContain('Migrate manifest to v2');
    expect(html).not.toContain('up to date');
  });

  test('run buttons disable while a session is being created', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={1} onRun={() => {}} pending canWrite />,
    );
    expect(html).toContain('disabled');
  });

  test('read-only (no write) hides the Run action and the one-off runner but keeps the explanation', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={1} onRun={() => {}} pending={false} canWrite={false} />,
    );
    // Section + upgrade row still render (data stays visible)…
    expect(html).toContain('Upgrades');
    expect(html).toContain('Migrate manifest to v2');
    expect(html).toContain('One-off upgrade');
    // …but the mutating "Run upgrade" control is gone.
    expect(html).not.toContain('Run upgrade');
  });
});
