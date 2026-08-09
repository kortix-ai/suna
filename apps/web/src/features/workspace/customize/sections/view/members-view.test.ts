import { beforeEach, describe, expect, test } from 'bun:test';

import { useCustomizeStore } from '@/stores/customize-store';
import { buildCustomizeSettingsNav } from '@/features/workspace/customize/customize-panel';
import { consumeMembersTabIntent } from './members-view';

/**
 * Regression pin for a real review finding on this task: `membersTab` is a
 * one-shot deep-link intent, not persistent state. A first draft cleared it
 * only as a side effect of `openCustomize`, which `navigate()` deliberately
 * doesn't replicate (see `consumeMembersTabIntent`'s doc comment in
 * `members-view.tsx`) — so a stale `'invite'` request could survive an
 * unrelated `navigate()` call and replay on a later, unconnected visit to
 * Members. This test reproduces the reviewer's exact reachable sequence
 * against the real `useCustomizeStore` + the real `buildCustomizeSettingsNav`
 * adapter, standing in for `MembersView`'s own mount-time effect via
 * `consumeMembersTabIntent` (the same function the component calls).
 */
beforeEach(() => {
  useCustomizeStore.setState({
    open: false,
    section: 'secrets',
    llmProvidersTab: 'catalog',
    membersTab: 'people',
  });
});

describe('consumeMembersTabIntent — the reviewer-found sequence', () => {
  test('a stale "invite" request does not survive an unrelated navigate() and replay on a later Members mount', () => {
    // Step 1: command palette "Invite members" -> openCustomize('members', { membersTab: 'invite' })
    useCustomizeStore.getState().openCustomize('members', { membersTab: 'invite' });
    expect(useCustomizeStore.getState().membersTab).toBe('invite');

    // MembersView mounts for the first time here. Its effect calls exactly
    // this function with the nav it was just handed.
    let nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    const firstMountResult = consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });
    expect(firstMountResult).toBe('invite'); // MembersView shows Invite right now
    expect(useCustomizeStore.getState().membersTab).toBe('people'); // ...and the intent is already cleared

    // Step 2: rail click to Secrets. Rail buttons call setSection directly —
    // untouched by this task, and irrelevant to membersTab either way.
    useCustomizeStore.getState().setSection('secrets');
    expect(useCustomizeStore.getState().membersTab).toBe('people');

    // Step 3: Secrets' "Manage providers" -> navigate('llm-providers'), the
    // new shared-nav call. Confirms it does not touch membersTab (nothing
    // left to touch — already cleared in step 1's mount).
    nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    nav.navigate('llm-providers');
    expect(useCustomizeStore.getState().section).toBe('llm-providers');
    expect(useCustomizeStore.getState().membersTab).toBe('people');

    // Step 4: back to Members. SectionContent unmounts/remounts MembersView.
    useCustomizeStore.getState().setSection('members');
    nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
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
    useCustomizeStore.getState().openCustomize('members', { membersTab: 'invite' });
    const nav = buildCustomizeSettingsNav(useCustomizeStore.getState());
    // React strict-mode's double effect invocation reuses the SAME render's
    // closure for both calls — the store update from the first call hasn't
    // flowed back through a new render yet, so both calls see the identical
    // stale snapshot, not a fresh one.
    const snapshot = { membersTab: nav.membersTab, activeTab: nav.activeTab, navigate: nav.navigate };

    expect(consumeMembersTabIntent(snapshot)).toBe('invite');
    expect(consumeMembersTabIntent(snapshot)).toBe('invite');

    expect(useCustomizeStore.getState().membersTab).toBe('people');
  });
});
