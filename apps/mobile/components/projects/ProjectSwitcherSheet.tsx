/**
 * ProjectSwitcherSheet — the one project/account switcher (COR-124): a
 * `KortixBottomSheetModal titled "Projects"`, an account chip row (always
 * shown, ending in "New account" — a one-account user can still start a
 * second one), an optional "Search projects" field, and the picked
 * account's projects as a `SettingsGroup`. Opened from the project drawer's
 * switcher row (`ProjectLeftDrawer` → `onOpenSwitcher`; the sheet itself is
 * mounted once by `ProjectScreen`, next to the other project sheets) and
 * from the Projects page's account control (`app/projects/index.tsx`) — one
 * sheet, two call sites.
 *
 * Both call sites mount it closed. `open` drives it through `sheetOpenMove`
 * (`lib/ui/sheet-open.ts`): a closed sheet that was never presented is never
 * dismissed — gorhom's modal refuses to render after a dismiss that came
 * before its first present (the device bug: the sheet never appeared).
 *
 * Picking a chip only swaps the list in place, and fires `onAccountSelect`
 * when the caller passed one (the Projects page, so its own list follows) —
 * no navigation, no write to `useCurrentAccountStore` here. Picking a project
 * commits it — sets the current
 * account, closes this sheet, and opens the project: `router.replace` from
 * the Projects page, the caller's `openProjectRoute` from inside a project
 * (a root-stack replace; see the prop). The last-project store follows from
 * `ProjectScreen` as it always has.
 *
 * Invites (KRTX-1731): the caller's pending invites show first, in an
 * "Invites" group on both tabs, fetched only while the sheet is open. A row
 * closes the sheet (and the drawer, `onProjectOpen`) and pushes the invite
 * screen (`app/invites/[id].tsx`), where Accept lands in the invited project.
 *
 * Creating happens on the web (KRTX-246). `+` and the empty state's
 * "Create project" open the "Create a project on the web" hand-off
 * (`WebHandoffSheet`), the Account tab's "New account" row the "Create an
 * account on the web" one. This sheet dismisses itself first and
 * `handleDismiss` opens the hand-off once it is gone (never two overlays);
 * that dismiss does not fire `onClose`, so the parent's `open` stays true.
 * Not now (or a swipe) presents this sheet again (`onCancel`). Continue
 * closes the switcher for real (`onClose`), then opens web
 * `/new?account=<picked account>` or the web account list in an in-app auth
 * session (`useWebCreateHandoff`); on return a project that did not exist
 * before opens like a project row tap, and a new account with no project is
 * handed to `onAccountSelect`.
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
import { KortixBottomSheetModal, useSheetBackground, useSheetOpenMove, type SheetRef } from '@/components/kortix/sheet';
import { PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { FloatingTabCapsule, type FloatingTabItem } from '@/components/navigation/FloatingTabBar';
import { FLOATING_BAR_HEIGHT } from '@/components/navigation/tab-bar-layout';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { WebHandoffSheet } from '@/components/session/WebHandoffSheet';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { haptics } from '@/lib/haptics';
import { useLanguage } from '@/contexts';
import { useMyInvites } from '@/lib/invites/hooks';
import { inviteHref } from '@/lib/invites/invite-landing';
import { useProjects } from '@/lib/projects/hooks';
import { filterProjectsByQuery, projectHref, shouldShowProjectSearch } from '@/lib/projects/switcher';
import { newAccountWebUrl, newProjectWebUrl } from '@/lib/projects/web-project-links';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useCloseThen } from '@/components/kortix/sheet';
import type { KortixAccount, KortixProject } from '@/lib/projects/projects-client';

type Handoff = 'project' | 'account';

/** The bottom tabs: the old root tab bar's items and icons, Account left, Projects right (Jay, 2026-09-23). */
const SWITCHER_TABS: FloatingTabItem[] = [
  { key: 'account', label: 'Account', icon: <Icon as={UserIcon} size={20} className="text-foreground" /> },
  { key: 'projects', label: 'Projects', icon: <Icon as={FolderIcon} size={20} className="text-foreground" /> },
];

