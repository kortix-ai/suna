import { beforeEach, describe, expect, test } from 'bun:test';

import { consumeMembersTabIntent } from '@/features/workspace/customize/sections/view/members-view';
import { buildSettingsPanelSettingsNav } from '@/features/workspace/settings/settings-panel';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/**
 * `MembersTabInner` (`members-tab.tsx`) consumes the Cmd+K "Invite members"
 * deep link (`command-palette.tsx:1146`,
 * `openSettings('members', { membersTab: 'invite' })`) via a `useEffect`
 * that calls `consumeMembersTabIntent` and, on a non-null result, sets
 * `inviteOpen` to open `InviteMemberDialog`. That producer never stopped
 * firing when `MembersView` (the previous consumer) was unmounted by this
 * task's rewire — the intent was set and silently dropped. This is the
 * regression test for that: the fix is real, and this pins it.
 *
 * `MembersTabInner` itself can't render under `renderToStaticMarkup` (it
 * needs `SettingsNavProvider` + `QueryClientProvider`, same hard DOM
 * constraint every other tab in this file documents), so this test exercises
 * `consumeMembersTabIntent` — the exact pure function the effect calls,
 * imported from `members-view.tsx` where it's already defined and tested
 * (`members-view.test.ts`'s "reviewer-found sequence", the original JAY-530
 * fix) — against the REAL `useSettingsPanelStore`, reproducing the actual
 * Cmd+K → Members-tab-mount → re-render sequence. `MembersTabInner`'s
 * `if (consumed) setInviteOpen(true)` is a one-line, unconditional pass-through
 * of this return value, so pinning `consumeMembersTabIntent`'s consume-and-
 * clear behavior for THIS call shape closes the loop on the wiring's
 * correctness without needing a DOM to prove the `setInviteOpen` call itself
 * fired — same caveat `members-view.test.ts` already carried for its own
 * `if (consumed) setTab(consumed)` line, never separately DOM-tested either.
 */
beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, tab: 'secrets', membersTab: 'people' });
});

describe("MembersTabInner's invite-intent consumption (command-palette.tsx:1146 -> members-tab.tsx)", () => {
  test('a fresh Cmd+K "Invite members" intent is consumed on mount — the dialog should open', () => {
    // Step 1: Cmd+K "Invite members" -> openSettings('members', { membersTab: 'invite' }).
    useSettingsPanelStore.getState().openSettings('members', { membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');

    // Step 2: MembersTab mounts (SettingsTabPane's `if (!active) return null;`
    // has already passed — this is the active tab). Its effect calls exactly
    // this function with the nav it was just handed.
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    const consumed = consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });

    // A non-null return is what `MembersTabInner` maps 1:1 to
    // `setInviteOpen(true)` — see this file's header comment.
    expect(consumed).toBe('invite');
  });

  test('consuming clears the intent in the same shot — a re-render does not see it again', () => {
    useSettingsPanelStore.getState().openSettings('members', { membersTab: 'invite' });
    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });

    // Cleared on the live store.
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // A re-render (e.g. a re-run of the same effect, React strict-mode's
    // double invocation, or the user leaving and returning to the tab)
    // reads a FRESH nav off the now-cleared store and must NOT reopen the
    // dialog.
    const navAfter = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    const consumedAgain = consumeMembersTabIntent({
      membersTab: navAfter.membersTab,
      activeTab: navAfter.activeTab,
      navigate: navAfter.navigate,
    });
    expect(consumedAgain).toBeNull();
  });

  test('a plain tab switch to Members with no pending intent does not open the dialog', () => {
    // No Cmd+K invite — just navigating to Members normally.
    useSettingsPanelStore.getState().openSettings('members');
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    const nav = buildSettingsPanelSettingsNav(useSettingsPanelStore.getState());
    const consumed = consumeMembersTabIntent({
      membersTab: nav.membersTab,
      activeTab: nav.activeTab,
      navigate: nav.navigate,
    });
    expect(consumed).toBeNull();
  });
});
