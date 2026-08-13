import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPABILITY_TABS } from '@/features/workspace/capabilities/shared/capability-tab-routes';

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
 * The labels do not follow the destinations here, so these tests exist mostly
 * to stop someone "fixing" the pairing back on intuition:
 *
 *   Customize row -> the capability ROUTE (the bar's first tab)
 *   Settings row  -> the Customize OVERLAY
 */
describe('project Customize sidebar entry (the routed one)', () => {
  test('navigates with a prefetching Link, not router.push', () => {
    // Same tripwire as the Files entry: a button + router.push cannot be
    // prefetched, so every click pays for the RSC payload and the route chunk
    // cold. `prefetch={false}` also contains "prefetch", hence the two asserts.
    const navItem = fnSource('ProjectCustomizeNavItem');

    expect(navItem).toContain('<Link');
    expect(navItem).toMatch(/prefetch(\s|>|$)/);
    expect(navItem).not.toContain('prefetch={false}');
    expect(navItem).toContain('capabilityTabHref(projectId, tab)');
    expect(navItem).toContain('asChild');
    expect(navItem).not.toContain('router.push');
  });

  test('lands on the FIRST tab of the bar it navigates into', () => {
    // The regression this catches actually happened: CAPABILITY_TABS was
    // reordered and TAB_PREFERENCE was not, which left the row landing on the
    // bar's second tab. Derive the expectation instead of hardcoding a name,
    // so reordering the bar keeps this honest without editing the test.
    const preference = SOURCE.slice(
      SOURCE.indexOf('const TAB_PREFERENCE'),
      SOURCE.indexOf('function useCapabilityTab'),
    );
    const orderInNav = [...preference.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);

    expect(orderInNav).toEqual(CAPABILITY_TABS.map((t) => t.key));
  });

  test('the Agents key stays singular — it is the route segment', () => {
    // `key: 'agents'` builds /projects/<id>/agents, which does not exist.
    expect(SOURCE).toMatch(/TAB_PREFERENCE[\s\S]*?key: 'agent'/);
    expect(SOURCE).not.toMatch(/TAB_PREFERENCE[\s\S]*?key: 'agents'/);
  });

  test('reads all three capability leaves, not one', () => {
    // Gating the whole entry on connector read alone would strand a caller who
    // may open Skills but not Connectors. Commands is gated in the overlay, not
    // here — its standalone page was removed.
    expect(SOURCE).toContain('PROJECT_AGENT_READ');
    expect(SOURCE).toContain('PROJECT_CONNECTOR_READ');
    expect(SOURCE).toContain('PROJECT_SKILL_READ');
    expect(fnSource('ProjectCustomizeNavItem')).toContain('useCapabilityTab(projectId)');
  });

  test('probes every tab in TAB_PREFERENCE', () => {
    // useProjectCan is a hook, so it cannot be called from a loop that
    // short-circuits — the probes are written out one per tab. A tab added to
    // TAB_PREFERENCE without its own probe line reads as permanently denied,
    // and the row silently stops offering it.
    // (Not fnSource(): useCapabilityTab is module-private, not exported.)
    const hookStart = SOURCE.indexOf('function useCapabilityTab');
    expect(hookStart).toBeGreaterThan(-1);

    // The literal runs from the declaration to the hook that consumes it. Do
    // NOT cut on the first `];` — the type annotation itself ends
    // `CapabilityTab['key'];`, which lands inside the annotation and matched
    // zero entries.
    const preference = SOURCE.slice(SOURCE.indexOf('const TAB_PREFERENCE'), hookStart);
    const tabCount = (preference.match(/key: '/g) ?? []).length;

    const hook = SOURCE.slice(hookStart, SOURCE.indexOf('\n}', hookStart));
    const probeCount = (hook.match(/useProjectCan\(/g) ?? []).length;

    expect(tabCount).toBe(3);
    expect(probeCount).toBe(tabCount);
  });

  test('stays visible while a probe is loading', () => {
    // Optimistic until an explicit deny — same rule as ProjectFilesNavItem.
    expect(SOURCE).toContain('p.allowed || p.isLoading');
  });

  test('closes the mobile drawer on navigate', () => {
    expect(fnSource('ProjectCustomizeNavItem')).toContain('setOpenMobile(false)');
  });

  test('does not open the overlay', () => {
    // The two rows are different surfaces. If this one starts calling
    // openSettings() the capability pages lose their only sidebar entry.
    expect(fnSource('ProjectCustomizeNavItem')).not.toContain('openSettings');
  });

  test('carries no keycap', () => {
    // Mod+, is printed on the Settings row, and one shortcut advertised on two
    // rows is a lie on at least one of them.
    expect(fnSource('ProjectCustomizeNavItem')).not.toContain('<Kbd>');
  });
});

describe('project Settings sidebar entry (the overlay one)', () => {
  test('opens the Settings overlay, it does not navigate', () => {
    // The overlay floats over the current page on purpose (settings-panel-store):
    // routing there instead would drop you out of whatever session you were in.
    const navItem = fnSource('ProjectSettingsNavItem');

    expect(navItem).toContain('openSettings()');
    expect(navItem).not.toContain('<Link');
    expect(navItem).not.toContain('capabilityTabHref');
    expect(navItem).not.toContain('router.push');
  });

  test('is ungated and takes its active state from the overlay flag', () => {
    // useCapabilityTab reads connector/skill.read — the leaves the capability
    // ROUTE needs. The overlay also holds Agents, LLM providers, Members, and
    // Commands (whose standalone page was removed), so gating it on those two
    // would hide it from a caller who can still use most of what is inside. And
    // an overlay has no pathname, so active state has to come from the store.
    const navItem = fnSource('ProjectSettingsNavItem');

    expect(navItem).not.toContain('useCapabilityTab');
    expect(navItem).not.toContain('useProjectCan');
    expect(navItem).not.toContain('usePathname');
    expect(navItem).toContain('useSettingsPanelStore((s) => s.open)');
  });

  test('closes the mobile drawer on open', () => {
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
});

describe('the Mod+, shortcut', () => {
  test('goes where the row it is printed on goes — the overlay', () => {
    const hook = fnSource('useSettingsKeyboardShortcut');

    expect(hook).toContain("event.key === ','");
    expect(hook).toContain('openSettings()');
    expect(hook).not.toContain('capabilityTabHref');
    expect(hook).not.toContain('router.push');
  });
});
