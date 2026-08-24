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
 * The label does not follow the destination here, so these tests exist mostly
 * to stop someone "fixing" it back on intuition: Customize row -> the
 * capability ROUTE (the bar's first tab), not the Settings overlay — that
 * overlay's own dedicated row is gone (see the describe block below).
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
    // The href is the Customize INDEX now, not `capabilityTabHref(projectId,
    // tab)` — the row lands on a card grid over every tab, not straight into
    // whichever one the caller happens to be able to read first.
    expect(navItem).toContain('`/projects/${projectId}/customize`');
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

  test('reads every capability leaf, not one', () => {
    // Gating the whole entry on connector read alone would strand a caller who
    // may open Skills but not Connectors. Commands is gated in the overlay, not
    // here — its standalone page was removed. Schedules and Webhooks are two
    // views of one resource, so they share `project.trigger.read`.
    expect(SOURCE).toContain('PROJECT_AGENT_READ');
    expect(SOURCE).toContain('PROJECT_CONNECTOR_READ');
    expect(SOURCE).toContain('PROJECT_SKILL_READ');
    expect(SOURCE).toContain('PROJECT_TRIGGER_READ');
    expect(fnSource('ProjectCustomizeNavItem')).toContain('useCapabilityTab(projectId)');
  });

  test('reads every tab from the shared project-page batch', () => {
    // The probes used to be written out one `useProjectCan` per tab — seven
    // hooks, and on the wire seven `GET …/effective?action=…` plus seven CORS
    // preflights on every project page open, for one sidebar row (measured,
    // essentia 2026-08-24). They now go through `useCans`, which sends the
    // list to `effective:batch` and answers all of them from one response.
    // The list is derived from TAB_PREFERENCE itself, so a tab added there is
    // probed by construction — the old "forgot the probe line" failure mode
    // is gone with the lines.
    // (Not fnSource(): useCapabilityTab is module-private, not exported.)
    const hookStart = SOURCE.indexOf('function useCapabilityTab');
    expect(hookStart).toBeGreaterThan(-1);

    const preference = SOURCE.slice(SOURCE.indexOf('const TAB_PREFERENCE'), hookStart);
    const tabCount = (preference.match(/key: '/g) ?? []).length;
    expect(tabCount).toBe(CAPABILITY_TABS.length);

    const hook = SOURCE.slice(hookStart, SOURCE.indexOf('\n}', hookStart));
    expect((hook.match(/useProjectPageCans\(/g) ?? []).length).toBe(1);
    expect(hook).toContain('useProjectPageCans(projectId)');
    // And no single probes crept back in.
    expect((hook.match(/useProjectCan\(/g) ?? []).length).toBe(0);
  });

  test('stays visible while a probe is loading', () => {
    // Optimistic until an explicit deny — same rule as ProjectFilesNavItem.
    expect(SOURCE).toContain('probe.allowed || probe.isLoading');
  });

  test('is gated on project.customize.read, on top of the per-tab read leaves', () => {
    // Was project.customize.write — an audited live bug: .write conflated
    // "may see the surface" with "may change things on it", so a role that
    // could browse a tab was denied the only discovery path to it. .write
    // still gates every individual mutation on every page beneath this row.
    //
    // PROJECT_CUSTOMIZE_READ lives in MANAGER_EXTRAS, not
    // PROJECT_MEMBER_BASELINE (moved by #6522), so a plain project `member`
    // gets no row here at all — every page under it 403s for them. The same
    // leaf gates the project-home setup tiles and the capability tab bar.
    // Optimistic like every other probe here: hide only on an explicit
    // `false`, never while loading.
    const navItem = fnSource('ProjectCustomizeNavItem');

    expect(navItem).toContain('useProjectPageCans(projectId)');
    expect(navItem).toContain('caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]');
    expect(navItem).toContain('if (canCustomize.allowed === false) return null;');
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

describe('the old Settings overlay sidebar entry is gone', () => {
  // It opened the exact same User Settings overlay a click on the workspace
  // switcher already opens, one level up (Jay, 2026-08-17) — a second row to
  // an identical destination. The overlay itself, and its Mod+, shortcut
  // (`useSettingsKeyboardShortcut`, pinned below), are unchanged.
  test('ProjectSettingsNavItem no longer exists', () => {
    expect(SOURCE).not.toContain('export function ProjectSettingsNavItem');
    expect(SOURCE).not.toContain('<Kbd>');
  });
});

describe('the Mod+, shortcut', () => {
  test('still opens the overlay, with no row left to print the keycap on', () => {
    const hook = fnSource('useSettingsKeyboardShortcut');

    expect(hook).toContain("event.key === ','");
    expect(hook).toContain('openSettings()');
    expect(hook).not.toContain('capabilityTabHref');
    expect(hook).not.toContain('router.push');
  });
});
