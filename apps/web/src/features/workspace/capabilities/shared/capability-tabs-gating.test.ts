// What a project MEMBER may see of the Customize surface.
//
// `project.customize.read` moved out of the member floor role in #6522
// (`apps/api/src/iam/role-perms.ts`): a plain project member is a read + RUN
// role and reaches no part of Customize. The sidebar's Customize row already
// disappeared for them on that change alone, but the tab bar did not — direct
// navigation still rendered seven tabs, five of which 403 on load. These tests
// pin the gate that fixed it, and the exact leaf each tab costs.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { PROJECT_ACTIONS } from '@/lib/project-actions';

import { CAPABILITY_TABS } from './capability-tab-routes';
import { CAPABILITY_TAB_GATE_ACTIONS, visibleCapabilityTabs } from './capability-tabs';

const source = readFileSync(
  fileURLToPath(new URL('./capability-tabs.tsx', import.meta.url)),
  'utf8',
);
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Probe map for a caller allowed everything except the listed actions. */
const allowExcept = (...denied: string[]) =>
  Object.fromEntries(
    CAPABILITY_TAB_GATE_ACTIONS.map((action) => [action, { allowed: !denied.includes(action) }]),
  );

/** Probe map with every action still in flight (react-query disabled/pending). */
const stillLoading = () =>
  Object.fromEntries(CAPABILITY_TAB_GATE_ACTIONS.map((action) => [action, { allowed: false }]));

/**
 * Flag map with every flag-gated tab's flag ON. Derived from `CAPABILITY_TABS`
 * rather than hard-coded, so adding a gated tab does not silently start
 * asserting that a manager cannot see it.
 */
const flagsOn = () =>
  Object.fromEntries(CAPABILITY_TABS.flatMap((tab) => (tab.flag ? [[tab.flag, true]] : [])));

/** Every tab that declares a flag. Empty is a legal state, so guard for it. */
const GATED_TABS = CAPABILITY_TABS.filter((tab) => tab.flag);

