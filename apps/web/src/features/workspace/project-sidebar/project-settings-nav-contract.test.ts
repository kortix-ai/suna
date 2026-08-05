import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'project-settings-nav.tsx'), 'utf8');

/**
 * One exported function body, isolated from its neighbours. Cuts at the next
 * doc comment as well as the next export — the doc block BETWEEN two exports
 * belongs to the following one, and letting it ride along made a "does not
 * contain router.push" assertion pass or fail on prose.
 */
function fnSource(name: string): string {
  const start = SOURCE.indexOf(`export function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const ends = [SOURCE.indexOf('\n/**', start + 1), SOURCE.indexOf('\nexport function', start + 1)]
    .filter((i) => i !== -1)
    .sort((a, b) => a - b);
  return ends.length === 0 ? SOURCE.slice(start) : SOURCE.slice(start, ends[0]);
}

describe('project Settings sidebar entry', () => {
  test('navigates with a prefetching Link, not router.push', () => {
    // Same tripwire as the Files entry: a button + router.push cannot be
    // prefetched, so every click pays for the RSC payload and the route chunk
    // cold. `prefetch={false}` also contains "prefetch", hence the two asserts.
    const navItem = fnSource('ProjectSettingsNavItem');

    expect(navItem).toContain('<Link');
    expect(navItem).toMatch(/prefetch(\s|>|$)/);
    expect(navItem).not.toContain('prefetch={false}');
    expect(navItem).toContain('capabilityTabHref(projectId, tab)');
    expect(navItem).toContain('asChild');
    expect(navItem).not.toContain('router.push');
  });

  test('reads the three capability leaves, not one', () => {
    // Gating the whole entry on connector read alone would strand a caller who
    // may open Skills or Commands but not Connectors.
    expect(SOURCE).toContain('PROJECT_CONNECTOR_READ');
    expect(SOURCE).toContain('PROJECT_SKILL_READ');
    expect(SOURCE).toContain('PROJECT_COMMAND_READ');
  });

  test('stays visible while a probe is loading', () => {
    // Optimistic until an explicit deny — same rule as ProjectFilesNavItem.
    expect(SOURCE).toContain('p.allowed || p.isLoading');
  });

  test('closes the mobile drawer on navigate', () => {
    expect(fnSource('ProjectSettingsNavItem')).toContain('setOpenMobile(false)');
  });

  test('renders the Settings label and the Mod+, keycap', () => {
    const navItem = fnSource('ProjectSettingsNavItem');

    expect(navItem).toContain('Settings');
    expect(navItem).toContain("<Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>");
    expect(navItem).toContain('<Kbd>,</Kbd>');
  });

  test('derives isMac by comparison, not from the raw useDevice() string', () => {
    // useDevice() returns 'mac' | 'windows' | 'linux' | 'unknown'. The row this
    // replaced did `const isMac = useDevice()`, so `isMac ? '⌘' : 'Ctrl'` was
    // always truthy and Windows users were shown ⌘.
    expect(SOURCE).toContain("useDevice() === 'mac'");
  });

  test('the Customize twin shares the destination, gate, and Link contract', () => {
    // Two rows, one route. If they ever diverge, one of them is a dead end.
    const customize = fnSource('ProjectCustomizeNavItem');

    expect(customize).toContain('capabilityTabHref(projectId, tab)');
    expect(customize).toContain('useSettingsTab(projectId)');
    expect(customize).toContain('Customize');
    expect(customize).toMatch(/prefetch(\s|>|$)/);
    expect(customize).not.toContain('prefetch={false}');
    expect(customize).not.toContain('router.push');
    expect(customize).toContain('setOpenMobile(false)');
    // No keycap: Mod+, is printed on the Settings row, and one shortcut
    // advertised on two rows is a lie on at least one of them.
    expect(customize).not.toContain('<Kbd>');
  });

  test('the Mod+, shortcut goes where the row goes', () => {
    // A keycap that opens something other than what the row opens is worse
    // than no keycap. The Customize overlay stays reachable elsewhere.
    const hook = fnSource('useSettingsKeyboardShortcut');

    expect(hook).toContain("event.key === ','");
    expect(hook).toContain('capabilityTabHref(projectId, tab)');
    expect(SOURCE).not.toContain('openCustomize');
  });
});
