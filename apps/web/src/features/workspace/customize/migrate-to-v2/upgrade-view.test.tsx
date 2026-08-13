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
    expect(html).toContain('One-off upgrade');
    expect(html).not.toContain('up to date');
  });

  test('v2 shows the up-to-date row but keeps the one-off runner available', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={2} onRun={() => {}} pending={false} canWrite />,
    );
    expect(html).toContain('up to date');
    expect(html).not.toContain('Migrate manifest to v2');
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

  test('read-only keeps the upgrade list readable but drops every control', () => {
    const html = renderToStaticMarkup(
      <UpgradesViewContent version={1} onRun={() => {}} pending={false} canWrite={false} />,
    );
    // What is pending is a read, so the row and its explanation stay…
    expect(html).toContain('Upgrades');
    expect(html).toContain('Migrate manifest to v2');
    // …and the reason the controls are missing is said once, at the top.
    expect(html).toContain('needs write access to this workspace');
    // …but nothing that mutates renders: not the row's Run, and not the
    // one-off composer, which is a control and nothing else.
    expect(html).not.toContain('Run upgrade');
    expect(html).not.toContain('One-off upgrade');
    expect(html).not.toContain('<textarea');
  });
});

/**
 * The pane's chrome, pinned. Each of these replaced something specific — see
 * `upgrade-view.tsx`'s header comment for the full list — and each would come
 * back the moment somebody copied the old markup from git history.
 */
describe('UpgradesViewContent — pane chrome', () => {
  const html = renderToStaticMarkup(
    <UpgradesViewContent version={1} onRun={() => {}} pending={false} canWrite />,
  );

  /**
   * The upgrade row carried `bg-kortix-base/[0.06]`, `border-kortix-base/30`,
   * `shadow-kortix-base/20` and `shadow-md`. The design system reserves
   * `kortix-*` for state and shadows for overlays: an in-flow panel gets a
   * border and nothing else. This was the one surface in the pane that shouted.
   */
  test('no brand-tinted, shadowed card — in-flow surfaces are flat with a border', () => {
    // The three tinted-SURFACE utilities, not the bare token: every `Button`
    // carries `focus-visible:ring-kortix-base`, which is the accent doing its
    // job. Asserting on `kortix-base` alone would fail on that and tell nobody
    // anything about this row.
    expect(html).not.toContain('bg-kortix-base/');
    expect(html).not.toContain('border-kortix-base/');
    expect(html).not.toContain('shadow-kortix-base/');
    expect(html).not.toContain('shadow-md');
    // …and the ring on the icon tile that sat inside it.
    expect(html).not.toContain('ring-inset');
  });

  /**
   * `ProjectUpgrade` has no field that could make this false, so it rendered on
   * every row unconditionally and competed with the Run button for the same
   * job. A badge that never varies carries no information.
   */
  test('no "Recommended" badge — it was true of every row, always', () => {
    expect(html).not.toContain('Recommended');
  });

  /**
   * The pane heading and its description come from `rail.ts`'s `UPGRADE_ITEM`
   * via `SettingsTabHeader`. Before this, the same sentence existed in three
   * wordings and the rail's — the canonical one — was the copy that never
   * rendered. The assertion reads the rail's exact words: a second hardcoded
   * description would not contain them.
   */
  test('the heading description is the rail entry, not a local string', () => {
    expect(html).toContain('nothing merges on its own');
  });

  /**
   * `<Label>` renders a bare `<label>`, so the outline went `h2` → nothing →
   * rows and a screen-reader user had no way to jump between the two sections.
   * `SettingsSubsectionHeader` is the `h3` level between them.
   */
  test('section headings are real headings, not labels', () => {
    expect(html).toContain('<h3');
    expect(html).toMatch(/<h3[^>]*>Available upgrades<\/h3>/);
  });
});
