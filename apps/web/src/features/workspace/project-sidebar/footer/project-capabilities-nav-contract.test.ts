import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(import.meta.dir, 'project-customize-nav.tsx'), 'utf8');

/** Isolate one exported nav-item function body from its neighbours. */
function navItemSource(name: string): string {
  const start = SOURCE.indexOf(`export function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const after = SOURCE.indexOf('export function', start + 1);
  return after === -1 ? SOURCE.slice(start) : SOURCE.slice(start, after);
}

/**
 * The three entries that graduated out of the Customize overlay, each a copy
 * of the ProjectFilesNavItem pattern pinned by project-files-nav-contract.test.ts.
 * Table-driven over a plain array (not `test.each` — this repo's bun-types
 * version has no typings for it, and using it here would add a fresh `tsc`
 * error the fix-round gate explicitly checks stays at zero).
 */
const ENTRIES = [
  {
    name: 'ProjectConnectorsNavItem',
    label: 'Connectors',
    key: 'connectors',
    readAction: 'PROJECT_CONNECTOR_READ',
    allowedVar: 'canReadConnectors',
  },
  {
    name: 'ProjectSkillsNavItem',
    label: 'Skills',
    key: 'skills',
    readAction: 'PROJECT_SKILL_READ',
    allowedVar: 'canReadSkills',
  },
  {
    name: 'ProjectCommandsNavItem',
    label: 'Commands',
    key: 'commands',
    readAction: 'PROJECT_COMMAND_READ',
    allowedVar: 'canReadCommands',
  },
] as const;

describe('project Connectors/Skills/Commands sidebar entries', () => {
  for (const entry of ENTRIES) {
    describe(entry.name, () => {
      test('navigates with a prefetching Link, not router.push', () => {
        // Same tripwire as the Files entry: a button + router.push cannot be
        // prefetched, so every click pays for the RSC payload and the route
        // chunk cold.
        const navItem = navItemSource(entry.name);

        expect(navItem).toContain('<Link');
        // toContain('prefetch') alone is vacuous: `prefetch={false}` also
        // contains the substring "prefetch" and would pass.
        expect(navItem).toMatch(/prefetch(\s|>|$)/);
        expect(navItem).not.toContain('prefetch={false}');
        expect(navItem).toContain(`capabilityTabHref(projectId, '${entry.key}')`);
        expect(navItem).toContain('asChild');
        expect(navItem).not.toContain('router.push');
      });

      test(`gates on ${entry.readAction}, optimistic while the probe loads`, () => {
        const navItem = navItemSource(entry.name);

        expect(navItem).toContain(entry.readAction);
        expect(navItem).toContain(`!${entry.allowedVar}.allowed && !${entry.allowedVar}.isLoading`);
      });

      test('closes the mobile drawer on navigate', () => {
        const navItem = navItemSource(entry.name);

        expect(navItem).toContain('setOpenMobile(false)');
      });

      test('renders the expected label', () => {
        const navItem = navItemSource(entry.name);

        expect(navItem).toContain(entry.label);
      });

      test('active state comes from activeCapabilityTab, not a hand-rolled regex', () => {
        // The Files entry hand-rolls its own pathname regex because it isn't a
        // capability tab; these three ARE, so they should all read through the
        // one shared helper Task 1 built rather than re-deriving it three ways.
        const navItem = navItemSource(entry.name);

        expect(navItem).toContain(`activeCapabilityTab(pathname) === '${entry.key}'`);
      });
    });
  }

  test('does not fall back to the Customize overlay for these sections', () => {
    // openCustomize('skills' | 'connectors' | 'commands') would silently
    // resurrect the overlay path this task removed them from.
    for (const entry of ENTRIES) {
      const navItem = navItemSource(entry.name);
      expect(navItem).not.toContain('openCustomize');
    }
  });
});
