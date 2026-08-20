import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Page chrome for Secrets. It is a sibling tab of Connectors / Agents /
 * Skills / Triggers on the Customize bar and has to read as one: same
 * `CapabilityPageShell`, same `max-w-5xl` column, same heading, same header
 * group. It brought its own `max-w-2xl` column and its own
 * `SettingsSectionHeader` before, which is what made it look like a different
 * product beside the other four.
 *
 * Source-level assertions, following `schedule-view.test.tsx` and
 * `connectors-page.global-rules.test.ts`: apps/web has no DOM testing library,
 * and what is pinned here is WHERE a control is mounted, not what it renders.
 */
const source = readFileSync(join(import.meta.dir, 'secrets-view.tsx'), 'utf8');

/** Comments name the old layout on purpose; assert on code only. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const CHILDREN_START = '<div className="space-y-4">';
const shellStart = code.indexOf('<CapabilityPageShell');
const childrenStart = code.indexOf(CHILDREN_START);
/** The shell's props — `title`, `description`, `search`, `action`, `filters`. */
const shellHeader = code.slice(shellStart, childrenStart);
/** Everything the shell renders as its content column. */
const shellChildren = code.slice(childrenStart);

describe('SecretsView page chrome', () => {
  test('the page is the shared capability shell, not its own column', () => {
    expect(shellStart).toBeGreaterThan(-1);
    expect(childrenStart).toBeGreaterThan(shellStart);
    expect(shellHeader).toContain('title="Secrets"');
    // The two pieces of the old narrow layout, gone for good. The heading is
    // written here rather than looked up: `secrets` is in neither registry
    // `SettingsTabHeader` reads, and a missed lookup renders nothing at all.
    expect(code).not.toContain('max-w-2xl');
    expect(code).not.toContain('SettingsSectionHeader');
    expect(code).not.toContain('SettingsTabHeader');
    expect(code).not.toContain('CustomizeSectionWrapper');
  });

  /**
   * The heading has to actually say something. A `title` with no `description`
   * is the state the page was in — a word at the top of a bare table — so both
   * are pinned, and the description has to name the mechanism rather than
   * restate the title.
   */
  test('the heading explains what a secret is and how it reaches a session', () => {
    const description = shellHeader.match(/description="([^"]+)"/)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(80);
    expect(description).toContain('environment variable');
  });

  test('search and the Add action are the shell’s slots, not inline', () => {
    expect(shellHeader).toContain('InputGroupSearchInput');
    expect(shellHeader).toContain('onClick={openCreate}');
    expect(shellChildren).not.toContain('InputGroupSearchInput');
  });

  /**
   * Docs first, Add last — the pairing `SettingsTabHeader` renders for every
   * pane that declares a `docsHref`. Secrets has no registry entry to declare
   * one from, so losing the button is a silent regression unless it is pinned.
   */
  test('Docs sits beside Add in the one header cluster, secondary first', () => {
    const action = shellHeader.slice(shellHeader.indexOf('action={'));
    expect(action.indexOf('/docs/project/secrets')).toBeGreaterThan(-1);
    expect(action.indexOf('/docs/project/secrets')).toBeLessThan(
      action.indexOf('onClick={openCreate}'),
    );
  });

  /**
   * The Access legend is the shell's secondary row — where Skills and
   * Connectors put their scope tabs — not a block in the content column above
   * the table it explains. It must stay the collapsible built from the shared
   * presentation table: a legend restated in JSX drifts from the badge.
   */
  test('the Access legend is the filters row, and reads the shared table', () => {
    expect(shellHeader).toContain('filters={<SecretsAccessExplainer showEnforced={showEnforced} />}');
    expect(shellChildren).not.toContain('<SecretsAccessExplainer');
    expect(code).toContain('secretDeliveryLegend(showEnforced)');
    expect(code).toContain('What each Access value means');
    expect(code).toContain('<Collapsible open={open} onOpenChange={setOpen}');
    expect(code).toContain('<CollapsibleTrigger');
    expect(code).toContain('<CollapsibleContent>');
  });
});
