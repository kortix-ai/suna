/**
 * ProjectSwitcherSheet — the one project/account switcher (COR-124): a
 * `KortixBottomSheetModal titled "Projects"`, an account chip row (always
 * shown, ending in "New account" — a one-account user can still start a
 * second one), an optional "Search projects" field, and the picked
 * account's projects as a `SettingsGroup`. Opened from the project drawer's
 * switcher row (`ProjectLeftDrawer` → `onOpenSwitcher`; the sheet itself is
 * mounted once by `ProjectScreen`, next to the other project sheets) and
 * from the Projects tab's account control (`app/(tabs)/projects.tsx`) — one
 * sheet, two call sites.
 *
 * Both call sites mount it closed. `open` drives it through `sheetOpenMove`
 * (`lib/ui/sheet-open.ts`): a closed sheet that was never presented is never
 * dismissed — gorhom's modal refuses to render after a dismiss that came
 * before its first present (the device bug: the sheet never appeared).
 *
 * Picking a chip only swaps the list in place, and fires `onAccountSelect`
 * when the caller passed one (the Projects tab, so its own list follows) —
 * no navigation, no write to `useCurrentAccountStore` here. Picking a project
 * commits it — sets the current
 * account, closes this sheet, and opens the project the same way the
 * Projects tab does (`router.replace`, the last-project store follows from
 * `ProjectScreen` as it always has).
 *
 * `+` and the empty state's "Create project" open `NewProjectSheet` preset to
 * the picked account; the chip row's last "New account" chip opens the
 * existing `NewAccountSheet`. Both are a real second `BottomSheetModal`, so
 * this sheet dismisses itself first (`go`, the `AccountSwitcherSheet`
 * pattern) — a `dismiss()` inside `go` must not fire `onClose` (the caller
 * would think the whole switcher closed), so `handleDismiss` swallows one
 * dismiss per `go` call via `suppressCloseRef`. New account returns to this
 * sheet, on the fresh account's (empty) project list; New project finishes
 * the flow like a project row tap.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';

import { FolderIcon, PlusIcon, UserIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { KortixBottomSheetModal, useSheetBackground } from '@/components/kortix/sheet';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { FloatingTabCapsule, type FloatingTabItem } from '@/components/navigation/FloatingTabBar';
import { FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { NewAccountSheet } from '@/components/accounts/NewAccountSheet';
import { NewProjectSheet } from '@/components/projects/NewProjectSheet';
import { haptics } from '@/lib/haptics';
import { useProjects } from '@/lib/projects/hooks';
import { filterProjectsByQuery, projectHref, shouldShowProjectSearch } from '@/lib/projects/switcher';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { sheetOpenMove } from '@/lib/ui/sheet-open';
import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

/** The bottom tabs: the app's own tab bar items and icons, Account left, Projects right (Jay, 2026-09-23). */
const SWITCHER_TABS: FloatingTabItem[] = [
  { key: 'account', label: 'Account', icon: <Icon as={UserIcon} size={20} className="text-foreground" /> },
  { key: 'projects', label: 'Projects', icon: <Icon as={FolderIcon} size={20} className="text-foreground" /> },
];

export interface ProjectSwitcherSheetProps {
  open: boolean;
  /** Every account of the user, server order — the chip row's order. */
  accounts: KortixAccount[];
  /** The account whose projects the sheet opens on. */
  selectedAccountId: string | null;
  /** The project shown with a check mark — the project already on screen, if any. */
  currentProjectId?: string | null;
  onClose: () => void;
  /**
   * Fires once, right before an existing or freshly created project opens —
   * so a caller with its own chrome (the project drawer) can close it too.
   * The Projects tab, which has none, omits it.
   */
  onProjectOpen?: () => void;
  /**
   * Fires when an account chip is tapped, with that account's id. The
   * Projects tab passes `setSelectedAccountId` so its list switches with the
   * chip; the drawer omits it — there a chip only swaps this sheet's project
   * list, and the account is written when a project is picked.
   */
  onAccountSelect?: (accountId: string) => void;
}

