/**
 * `SettingsNav.membersTab` is a one-shot deep-link INTENT ("land on
 * Invite"), not persistent state. The legacy Customize store used to clear
 * it as a side effect of the NEXT `openCustomize` call for ANY section — so
 * a stale 'invite' request only ever cleared itself once something else
 * happened to touch the store again. `navigate()` (the shared nav's
 * replacement for `openCustomize`) deliberately does NOT replicate that
 * reset: doing it uniformly there would reintroduce, for Connectors' "Open
 * Computers" and `marketplace-section-button.tsx`, exactly the wide-reset
 * regression `navigate` was built to avoid. So the Members pane owns
 * clearing the intent it consumes — the moment it's shown, not on some later
 * unrelated navigation.
 *
 * Without this, a reachable sequence regresses silently: palette "Invite
 * members" sets `membersTab: 'invite'` -> user rail-clicks to Secrets
 * (`setTab`, untouched) -> clicks "Manage providers" (`navigate('models')`,
 * which — correctly — does not touch `membersTab`) -> clicks back to
 * Members. `SettingsTabPane` unmounts and remounts the Members pane on that
 * round trip, which seeds its tab from `membersTab` at mount — a stale
 * `'invite'` would replay instead of landing on People. See
 * `members-tab-intent.test.ts` for that exact sequence pinned against the
 * real store.
 *
 * Returns the tab this mount/update should show if it just consumed a
 * pending request (and, as a side effect, clears it on `nav`), or `null` if
 * there was nothing pending — the caller should leave local state alone in
 * that case. Deliberately narrow (no ref, no "already consumed" flag): only
 * an actual `'invite'` value ever writes anything, so calling this twice
 * with the same stale snapshot (React strict-mode's double effect
 * invocation) is idempotent — see the test file for that case too.
 *
 * Lived in `customize/sections/view/members-view.tsx` until that file's
 * `MembersView` component was deleted as dead code (the settings panel's
 * `tabs/members-tab.tsx` replaced its only mount). The function itself was
 * always live — it moved here, beside its only caller, rather than keeping a
 * 1359-line dead file alive for one 7-line export.
 */
export function consumeMembersTabIntent(nav: {
  membersTab?: string;
  activeTab: string;
  navigate: (tab: string, opts?: { membersTab?: string }) => void;
}): 'invite' | null {
  if (nav.membersTab !== 'invite') return null;
  nav.navigate(nav.activeTab, { membersTab: 'people' });
  return 'invite';
}
