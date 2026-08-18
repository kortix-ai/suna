import { beforeEach, describe, expect, test } from 'bun:test';

import { buildStandaloneCapabilityNav } from '@/features/workspace/capabilities/shared/standalone-settings-nav';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { consumeMembersTabIntent } from './members-tab-intent';

/**
 * Regression pin for a real review finding: `membersTab` is a one-shot
 * deep-link intent, not persistent state. A first draft cleared it only as a
 * side effect of `openSettings`, which `navigate()` deliberately doesn't
 * replicate (see `consumeMembersTabIntent`'s doc comment in
 * `members-tab-intent.ts`) — so a stale `'invite'` request could survive an
 * unrelated `navigate()` call and replay on a later, unconnected visit to
 * Members.
 *
 * **The Members pane moved twice.** First onto `/projects/[id]/config`
 * (Members a section there), then a second time onto its own top-level
 * Customize tab, `/projects/[id]/members`. The adapter under test is now
 * `buildStandaloneCapabilityNav` (`capabilities/shared/`) — the same pure
 * builder `members-page.tsx`'s `useStandaloneCapabilityNav` wraps — not the
 * config page's. The intent still rides on `useSettingsPanelStore`, which is
 * why this exercises the REAL store: it is one-shot state the command palette
 * sets before it routes, and a query param would replay it on every reload
 * and every shared link.
 */
const nav = (activeTab: 'members' | 'sandbox', hrefs: string[] = []) =>
  buildStandaloneCapabilityNav({
    projectId: 'p1',
    activeTab,
    membersTab: useSettingsPanelStore.getState().membersTab,
    navigateTo: (href) => hrefs.push(href),
  });

beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, membersTab: 'people' });
});

describe('consumeMembersTabIntent — the reviewer-found sequence', () => {
  test('a stale "invite" request does not survive an unrelated navigate() and replay on a later Members mount', () => {
    const hrefs: string[] = [];

    // Step 1: command palette "Invite members" — it sets the intent, then
    // routes to `/projects/p1/members`, its own top-level Customize tab.
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');

    // The Members page mounts here. Its effect calls exactly this function
    // with the nav it was just handed.
    let current = nav('members', hrefs);
    const firstMountResult = consumeMembersTabIntent({
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    });
    expect(firstMountResult).toBe('invite'); // the pane shows Invite right now
    expect(useSettingsPanelStore.getState().membersTab).toBe('people'); // ...intent already cleared
    // Clearing re-asserts the CURRENT tab, so it must not push a route.
    expect(hrefs).toEqual([]);

    // Step 2: the user navigates away — say, to Sandbox templates on the
    // Settings tab. That does not touch membersTab either way.
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // Step 3: a pane's cross-link -> navigate('llm-providers'), the
    // shared-nav call, from a page that is NOT Members. Models graduated onto
    // its own top-level Customize tab, so this routes THERE
    // (`/projects/p1/models`) — and it must not touch membersTab.
    current = nav('sandbox', hrefs);
    current.navigate('llm-providers');
    expect(hrefs).toEqual(['/projects/p1/models']);
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // Step 4: back to Members. The page unmounts/remounts, seeding its
    // sub-tab from `membersTab` at mount — a stale `'invite'` would replay.
    current = nav('members', hrefs);
    expect(current.membersTab).toBe('people'); // NOT a stale 'invite'

    const secondMountResult = consumeMembersTabIntent({
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    });
    expect(secondMountResult).toBeNull(); // nothing pending; fresh mount seeds People
  });
});

describe('consumeMembersTabIntent — field mapping', () => {
  test('returns null and writes nothing when membersTab is "people" (nothing pending)', () => {
    let navigateCalls = 0;
    const result = consumeMembersTabIntent({
      membersTab: 'people',
      activeTab: 'members',
      navigate: () => {
        navigateCalls += 1;
      },
    });
    expect(result).toBeNull();
    expect(navigateCalls).toBe(0);
  });

  test('returns null and writes nothing when membersTab is undefined (a provider with no notion of it)', () => {
    let navigateCalls = 0;
    const result = consumeMembersTabIntent({
      membersTab: undefined,
      activeTab: 'members',
      navigate: () => {
        navigateCalls += 1;
      },
    });
    expect(result).toBeNull();
    expect(navigateCalls).toBe(0);
  });

  test('consuming "invite" re-asserts the current tab and clears membersTab to "people"', () => {
    const calls: Array<[string, { membersTab?: string } | undefined]> = [];
    const result = consumeMembersTabIntent({
      membersTab: 'invite',
      activeTab: 'members',
      navigate: (tab, opts) => calls.push([tab, opts]),
    });
    expect(result).toBe('invite');
    expect(calls).toEqual([['members', { membersTab: 'people' }]]);
  });
});

describe('consumeMembersTabIntent — strict-mode double invocation', () => {
  test('calling it twice with the same stale "invite" snapshot is idempotent on the real store', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    const current = nav('members');
    // React strict-mode's double effect invocation reuses the SAME render's
    // closure for both calls — the store update from the first call hasn't
    // flowed back through a new render yet, so both calls see the identical
    // stale snapshot, not a fresh one.
    const snapshot = {
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    };

    expect(consumeMembersTabIntent(snapshot)).toBe('invite');
    expect(consumeMembersTabIntent(snapshot)).toBe('invite');

    expect(useSettingsPanelStore.getState().membersTab).toBe('people');
  });
});
