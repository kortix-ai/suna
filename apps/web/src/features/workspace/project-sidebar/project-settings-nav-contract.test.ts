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

/**
 * The two rows open the two halves of one shell — Customize (what the agent is
 * and can do) and Settings (administration). They are symmetrical by design,
 * and these tests exist to keep them that way: the pair that used to live here
 * was asymmetric (one routed `<Link>`, one overlay button) and every rule below
 * had to be stated twice with opposite expectations.
 */
describe('both project-configuration sidebar entries', () => {
  for (const [name, opener] of [
    ['ProjectCustomizeNavItem', 'openCustomize()'],
    ['ProjectSettingsNavItem', 'openSettings()'],
  ] as const) {
    test(`${name} opens its panel instead of navigating`, () => {
      // The panels float over the current page on purpose
      // (settings-panel-store): routing there instead would drop you out of
      // whatever session you were in. That also means there is no href to
      // prefetch and no pathname to read.
      const navItem = fnSource(name);

      expect(navItem).toContain(opener);
      expect(navItem).not.toContain('<Link');
      expect(navItem).not.toContain('router.push');
      expect(navItem).not.toContain('usePathname');
    });

    test(`${name} is ungated`, () => {
      // Each panel holds a dozen panes behind a dozen leaves and filters its
      // own rail per row. Gating the ENTRY on any single leaf would hide a
      // whole surface from a caller who can still use most of it. The Customize
      // row used to probe the three capability leaves, back when it was a link
      // to one page that could 403.
      const navItem = fnSource(name);

      expect(navItem).not.toContain('useProjectCan');
      expect(navItem).not.toContain('PROJECT_ACTIONS');
    });

    test(`${name} closes the mobile drawer`, () => {
      expect(fnSource(name)).toContain('setOpenMobile(false)');
    });
  }

  test('each row lights up for its OWN panel, never for the other', () => {
    // `s.open` alone lit both rows whenever either panel was showing — the two
    // are one store and one overlay now, so the surface is what tells them
    // apart.
    expect(fnSource('ProjectCustomizeNavItem')).toContain("s.surface === 'customize'");
    expect(fnSource('ProjectSettingsNavItem')).toContain("s.surface === 'settings'");
  });
});

describe('project Customize sidebar entry', () => {
  test('carries no keycap', () => {
    // Mod+, is printed on the Settings row, and one shortcut advertised on two
    // rows is a lie on at least one of them.
    expect(fnSource('ProjectCustomizeNavItem')).not.toContain('<Kbd>');
  });

  test('does not open Settings', () => {
    expect(fnSource('ProjectCustomizeNavItem')).not.toContain('openSettings');
  });
});

describe('project Settings sidebar entry', () => {
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
});

describe('the Mod+, shortcut', () => {
  test('goes where the row it is printed on goes — Settings', () => {
    const hook = fnSource('useSettingsKeyboardShortcut');

    expect(hook).toContain("event.key === ','");
    expect(hook).toContain('openSettings()');
    expect(hook).not.toContain('openCustomize');
    expect(hook).not.toContain('router.push');
  });
});
