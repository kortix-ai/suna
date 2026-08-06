import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar's footer group is bottom-anchored (`mt-auto`), so it grows
 * upward: every item that mounts late shoves everything ABOVE it up the page.
 * Billing items mount late by nature — they wait on account state — so they
 * have to sit above the permanent nav, otherwise Files / Connect visibly jump
 * the moment the wallet resolves.
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe pure ordering.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

function orderOf(component: string): number {
  const at = source.indexOf(`<${component}`);
  expect(at).toBeGreaterThan(-1);
  return at;
}

describe('project sidebar footer ordering', () => {
  test('late-arriving billing items render above the permanent nav', () => {
    expect(orderOf('SidebarUpgradeButton')).toBeLessThan(orderOf('ProjectFilesNavItem'));
    expect(orderOf('SidebarBalanceWarning')).toBeLessThan(orderOf('ProjectFilesNavItem'));
  });

  test('the permanent nav keeps its own order', () => {
    // Connectors/Skills/Commands/Customize collapsed into one Settings entry.
    // It holds the Customize row's old line: bottom of the footer group, below
    // Files, above the ChatGPT connect entry.
    expect(orderOf('ProjectFilesNavItem')).toBeLessThan(orderOf('ProjectSettingsNavItem'));
    expect(orderOf('ProjectSettingsNavItem')).toBeLessThan(
      orderOf('ProjectChatGptConnectNavItem'),
    );
  });

  test('Settings stays in the footer group; only Customize sits up top', () => {
    // Two entries, one destination: Customize above the session list, Settings
    // below it. Swapping either side is the regression this pins.
    expect(orderOf('ProjectCustomizeNavItem')).toBeLessThan(orderOf('ProjectSessionList'));
    expect(orderOf('ProjectSessionList')).toBeLessThan(orderOf('ProjectSettingsNavItem'));
    // The three capability rows are gone for good — they are tabs of the one
    // page both remaining entries link to. `ProjectCustomizeNavItem` is NOT in
    // this list: the name was reused for the top row.
    expect(source).not.toContain('<ProjectConnectorsNavItem');
    expect(source).not.toContain('<ProjectSkillsNavItem');
    expect(source).not.toContain('<ProjectCommandsNavItem');
  });
});
