import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar's footer group is bottom-anchored (`mt-auto`), so it grows
 * upward: every item that mounts late shoves everything ABOVE it up the page.
 * Billing items mount late by nature — they wait on account state.
 *
 * That argued for putting all of them above the permanent nav, and this file
 * pinned exactly that until 2026-09-03. `SidebarUpgradeButton` moved to LAST
 * on Jay's call: it is the only paid call to action in the group, and above
 * Files / Connect GPT it put a sell between the user and the links they use.
 * The placement is the product decision; the shift is the cost of it, and it
 * is one row of movement on a resolve that happens once per page load.
 *
 * `SidebarBalanceWarning` did NOT move. It is an alert rather than an offer,
 * and it is still pinned above the nav below.
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
  test('the balance alert renders above the permanent nav', () => {
    // Unchanged rule, narrowed to the row it still covers: an alert about the
    // wallet is not something to scroll past the nav to find.
    expect(orderOf('SidebarBalanceWarning')).toBeLessThan(orderOf('ProjectFilesNavItem'));
  });

  test('the upgrade button is last in the group', () => {
    // The one deliberate exception to the rule above (Jay, 2026-09-03). Pinned
    // in its new position rather than deleted, so moving it back is also a
    // decision someone has to make on purpose.
    expect(orderOf('SidebarUpgradeButton')).toBeGreaterThan(orderOf('ProjectFilesNavItem'));
    expect(orderOf('SidebarUpgradeButton')).toBeGreaterThan(
      orderOf('ProjectChatGptConnectNavItem'),
    );
  });

  test('the permanent nav keeps its own order', () => {
    // Connectors/Skills/Commands/Customize collapsed into one Settings entry,
    // which held the Customize row's old line — bottom of the footer group,
    // below Files, above the ChatGPT connect entry. That Settings row is gone
    // now too (Jay, 2026-08-17): it opened the same User Settings overlay a
    // click on the workspace switcher already opens, one level up. Files
    // sits directly above the ChatGPT connect entry with nothing between them.
    expect(orderOf('ProjectFilesNavItem')).toBeLessThan(orderOf('ProjectChatGptConnectNavItem'));
    expect(source).not.toContain('<ProjectSettingsNavItem');
  });

  test('Customize sits up top; nothing stands in for the old Settings row', () => {
    // One entry, one destination: Customize above the session list.
    expect(orderOf('ProjectCustomizeNavItem')).toBeLessThan(orderOf('ProjectSessionList'));
    // The three capability rows are gone for good — they are tabs of the one
    // page Customize links to. `ProjectCustomizeNavItem` is NOT in this list:
    // the name was reused for the top row.
    expect(source).not.toContain('<ProjectConnectorsNavItem');
    expect(source).not.toContain('<ProjectSkillsNavItem');
    expect(source).not.toContain('<ProjectCommandsNavItem');
  });
});
