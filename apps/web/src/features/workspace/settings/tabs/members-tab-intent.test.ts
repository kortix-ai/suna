import { beforeEach, describe, expect, test } from 'bun:test';

import { buildSettingsPanelSettingsNav } from '@/features/workspace/settings/settings-panel';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { consumeMembersTabIntent } from './members-tab-intent';

/**
 * Regression pin for a real review finding on this task: `membersTab` is a
 * one-shot deep-link intent, not persistent state. A first draft cleared it
 * only as a side effect of `openSettings`, which `navigate()` deliberately
 * doesn't replicate (see `consumeMembersTabIntent`'s doc comment in
 * `members-tab-intent.ts`) — so a stale `'invite'` request could survive an
 * unrelated `navigate()` call and replay on a later, unconnected visit to
 * Members. This test reproduces the reviewer's exact reachable sequence
 * against the real `useSettingsPanelStore` + the real
 * `buildSettingsPanelSettingsNav` adapter — the Members pane mounts under the
 * Settings overlay (see `settings-panel.tsx`'s `SettingsTabPane`), so this is
 * the live store behind it, standing in for `MembersTabInner`'s own
 * mount-time effect via `consumeMembersTabIntent` (the same function the
 * component calls).
 */
beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, tab: 'secrets', membersTab: 'people' });
});

describe('consumeMembersTabIntent — the reviewer-found sequence', () => {
  test('a stale "invite" request does not survive an unrelated navigate() and replay on a later Members mount', () => {
    // Step 1: command palette "Invite members" -> openSettings('members', { membersTab: 'invite' })
    useSettingsPanelStore.getState().openSettings('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');

    // MembersView mounts for the first time here. Its effect calls exactly
    // this function with the nav it was just handed.
    let nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    const firstMountResult = consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });
    expect(firstMountResult).toBe('invite'); // MembersView shows Invite right now
    expect(useSettingsPanelStore.getState().membersTab).toBe('people'); // ...and the intent is already cleared

    // Step 2: rail click to Secrets. Rail buttons call setTab directly —
    // untouched by this task, and irrelevant to membersTab either way.
    useSettingsPanelStore.getState().setTab('secrets');
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // Step 3: Secrets' "Manage providers" -> navigate('models'), the shared-nav
    // call (the merged panel folds every legacy `llm-*` sub-section into the
    // single `models` tab). Confirms it does not touch membersTab (nothing
    // left to touch — already cleared in step 1's mount).
    nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    nav.navigate('models');
    expect(useSettingsPanelStore.getState().tab).toBe('models');
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // Step 4: back to Members. The tab pane unmounts/remounts MembersView.
    useSettingsPanelStore.getState().setTab('members');
    nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    expect(nav.membersTab).toBe('people'); // NOT a stale 'invite'

    const secondMountResult = consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });
    expect(secondMountResult).toBeNull(); // nothing pending; fresh mount seeds People, correctly
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
    useSettingsPanelStore.getState().openSettings('members', { membersTab: 'invite' });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    // React strict-mode's double effect invocation reuses the SAME render's
    // closure for both calls — the store update from the first call hasn't
    // flowed back through a new render yet, so both calls see the identical
    // stale snapshot, not a fresh one.
    const snapshot = { membersTab: nav.membersTab, activeTab: nav.activeTab, navigate: nav.navigate };

    expect(consumeMembersTabIntent(snapshot)).toBe('invite');
    expect(consumeMembersTabIntent(snapshot)).toBe('invite');

    expect(useSettingsPanelStore.getState().membersTab).toBe('people');
  });
});