describe('visibleCapabilityTabs', () => {
  test('a manager sees every tab', () => {
    expect(visibleCapabilityTabs(allowExcept(), flagsOn()).map((t) => t.key)).toEqual(
      CAPABILITY_TABS.map((t) => t.key),
    );
  });

  // The whole point. A member holds project.read, project.trigger.read and
  // project.agent.read, so a per-tab-only filter would still leave Models,
  // Agents and Triggers on the bar — a Customize surface for someone who
  // cannot open Customize.
  test('a project member (no project.customize.read) sees NO tabs at all', () => {
    const member = allowExcept(
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    expect(visibleCapabilityTabs(member, flagsOn())).toEqual([]);
  });

  test('holding every per-tab leaf does not survive a customize.read denial', () => {
    expect(
      visibleCapabilityTabs(allowExcept(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ), flagsOn()),
    ).toEqual([]);
  });

  // A custom role can hold the surface and still have one capability switched
  // off — that is what the per-leaf pass exists for.
  test('a custom role denied one leaf loses exactly that tab', () => {
    const keys = visibleCapabilityTabs(
      allowExcept(PROJECT_ACTIONS.PROJECT_SECRET_READ),
      flagsOn(),
    ).map((t) => t.key);
    expect(keys).not.toContain('secrets');
    expect(keys).toContain('connectors');
    expect(keys).toContain('models');
  });

  // `useProjectCans` reports a pending/disabled probe as `allowed:false,
  // isLoading:true`, and this helper only ever sees `allowed`. It is called
  // with the raw probe map, so a bar that hid on `allowed === false` would
  // blank itself on every navigation. It hides on the RECEIVED denial only —
  // which is why the source pin below requires `caps[…]?.allowed === false`
  // rather than `!caps[…]?.allowed`.
  test('an in-flight probe is a denial for this helper — the caller keeps it optimistic', () => {
    expect(visibleCapabilityTabs(stillLoading(), flagsOn())).toEqual([]);
    expect(code(source)).toContain(
      'caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]?.allowed === false',
    );
    expect(code(source)).toContain('caps[pref.action]?.allowed !== false');
  });
});

// The IAM leaf answers "may this member see it". The flag answers "does this
// project have the surface at all". Marketplace has both: `project.read` and
// the `subprojects` flag, whose routes answer 403 `feature_disabled` when off
// (`apps/api/src/feature-flags/registry.ts` — `enforcement: 'routes'`,
// `platformDefault: () => false`). A tab that renders while the flag is off is
// a tab that 403s on click.
describe('flag-gated tabs', () => {
  test('at least one tab is flag-gated, and Marketplace is one of them', () => {
    expect(GATED_TABS.map((t) => `${t.key}:${t.flag}`)).toContain('marketplace:subprojects');
  });

  test('a manager with the flag OFF does not see the gated tab', () => {
    const keys = visibleCapabilityTabs(
      allowExcept(),
      Object.fromEntries(GATED_TABS.map((tab) => [tab.flag, false])),
    ).map((t) => t.key);
    for (const tab of GATED_TABS) expect(keys).not.toContain(tab.key);
    // Every ungated tab is untouched — the flag hides one tab, not the bar.
    expect(keys).toEqual(CAPABILITY_TABS.filter((t) => !t.flag).map((t) => t.key));
  });

  // FAIL-CLOSED, unlike the IAM probes above. `useFeatureFlag` reports an
  // unresolved flag as `enabled: false`, and a missing key reads `undefined`;
  // both must hide, or the tab flashes in and then vanishes on every load of
  // a project that does not have the surface.
  test('an unresolved flag hides the gated tab, same as an off one', () => {
    const keys = visibleCapabilityTabs(allowExcept(), {}).map((t) => t.key);
    for (const tab of GATED_TABS) expect(keys).not.toContain(tab.key);
  });

  test('the flag hooks are ENUMERATED, never looped over CAPABILITY_TABS', () => {
    const body = code(source);
    const start = body.indexOf('export function useCapabilityTabFlags');
    expect(start).toBeGreaterThan(-1);
    const hook = body.slice(start, body.indexOf('\n}', start));
    // One literal `useFeatureFlag(projectId, '<key>')` per gated tab. A `.map`
    // or `for` here would make the hook count depend on the array's length.
    expect((hook.match(/useFeatureFlag\(/g) ?? []).length).toBe(GATED_TABS.length);
    for (const tab of GATED_TABS) {
      expect(hook).toContain(`useFeatureFlag(projectId, '${tab.flag}')`);
    }
    expect(hook).not.toContain('CAPABILITY_TABS');
    expect(hook).not.toContain('.map(');
    expect(hook).not.toContain('for (');
  });
});

describe('CapabilityTabs gate wiring', () => {
  test('the bar probes the leaves in ONE batched request, not one hook per tab', () => {
    const body = code(source);
    expect(body).toContain('useProjectCans(projectId, CAPABILITY_TAB_GATE_ACTIONS)');
    // `useProjectCan` (singular) is allowed exactly once — the Members
    // launcher, which is not a tab and carries a different leaf.
    expect((body.match(/useProjectCan\(/g) ?? []).length).toBe(1);
  });

  // Matched by regex with `\s*` before the `.`, not by a literal string:
  // prettier breaks `tabs.filter(…).map(…)` across lines once the chain is
  // long enough, and where it puts the newline is its business. What this test
  // pins is the RECEIVER — `tabs`, the gated list, and not `CAPABILITY_TABS`.
  test('both tab groups render from the gated list, never from CAPABILITY_TABS', () => {
    const body = code(source);
    const barStart = body.indexOf('export function CapabilityTabs');
    const bar = body.slice(barStart);
    expect(bar).toMatch(/tabs\s*\.filter\(\(tab\) => !TRAILING_TABS\.includes\(tab\.key\)\)/);
    expect(bar).toMatch(/tabs\s*\.filter\(\(tab\) => TRAILING_TABS\.includes\(tab\.key\)\)/);
    expect(bar).not.toContain('CAPABILITY_TABS.filter');
  });

  // One list of leaves for the bar, the sidebar row and the Customize index —
  // a tab that costs one action here and another there is a tab that shows up
  // in one place and 403s from the other.
  test('the per-tab leaves come from TAB_PREFERENCE, not a second local map', () => {
    expect(CAPABILITY_TAB_GATE_ACTIONS).toEqual([
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      ...new Set(TAB_PREFERENCE.map((t) => t.action)),
    ]);
    for (const tab of CAPABILITY_TABS) {
      expect(TAB_PREFERENCE.some((t) => t.key === tab.key)).toBe(true);
    }
  });

  // The launcher leaves the project for the account hub, which renders the
  // project access panel read-only for anyone who can read the member list
  // (`components/iam/access-projects-tab.tsx` probes `members.manage` itself
  // for every write control). Gating it on `manage` would hide a page a plain
  // member can legitimately open.
  test('the Members launcher gates on members.READ, not members.manage', () => {
    const body = code(source);
    const start = body.indexOf('function MembersLaunchLink');
    const link = body.slice(start, body.indexOf('\n}', start));
    expect(link).toContain('useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ)');
    expect(link).toContain('if (canReadMembers.allowed === false) return null;');
    expect(link).not.toContain('PROJECT_MEMBERS_MANAGE');
  });

  // Hide, never disable: a tab a person can click and only then be told
  // "forbidden" is worse than no tab.
  test('denied tabs are removed, not disabled', () => {
    const body = code(source);
    expect(body).not.toContain('disabled');
    expect(body).not.toContain('aria-disabled');
    expect(body).not.toContain('pointer-events-none');
  });
});