export function ProjectSwitcherSheet({
  open,
  accounts,
  selectedAccountId,
  currentProjectId = null,
  onClose,
  onProjectOpen,
  onAccountSelect,
}: ProjectSwitcherSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const sheetBackground = useSheetBackground();
  const listBottomInset = usePinnedBarInset(FLOATING_BAR_HEIGHT);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);

  // Null until the sheet actually opens (below), so `useProjects` stays
  // disabled while it is unmounted-in-spirit — both call sites render this
  // component unconditionally (`open` toggles visibility, not mount), so
  // seeding this from `selectedAccountId` at every mount fetched the
  // project list on every drawer mount, sheet closed or not.
  const [chipAccountId, setChipAccountId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // The header's tab list: Account (pick whose projects) or Projects (pick one).
  const [tab, setTab] = useState<'account' | 'projects'>('projects');
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  // `go()` dismisses this sheet to open a real second BottomSheetModal
  // (New account / New project). That dismiss must not read as the user
  // closing the whole switcher — `handleDismiss` swallows the next one.
  const suppressCloseRef = useRef(false);
  // True while this sheet is on screen: set on present, cleared by gorhom's
  // onDismiss. See `sheetOpenMove`.
  const presentedRef = useRef(false);
  const present = useCallback(() => {
    presentedRef.current = true;
    sheetRef.current?.present();
  }, []);
  // Set when a child sheet (New account / New project) finishes by creating
  // something. That child's own onDismiss still fires afterwards, and it must
  // not read as a cancel. Cleared each time `go` opens a child.
  const childFinishedRef = useRef(false);
  const go = useCallback((fn: () => void) => {
    suppressCloseRef.current = true;
    childFinishedRef.current = false;
    sheetRef.current?.dismiss();
    setTimeout(fn, 160);
  }, []);
  const handleDismiss = useCallback(() => {
    presentedRef.current = false;
    if (suppressCloseRef.current) {
      suppressCloseRef.current = false;
      return;
    }
    onClose();
  }, [onClose]);

  const selectedAccountIdRef = useRef(selectedAccountId);
  selectedAccountIdRef.current = selectedAccountId;

  useEffect(() => {
    const move = sheetOpenMove(open, presentedRef.current);
    if (move !== 'present') {
      if (move === 'dismiss') sheetRef.current?.dismiss();
      // Drop back to disabled: closing the sheet must stop the project
      // query too, not just hide the sheet.
      setChipAccountId(null);
      return;
    }
    setChipAccountId(selectedAccountIdRef.current);
    setQuery('');
    setTab('projects');
    const frame = requestAnimationFrame(present);
    return () => cancelAnimationFrame(frame);
  }, [open, present]);

  // `selectedAccountId` can still be loading when the sheet opens (the above
  // effect then seeds `chipAccountId` with null). Once it arrives, adopt it —
  // otherwise the sheet is stuck showing the loader for an account that never
  // gets picked.
  useEffect(() => {
    if (open && chipAccountId === null && selectedAccountId != null) {
      setChipAccountId(selectedAccountId);
    }
  }, [open, chipAccountId, selectedAccountId]);

  const chipAccount = accounts.find((account) => account.account_id === chipAccountId) ?? null;

  const pickAccount = useCallback(
    (accountId: string) => {
      haptics.selection();
      setChipAccountId(accountId);
      setQuery('');
      onAccountSelect?.(accountId);
      // An account is picked to see its projects: go straight there.
      setTab('projects');
    },
    [onAccountSelect]
  );

  const projectsQuery = useProjects(chipAccountId);
  const projects = projectsQuery.data ?? [];
  const filtered = useMemo(() => filterProjectsByQuery(projects, query), [projects, query]);
  const showSearch = shouldShowProjectSearch(projects.length);

  const openProject = useCallback(
    (project: KortixProject) => {
      haptics.selection();
      // The project already on screen: just close, like tapping the open
      // session's row in the drawer — never re-navigate to where we are.
      if (project.project_id === currentProjectId) {
        onProjectOpen?.();
        sheetRef.current?.dismiss();
        return;
      }
      setSelectedAccountId(project.account_id);
      onProjectOpen?.();
      sheetRef.current?.dismiss();
      router.replace(projectHref(project.project_id));
    },
    [currentProjectId, setSelectedAccountId, onProjectOpen, router]
  );

  const openNewProject = useCallback(() => {
    haptics.tap();
    go(() => setShowNewProject(true));
  }, [go]);

  const openNewAccount = useCallback(() => {
    haptics.tap();
    go(() => setShowNewAccount(true));
  }, [go]);

  // A child sheet was cancelled (X or pan down): `go` swallowed this sheet's
  // dismiss, so the parent's `open` is still true. Present this sheet again,
  // so the user lands back where they were and `open` matches what is on
  // screen. Re-presenting (not calling `onClose`) keeps the two paths the
  // same: a created account also returns here. A finished child (created
  // something) has already moved on, so its late onDismiss does nothing.
  const handleChildClosed = useCallback(() => {
    if (childFinishedRef.current) {
      childFinishedRef.current = false;
      return;
    }
    if (!presentedRef.current) present();
  }, [present]);
  const handleNewAccountClosed = useCallback(() => {
    setShowNewAccount(false);
    handleChildClosed();
  }, [handleChildClosed]);
  const handleNewProjectClosed = useCallback(() => {
    setShowNewProject(false);
    handleChildClosed();
  }, [handleChildClosed]);

  const handleAccountCreated = useCallback((account: KortixAccount) => {
    childFinishedRef.current = true;
    setShowNewAccount(false);
    setChipAccountId(account.account_id);
    haptics.selection();
    setTimeout(present, 160);
  }, [present]);

  const handleProjectCreated = useCallback(
    (project: KortixProject) => {
      childFinishedRef.current = true;
      setShowNewProject(false);
      setSelectedAccountId(project.account_id);
      onProjectOpen?.();
      onClose();
      router.replace(projectHref(project.project_id));
    },
    [setSelectedAccountId, onProjectOpen, onClose, router]
  );

  return (
    <>
      <KortixBottomSheetModal
        ref={sheetRef}
        // The header names the picked account; the tab list lives in the pinned bar.
        title={chipAccount?.name ?? 'Projects'}
        titleTrailing={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onPress={openNewProject}
            accessibilityLabel="New project"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Icon as={PlusIcon} size={20} className="text-foreground" />
          </Button>
        }
        snapPoints={['100%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={handleDismiss}>
        <View style={{ flex: 1 }}>
          {tab === 'projects' && showSearch ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              <SheetTextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search projects"
                accessibilityLabel="Search projects"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>
          ) : null}

          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: listBottomInset }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {tab === 'account' ? (
              <View style={{ gap: 18 }}>
                <SettingsGroup>
                  {accounts.map((account) => (
                    <SettingsRow
                      key={account.account_id}
                      leading={<Avatar chalk size={28} fallbackText={account.name} />}
                      label={account.name}
                      checked={account.account_id === chipAccountId}
                      right={null}
                      onPress={() => pickAccount(account.account_id)}
                    />
                  ))}
                </SettingsGroup>
                <SettingsGroup>
                  <SettingsRow icon={PlusIcon} label="New account" right={null} onPress={openNewAccount} />
                </SettingsGroup>
              </View>
            ) : chipAccountId === null || projectsQuery.isLoading ? (
              // No account picked yet (selectedAccountId still loading) or
              // its projects are in flight — never the empty state here: a
              // user with projects must not flash "No projects yet".
              <View className="items-center py-10">
                <KortixLoader size="small" />
              </View>
            ) : projectsQuery.isError ? (
              <View className="items-center gap-3 py-10">
                <Text variant="muted">Couldn't load projects</Text>
                <Button variant="secondary" size="sm" className="rounded-full" onPress={() => projectsQuery.refetch()}>
                  <Text>Try again</Text>
                </Button>
              </View>
            ) : projects.length === 0 ? (
              <View className="items-center gap-4 py-10">
                <Text variant="muted">No projects yet</Text>
                <Button size="lg" className="rounded-full" onPress={openNewProject}>
                  <Text>Create project</Text>
                </Button>
              </View>
            ) : filtered.length === 0 ? (
              <Text variant="muted" className="py-8 text-center">
                {`No matches for "${query.trim()}"`}
              </Text>
            ) : (
              <SettingsGroup>
                {filtered.map((project) => (
                  <SettingsRow
                    key={project.project_id}
                    leading={<Avatar chalk size={28} fallbackText={project.name} />}
                    label={project.name}
                    checked={project.project_id === currentProjectId}
                    right={null}
                    onPress={() => openProject(project)}
                  />
                ))}
              </SettingsGroup>
            )}
          </BottomSheetScrollView>

          {/* The project drawer's bottom bar: the Account · Projects tab list
              pinned at the bottom, floating over a fade of the sheet. */}
          <PinnedBar controlHeight={FLOATING_BAR_HEIGHT} background={sheetBackground} className="justify-center px-4">
            <FloatingTabCapsule
              items={SWITCHER_TABS}
              activeIndex={tab === 'account' ? 0 : 1}
              onSelect={(index) => {
                const next = index === 0 ? 'account' : 'projects';
                if (next !== tab) haptics.selection();
                setTab(next);
              }}
            />
          </PinnedBar>
        </View>
      </KortixBottomSheetModal>

      <NewAccountSheet open={showNewAccount} onClose={handleNewAccountClosed} onCreated={handleAccountCreated} />

      <NewProjectSheet
        open={showNewProject}
        accountId={chipAccountId}
        accounts={accounts}
        onClose={handleNewProjectClosed}
        onCreated={handleProjectCreated}
      />
    </>
  );
}