interface ProjectSwitcherSheetProps {
  open: boolean;
  /** Every account of the user, server order — the chip row's order. */
  accounts: KortixAccount[];
  /** The account whose projects the sheet opens on. */
  selectedAccountId: string | null;
  /** The project shown with a check mark — the project already on screen, if any. */
  currentProjectId?: string | null;
  onClose: () => void;
  /**
   * Fires once, right before an existing or freshly created project (or an
   * invite) opens — so a caller with its own chrome (the project drawer) can
   * close it too. The Projects page, which has none, omits it.
   */
  onProjectOpen?: () => void;
  /**
   * Fires when an account chip is tapped, with that account's id. The
   * Projects page passes `setSelectedAccountId` so its list switches with the
   * chip; the drawer omits it — there a chip only swaps this sheet's project
   * list, and the account is written when a project is picked.
   */
  onAccountSelect?: (accountId: string) => void;
  /**
   * Opens a project other than the one on screen. Default:
   * `router.replace(projectHref(id))` — right from the Projects page. Inside a
   * project, `ProjectScreen` passes a root-stack replace instead: expo-router
   * does not see `projects/[id]` → `projects/[id]` with a new `id` as a new
   * route (its `matchDynamicName` only matches a bare `[id]` segment), so it
   * sends the replace into the project's own stack, the layout keeps the old
   * `id`, and the pick does nothing.
   */
  openProjectRoute?: (projectId: string) => void;
}



/** The "create on the web" choreography (KRTX-246): a `+`/empty-state/New
 * account tap defers the hand-off past the sheet's dismiss, and Continue
 * creates on the web and follows what was created — a project opens like a
 * project row tap, a bare new account fires `onAccountSelect`. */
function useWebCreateHandoffs({
  chipAccountId,
  deferHandoff,
  dismiss,
  isPresented,
  present,
  onClose,
  setSelectedAccountId,
  onProjectOpen,
  goToProject,
  onAccountSelect,
}: {
  chipAccountId: string | null;
  deferHandoff: (handoff: Handoff) => void;
  dismiss: () => void;
  isPresented: () => boolean;
  present: () => void;
  onClose: () => void;
  setSelectedAccountId: (accountId: string) => void;
  onProjectOpen?: () => void;
  goToProject: (projectId: string) => void;
  onAccountSelect?: (accountId: string) => void;
}) {
  // The account web `/new` preselects: the chip the user was on, captured at
  // the tap — closing this sheet resets `chipAccountId` to null.
  const handoffAccountIdRef = useRef<string | null>(null);
  // Close this sheet; `handleDismiss` opens the hand-off once it is gone.
  const openHandoff = useCallback(
    (handoff: Handoff) => {
      haptics.tap();
      handoffAccountIdRef.current = chipAccountId;
      deferHandoff(handoff);
      dismiss();
    },
    [chipAccountId, deferHandoff, dismiss]
  );
  // Not now / swipe on a hand-off: back to this sheet, as it was.
  const handleHandoffCancel = useCallback(() => {
    if (!isPresented()) present();
  }, [isPresented, present]);
  // Continue: the switcher is done (`onClose`); create on the web, then
  // follow what was created.
  const webCreate = useWebCreateHandoff();
  const runWebCreate = useCallback(
    async (url: string) => {
      onClose();
      const { project, account } = await webCreate.open(url);
      if (project) {
        setSelectedAccountId(project.account_id);
        onProjectOpen?.();
        goToProject(project.project_id);
      } else if (account) {
        onAccountSelect?.(account.account_id);
      }
    },
    [onClose, webCreate, setSelectedAccountId, onProjectOpen, goToProject, onAccountSelect]
  );
  const runNewProjectHandoff = useCallback(
    () => runWebCreate(newProjectWebUrl(KORTIX_WEB_URL, handoffAccountIdRef.current)),
    [runWebCreate]
  );
  const runNewAccountHandoff = useCallback(() => runWebCreate(newAccountWebUrl(KORTIX_WEB_URL)), [runWebCreate]);
  return {
    openNewProject: useCallback(() => openHandoff('project'), [openHandoff]),
    openNewAccount: useCallback(() => openHandoff('account'), [openHandoff]),
    handleHandoffCancel,
    webCreate,
    runNewProjectHandoff,
    runNewAccountHandoff,
  };
}

