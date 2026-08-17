import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { consumeMembersTabIntent } from './members-tab-intent';
import { buildStandaloneCapabilityNav } from '@/features/workspace/capabilities/shared/standalone-settings-nav';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';

/**
 * `MembersTabInner` (`members-tab.tsx`) consumes the Cmd+K "Invite members"
 * deep link (`handleInviteMembers` in `command-palette.tsx`, which sets
 * `membersTab: 'invite'` on the store and then routes to
 * `/projects/<id>/members`) via a `useEffect`
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
/**
 * Members is its own top-level Customize tab now (`/projects/[id]/members`),
 * so the `SettingsNav` under test is `members-page.tsx`'s adapter. The intent
 * itself still rides on the settings-panel store — see
 * `members-tab-intent.test.ts`'s header for why.
 */
const nav = () =>
  buildStandaloneCapabilityNav({
    projectId: 'p1',
    activeTab: 'members',
    membersTab: useSettingsPanelStore.getState().membersTab,
    navigateTo: () => {},
  });

beforeEach(() => {
  useSettingsPanelStore.setState({ open: false, membersTab: 'people' });
});

describe("MembersTabInner's invite-intent consumption (command-palette.tsx:1146 -> members-tab.tsx)", () => {
  test('a fresh Cmd+K "Invite members" intent is consumed on mount — the dialog should open', () => {
    // Step 1: Cmd+K "Invite members" sets the intent, then routes.
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    expect(useSettingsPanelStore.getState().membersTab).toBe('invite');

    // Step 2: MembersTab mounts (the page mounts only the active section).
    // Its effect calls exactly this function with the nav it was just handed.
    const current = nav();
    const consumed = consumeMembersTabIntent({
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    });

    // A non-null return is what `MembersTabInner` maps 1:1 to
    // `setInviteOpen(true)` — see this file's header comment.
    expect(consumed).toBe('invite');
  });

  test('consuming clears the intent in the same shot — a re-render does not see it again', () => {
    useSettingsPanelStore.setState({ membersTab: 'invite' });
    const current = nav();
    consumeMembersTabIntent({
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    });

    // Cleared on the live store.
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    // A re-render (e.g. a re-run of the same effect, React strict-mode's
    // double invocation, or the user leaving and returning to the tab)
    // reads a FRESH nav off the now-cleared store and must NOT reopen the
    // dialog.
    const navAfter = nav();
    const consumedAgain = consumeMembersTabIntent({
      membersTab: navAfter.membersTab,
      activeTab: navAfter.activeTab,
      navigate: navAfter.navigate,
    });
    expect(consumedAgain).toBeNull();
  });

  test('a plain tab switch to Members with no pending intent does not open the dialog', () => {
    // No Cmd+K invite — just navigating to Members normally.
    expect(useSettingsPanelStore.getState().membersTab).toBe('people');

    const current = nav();
    const consumed = consumeMembersTabIntent({
      membersTab: current.membersTab,
      activeTab: current.activeTab,
      navigate: current.navigate,
    });
    expect(consumed).toBeNull();
  });
});

/**
 * The pane gained three underline tabs (People / Invites / Access) on
 * 2026-08-12. The project Invite button now lives on the People tab, so the
 * deep link has to do two things, not one: select `people` AND open the
 * dialog. `MembersTabInner` can't render here (no `SettingsNavProvider`, no
 * `QueryClientProvider`, no DOM library — this app has none), so the wiring is
 * pinned at source level, the same mechanism `member-role-safety.test.ts` uses
 * against this exact file.
 *
 * **Comments are stripped first.** This file's own header comment quotes the
 * statement sequence; matching the raw source would let the documentation
 * satisfy the assertion with the code deleted.
 */
const membersTabSource = readFileSync(join(import.meta.dir, 'members-tab.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
const flatMembersTab = membersTabSource.replace(/\s+/g, ' ');

describe('the invite deep link lands on the People tab, not just any tab', () => {
  test('consuming the intent selects the people section AND opens the dialog', () => {
    expect(flatMembersTab).toContain(
      "if (consumed) { setSection('people'); setInviteOpen(true); }",
    );
  });

  test('the section state exists, defaults to people, and is handed to the view', () => {
    expect(flatMembersTab).toContain(
      "const [section, setSection] = useState<MembersSection>('people');",
    );
    expect(flatMembersTab).toContain('section={section} onSectionChange={setSection}');
  });

  test('the invite dialog slot is mounted outside Tabs, so it survives a tab switch', () => {
    // Both dialog slots are rendered after `</Tabs>`; if either moved inside a
    // `TabsContent`, Radix would unmount it the moment the user changed tab.
    const closingTabs = flatMembersTab.indexOf('</Tabs>');
    expect(closingTabs).toBeGreaterThan(-1);
    expect(flatMembersTab.indexOf('{inviteDialogSlot}')).toBeGreaterThan(closingTabs);
    expect(flatMembersTab.indexOf('{accountInviteDialogSlot}')).toBeGreaterThan(closingTabs);
  });
});
