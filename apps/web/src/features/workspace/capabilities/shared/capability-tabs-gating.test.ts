// Where the Customize surface asks for permission, and what it does with the
// answer.
//
// The tab bar is static: it paints every tab on the first frame. It used to
// filter on the probe, and a pending probe reads `allowed: false`, so the bar
// painted empty and the tabs flew in when `/effective` answered. Access is now
// decided in the content area (`CapabilityAccessGate`), and only on a denial
// the engine returned. Each tab's body follows its own read leaf, with no
// surface-wide leaf: a plain member (project.agent.read, project.trigger.read)
// opens Agents, Triggers and Files and gets a no-access body under every other tab.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { PROJECT_PAGE_ACTIONS, type CanResult } from '@/lib/use-project-can';

import { capabilityTabDenied, receivedDenial } from './capability-access-gate';
import { CAPABILITY_TABS } from './capability-tab-routes';

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const verdict = (allowed: boolean): CanResult => ({
  allowed,
  reason: null,
  isLoading: false,
  isError: false,
});
const inFlight: CanResult = { allowed: false, reason: null, isLoading: true, isError: false };
const failed: CanResult = { allowed: false, reason: null, isLoading: false, isError: true };

/** Probe map for a caller allowed everything except the listed actions. */
const allowExcept = (...denied: string[]) =>
  Object.fromEntries(PROJECT_PAGE_ACTIONS.map((a) => [a, verdict(!denied.includes(a))]));
const every = (result: CanResult) =>
  Object.fromEntries(PROJECT_PAGE_ACTIONS.map((a) => [a, result]));

const deniedKeys = (caps: Record<string, CanResult>) =>
  CAPABILITY_TABS.filter((tab) => capabilityTabDenied(caps, tab.key)).map((t) => t.key);

describe('capabilityTabDenied', () => {
  test('a manager is denied no tab', () => {
    expect(deniedKeys(allowExcept())).toEqual([]);
  });

  test('a project member is denied exactly the tabs whose read leaf it lacks', () => {
    const member = allowExcept(
      PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
      PROJECT_ACTIONS.PROJECT_SKILL_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_MODEL_READ,
      PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE,
    );
    expect(CAPABILITY_TABS.map((t) => t.key).filter((k) => !deniedKeys(member).includes(k)).sort()).toEqual([
      'agent',
      'files',
      'triggers',
    ]);
  });

  test('a custom role denied one leaf is denied exactly that tab', () => {
    expect(deniedKeys(allowExcept(PROJECT_ACTIONS.PROJECT_SECRET_READ))).toEqual(['secrets']);
  });

  // The whole fix. A pending probe reads `allowed: false`; treating that as a
  // denial is what blanked the bar on every cold load.
  test('a probe in flight or a failed probe denies nothing', () => {
    expect(deniedKeys(every(inFlight))).toEqual([]);
    expect(deniedKeys(every(failed))).toEqual([]);
    expect(deniedKeys({})).toEqual([]);
    expect(receivedDenial(undefined)).toBe(false);
    expect(receivedDenial(verdict(false))).toBe(true);
  });
});

describe('Customize permission wiring', () => {
  const bar = code(read('./capability-tabs.tsx'));
  const gate = code(read('./capability-access-gate.tsx'));
  const layout = code(read('../../../../app/[locale]/(app)/projects/[id]/(capabilities)/layout.tsx'));

  test('the bar renders every tab without a permission probe', () => {
    expect(bar).toContain('useLocalizedUiCatalog(CAPABILITY_TABS)');
    expect(bar).not.toContain('useProjectCans(');
    expect(bar).not.toContain('useProjectCan(');
    // The only probe in the bar is the Members launcher's read leaf.
    expect((bar.match(/useProjectPageCans\(/g) ?? []).length).toBe(1);
  });

  test('the layout gates the body, not the bar', () => {
    expect(layout).toContain('<CapabilityTabs projectId={projectId} />');
    expect(layout).toContain(
      '<CapabilityAccessGate projectId={projectId}>{children}</CapabilityAccessGate>',
    );
    expect(gate).toContain('useProjectPageCans(projectId)');
  });

  // One batch for the sidebar, the bar and the gate: the gate reads a verdict
  // the sidebar already cached, so it adds no request and no wait.
  test('the shared page batch covers every leaf the surface reads', () => {
    const batch: readonly string[] = PROJECT_PAGE_ACTIONS;
    expect(batch).toContain(PROJECT_ACTIONS.PROJECT_MEMBERS_READ);
    for (const tab of CAPABILITY_TABS) {
      const pref = TAB_PREFERENCE.find((t) => t.key === tab.key);
      expect(pref, tab.key).toBeDefined();
      expect(batch).toContain(pref!.action);
    }
  });

  // The hub renders the project panel read-only for anyone who can read the
  // member list (`components/iam/access-projects-tab.tsx`). Gating on manage
  // would hide a page a plain member can open.
  test('the Members launcher gates on members.READ, not members.manage', () => {
    const start = bar.indexOf('function MembersLaunchLink');
    const link = bar.slice(start, bar.indexOf('\n}', start));
    expect(link).toContain('[PROJECT_ACTIONS.PROJECT_MEMBERS_READ]');
    expect(link).toContain('if (receivedDenial(canReadMembers)) return null;');
    expect(link).not.toContain('PROJECT_MEMBERS_MANAGE');
    // Holds its place while the account id resolves, instead of popping in.
    expect(link).toContain('if (!accountId) return <span className={MEMBERS_LINK_CLASS}>');
  });
});