/** The caller's pending invites, first on both tabs (KRTX-1731). */
function SwitcherInvites({
  invites,
  openInvite,
}: {
  invites: NonNullable<Awaited<ReturnType<typeof useMyInvites>>['data']>;
  openInvite: (inviteId: string) => void;
}) {
  const { t } = useLanguage();
  if (invites.length === 0) return null;
  return (
    <View style={{ marginBottom: 18 }}>
      <SettingsGroup title={t('invites.group', 'Invites')}>
        {invites.map((invite) => {
          const name = invite.projects[0]?.name || invite.account_name || t('invites.fallbackTitle', 'Invite');
          return (
            <SettingsRow
              key={invite.invite_id}
              leading={<Avatar chalk size={28} fallbackText={name} />}
              label={name}
              onPress={() => openInvite(invite.invite_id)}
            />
          );
        })}
      </SettingsGroup>
    </View>
  );
}

/** The Account tab: every account as a chip-pick row, then "New account". */
function AccountTab({
  accounts,
  chipAccountId,
  pickAccount,
  onNewAccount,
  newAccountPending,
}: {
  accounts: KortixAccount[];
  chipAccountId: string | null;
  pickAccount: (accountId: string) => void;
  onNewAccount: () => void;
  newAccountPending: boolean;
}) {
  return (
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
        <SettingsRow
          icon={PlusIcon}
          label="New account"
          right={null}
          onPress={newAccountPending ? undefined : onNewAccount}
        />
      </SettingsGroup>
    </View>
  );
}

/** The Projects tab's body: the picked account's projects — in flight, error,
 * empty, filtered-empty, or the group. */
function ProjectsTab({
  projectsQuery,
  projects,
  filtered,
  query,
  currentProjectId,
  openProject,
  openNewProject,
  newProjectPending,
}: {
  projectsQuery: ReturnType<typeof useProjects>;
  projects: KortixProject[];
  filtered: KortixProject[];
  query: string;
  currentProjectId: string | null;
  openProject: (project: KortixProject) => void;
  openNewProject: () => void;
  newProjectPending: boolean;
}) {
  if (projectsQuery.isPending) {
    // No account picked yet (selectedAccountId still loading) or
    // its projects have not loaded — in flight, or paused offline
    // (`isPending`, not `isLoading`) — never the empty state here:
    // a user with projects must not flash "No projects yet".
    return (
      <View className="items-center py-10">
        <KortixLoader size="small" />
      </View>
    );
  }
  if (projectsQuery.isError) {
    return (
      <View className="items-center gap-3 py-10">
        <Text variant="muted">Couldn't load projects</Text>
        <Button variant="secondary" size="sm" className="rounded-full" onPress={() => projectsQuery.refetch()}>
          <Text>Try again</Text>
        </Button>
      </View>
    );
  }
  if (projects.length === 0) {
    return (
      <View className="items-center gap-4 py-10">
        <Text variant="muted">No projects yet</Text>
        <Button size="lg" className="rounded-full" disabled={newProjectPending} onPress={openNewProject}>
          <Text>Create project</Text>
        </Button>
      </View>
    );
  }
  if (filtered.length === 0) {
    return (
      <Text variant="muted" className="py-8 text-center">
        {`No matches for "${query.trim()}"`}
      </Text>
    );
  }
  return (
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
  );
}

export function ProjectSwitcherSheet({
  open,
  accounts,
  selectedAccountId,
  currentProjectId = null,
  onClose,
  onProjectOpen,
  onAccountSelect,
  openProjectRoute,
}: ProjectSwitcherSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const sheetBackground = useSheetBackground();
  const listBottomInset = usePinnedBarInset(FLOATING_BAR_HEIGHT);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const goToProject = useCallback(
    (projectId: string) => {
      if (openProjectRoute) openProjectRoute(projectId);
      else router.replace(projectHref(projectId));
    },
    [openProjectRoute, router]
  );

  // Null until the sheet actually opens (below), so `useProjects` stays
  // disabled while it is unmounted-in-spirit — both call sites render this
  // component unconditionally (`open` toggles visibility, not mount), so
  // seeding this from `selectedAccountId` at every mount fetched the
  // project list on every drawer mount, sheet closed or not.
  const [chipAccountId, setChipAccountId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // The header's tab list: Account (pick whose projects) or Projects (pick one).
  const [tab, setTab] = useState<'account' | 'projects'>('projects');

  const newProjectHandoffRef = useRef<SheetRef>(null);
  const newAccountHandoffRef = useRef<SheetRef>(null);
  // The hand-off to open once this sheet has closed (`handleDismiss`): stored
  // before the dismiss, taken once from it (the shared close-then slot).
  const { deferAfterClose: deferHandoff, takeAfterClose: takeHandoff } = useCloseThen<Handoff>();
  const { isPresented, markDismissed, present } = useSheetOpenMove(sheetRef, open);
  const handleDismiss = useCallback(() => {
    const handoff = takeHandoff();
    // Closed to show a hand-off: not a close of the switcher (`open` stays
    // true until the hand-off continues or is cancelled).
    if (handoff === 'project') newProjectHandoffRef.current?.open();
    else if (handoff === 'account') newAccountHandoffRef.current?.open();
    else onClose();
  }, [takeHandoff, onClose]);

  const selectedAccountIdRef = useRef(selectedAccountId);
  selectedAccountIdRef.current = selectedAccountId;

  useEffect(() => {
    if (!open) {
      // Drop back to disabled: closing the sheet must stop the project
      // query too, not just hide the sheet.
      setChipAccountId(null);
      return;
    }
    setChipAccountId(selectedAccountIdRef.current);
    setQuery('');
    setTab('projects');
  }, [open]);

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

  const { t } = useLanguage();
  const invites = useMyInvites(open).data ?? [];
  const openInvite = useCallback(
    (inviteId: string) => {
      haptics.selection();
      onProjectOpen?.();
      sheetRef.current?.dismiss();
      router.push(inviteHref(inviteId));
    },
    [onProjectOpen, router]
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
      goToProject(project.project_id);
    },
    [currentProjectId, setSelectedAccountId, onProjectOpen, goToProject]
  );

  const handoffs = useWebCreateHandoffs({
    chipAccountId,
    deferHandoff,
    dismiss: () => sheetRef.current?.dismiss(),
    isPresented,
    present,
    onClose,
    setSelectedAccountId,
    onProjectOpen,
    goToProject,
    onAccountSelect,
  });

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
            onPress={handoffs.openNewProject}
            disabled={handoffs.webCreate.pending}
            accessibilityLabel="New project"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Icon as={PlusIcon} size={20} className="text-foreground" />
          </Button>
        }
        snapPoints={['100%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={() => {
          markDismissed();
          handleDismiss();
        }}>
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
            <SwitcherInvites invites={invites} openInvite={openInvite} />
            {tab === 'account' ? (
              <AccountTab
                accounts={accounts}
                chipAccountId={chipAccountId}
                pickAccount={pickAccount}
                onNewAccount={handoffs.openNewAccount}
                newAccountPending={handoffs.webCreate.pending}
              />
            ) : (
              <ProjectsTab
                projectsQuery={projectsQuery}
                projects={projects}
                filtered={filtered}
                query={query}
                currentProjectId={currentProjectId}
                openProject={openProject}
                openNewProject={handoffs.openNewProject}
                newProjectPending={handoffs.webCreate.pending}
              />
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

      <WebHandoffSheet
        ref={newProjectHandoffRef}
        title="Create a project on the web"
        line="Projects are created on kortix.com."
        run={handoffs.runNewProjectHandoff}
        onCancel={handoffs.handleHandoffCancel}
      />
      <WebHandoffSheet
        ref={newAccountHandoffRef}
        title="Create an account on the web"
        line="Accounts are created on kortix.com."
        run={handoffs.runNewAccountHandoff}
        onCancel={handoffs.handleHandoffCancel}
      />
    </>
  );
}
