/**
 * ProjectSwitcherSheet — the one workspace switcher (COR-124, Workspaces
 * ux.md §3): a `KortixBottomSheetModal` titled "Workspaces", a search field,
 * the pending invitations first, then ONE flat list of every workspace the
 * user belongs to, the current one checked. No account headings, no account
 * tab, no "New account": a workspace is a project and its account, and a
 * legacy account with several projects shows each as its own row
 * (`workspaceRows`, `lib/projects/switcher.ts`). Then two actions: "Create
 * workspace" and, inside a workspace, "Workspace settings".
 *
 * Opened from the drawer's switcher row (`ProjectLeftDrawer` →
 * `onOpenSwitcher`; the sheet itself is mounted once by `ProjectScreen`,
 * next to the other project sheets) and from the Workspaces page's title
 * control (`app/projects/index.tsx`) — one sheet, two call sites.
 *
 * Both call sites mount it closed. `open` drives it through `sheetOpenMove`
 * (`lib/ui/sheet-open.ts`): a closed sheet that was never presented is never
 * dismissed — gorhom's modal refuses to render after a dismiss that came
 * before its first present (the device bug: the sheet never appeared). The
 * workspace lists load only while it is open (`useWorkspaces(open)`).
 *
 * Picking a workspace commits it — sets the current account, closes this
 * sheet, and opens it: `router.replace` from the Workspaces page, the
 * caller's `openProjectRoute` from inside a workspace (a root-stack replace;
 * see the prop). The last-workspace store follows from `ProjectScreen`.
 *
 * Invitations (KRTX-1731): a row closes the sheet (and the drawer,
 * `onProjectOpen`) and pushes the invite screen (`app/invites/[id].tsx`),
 * where Accept lands in the workspace.
 *
 * Creating happens on the web (KRTX-246). `+` and "Create workspace" open the
 * "Create a workspace on the web" hand-off (`WebHandoffSheet`). This sheet
 * dismisses itself first and `handleDismiss` opens the hand-off once it is
 * gone (never two overlays); that dismiss does not fire `onClose`, so the
 * parent's `open` stays true. Not now (or a swipe) presents this sheet again
 * (`onCancel`). Continue closes the switcher for real (`onClose`), then opens
 * web `/new` in an in-app auth session (`useWebCreateHandoff`); on return a
 * workspace that did not exist before opens like a row tap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GearSixIcon, PlusIcon } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Avatar } from '@/components/kortix/avatar';
import { KortixBottomSheetModal, useSheetOpenMove, type SheetRef } from '@/components/kortix/sheet';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { WorkspaceInvitations } from '@/components/projects/WorkspaceInvitations';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { WebHandoffSheet } from '@/components/session/WebHandoffSheet';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { haptics } from '@/lib/haptics';
import { useLanguage } from '@/contexts';
import { useMyInvites } from '@/lib/invites/hooks';
import { inviteHref } from '@/lib/invites/invite-landing';
import { useWorkspaceStateAction, useWorkspaces } from '@/lib/projects/hooks';
import { filterWorkspaceRows, projectHref, type WorkspaceRow } from '@/lib/projects/switcher';
import { isOpenableWorkspaceRow } from '@/lib/projects/switcher';
import { newWorkspaceWebUrl } from '@/lib/projects/web-project-links';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useCloseThen } from '@/components/kortix/sheet';
import { useSheetRowLimit } from '@/components/kortix/sheet-settled';

interface ProjectSwitcherSheetProps {
  open: boolean;
  /** The workspace shown with a check mark — the one already on screen, if any. */
  currentProjectId?: string | null;
  onClose: () => void;
  /**
   * Fires once, right before an existing or freshly created workspace (or an
   * invite) opens — so a caller with its own chrome (the drawer) can close it
   * too. The Workspaces page, which has none, omits it.
   */
  onProjectOpen?: () => void;
  /**
   * Opens a workspace other than the one on screen. Default:
   * `router.replace(projectHref(id))` — right from the Workspaces page. Inside
   * a workspace, `ProjectScreen` passes a root-stack replace instead:
   * expo-router does not see `projects/[id]` → `projects/[id]` with a new `id`
   * as a new route (its `matchDynamicName` only matches a bare `[id]`
   * segment), so it sends the replace into the project's own stack, the
   * layout keeps the old `id`, and the pick does nothing.
   */
  openProjectRoute?: (projectId: string) => void;
  /**
   * Inside a workspace: opens its settings page. Absent (the Workspaces page),
   * the "Workspace settings" action is not shown.
   */
  onOpenWorkspaceSettings?: () => void;
}

/** The "create on the web" choreography (KRTX-246): a `+` or "Create
 * workspace" tap defers the hand-off past the sheet's dismiss, and Continue
 * creates on the web and opens the workspace that was created. */
function useWebCreateWorkspace({
  deferHandoff,
  dismiss,
  isPresented,
  present,
  onClose,
  setSelectedAccountId,
  onProjectOpen,
  goToProject,
}: {
  deferHandoff: (handoff: 'workspace') => void;
  dismiss: () => void;
  isPresented: () => boolean;
  present: () => void;
  onClose: () => void;
  setSelectedAccountId: (accountId: string) => void;
  onProjectOpen?: () => void;
  goToProject: (projectId: string) => void;
}) {
  // Close this sheet; `handleDismiss` opens the hand-off once it is gone.
  const openHandoff = useCallback(() => {
    haptics.tap();
    deferHandoff('workspace');
    dismiss();
  }, [deferHandoff, dismiss]);
  // Not now / swipe on the hand-off: back to this sheet, as it was.
  const handleHandoffCancel = useCallback(() => {
    if (!isPresented()) present();
  }, [isPresented, present]);
  // Continue: the switcher is done (`onClose`); create on the web, then
  // open what was created. A bare new account is not a workspace: ignored.
  const webCreate = useWebCreateHandoff();
  const runHandoff = useCallback(async () => {
    onClose();
    const { project } = await webCreate.open(newWorkspaceWebUrl(KORTIX_WEB_URL));
    if (project) {
      setSelectedAccountId(project.account_id);
      onProjectOpen?.();
      goToProject(project.project_id);
    }
  }, [onClose, webCreate, setSelectedAccountId, onProjectOpen, goToProject]);
  return { openHandoff, handleHandoffCancel, webCreate, runHandoff };
}

/** The workspace list: in flight, error, empty, filtered-empty, or the group. */
function WorkspaceList({
  workspaces,
  filtered,
  query,
  currentProjectId,
  openWorkspace,
}: {
  workspaces: ReturnType<typeof useWorkspaces>;
  filtered: WorkspaceRow[];
  query: string;
  currentProjectId: string | null;
  openWorkspace: (row: WorkspaceRow) => void;
}) {
  const { t } = useLanguage();
  const stateAction = useWorkspaceStateAction();
  // While the sheet opens only the rows that fill it mount; the rest once it
  // is at rest (KRTX-2929). The sheet is fixed at 100%, so it never resizes.
  const rowLimit = useSheetRowLimit(filtered.length);
  if (workspaces.rows.length === 0 && workspaces.isPending) {
    // In flight, or paused offline (`isPending`, not `isLoading`) — never
    // the empty state here: a user with workspaces must not flash it.
    return (
      <View className="items-center py-10">
        <KortixLoader size="small" />
      </View>
    );
  }
  if (workspaces.rows.length === 0 && workspaces.isError) {
    return (
      <View className="items-center gap-3 py-10">
        <Text variant="muted">{t('workspace.loadFailed', "Couldn't load workspaces")}</Text>
        <Button variant="secondary" size="sm" className="rounded-full" onPress={() => void workspaces.refetch()}>
          <Text>{t('common.retry', 'Try again')}</Text>
        </Button>
      </View>
    );
  }
  if (workspaces.rows.length === 0) {
    return (
      <Text variant="muted" className="py-8 text-center">
        {t('workspace.emptyTitle', 'No workspaces yet')}
      </Text>
    );
  }
  if (filtered.length === 0) {
    return (
      <Text variant="muted" className="py-8 text-center">
        {t('workspace.noMatches', { defaultValue: 'No matches for "{{query}}"', query: query.trim() })}
      </Text>
    );
  }
  return (
    <SettingsGroup>
      {filtered.slice(0, rowLimit).map((row) =>
        isOpenableWorkspaceRow(row) ? (
          <SettingsRow
            key={row.project.project_id}
            leading={<Avatar chalk size={28} fallbackText={row.project.name} />}
            label={row.project.name}
            checked={row.project.project_id === currentProjectId}
            right={null}
            onPress={() => openWorkspace(row)}
          />
        ) : (
          // Set up or Restore first; the workspace opens after.
          <SettingsRow
            key={row.project.project_id}
            leading={<Avatar chalk size={28} fallbackText={row.project.name} />}
            label={row.project.name}
            value={row.state === 'deleting' ? t('workspace.restore', 'Restore') : t('workspace.setUp', 'Set up')}
            disabled={stateAction.isPending}
            onPress={() =>
              stateAction.mutate(
                {
                  workspaceId: row.project.project_id,
                  state: row.state === 'deleting' ? 'deleting' : 'setup_required',
                },
                { onSuccess: () => openWorkspace(row) },
              )
            }
          />
        ),
      )}
    </SettingsGroup>
  );
}

export function ProjectSwitcherSheet({
  open,
  currentProjectId = null,
  onClose,
  onProjectOpen,
  openProjectRoute,
  onOpenWorkspaceSettings,
}: ProjectSwitcherSheetProps) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const router = useRouter();
  const { t } = useLanguage();
  const listBottomInset = useSafeAreaInsets().bottom + 24;
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const goToProject = useCallback(
    (projectId: string) => {
      if (openProjectRoute) openProjectRoute(projectId);
      else router.replace(projectHref(projectId));
    },
    [openProjectRoute, router]
  );

  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const handoffRef = useRef<SheetRef>(null);
  // The hand-off to open once this sheet has closed (`handleDismiss`): stored
  // before the dismiss, taken once from it (the shared close-then slot).
  const { deferAfterClose: deferHandoff, takeAfterClose: takeHandoff } = useCloseThen<'workspace'>();
  const { isPresented, markDismissed, present } = useSheetOpenMove(sheetRef, open);
  const handleDismiss = useCallback(() => {
    // Closed to show the hand-off: not a close of the switcher (`open` stays
    // true until the hand-off continues or is cancelled).
    if (takeHandoff() === 'workspace') handoffRef.current?.open();
    else onClose();
  }, [takeHandoff, onClose]);

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

  // Every workspace of the user; the queries run only while the sheet is open.
  const workspaces = useWorkspaces(open);
  const filtered = useMemo(() => filterWorkspaceRows(workspaces.rows, query), [workspaces.rows, query]);

  const openWorkspace = useCallback(
    (row: WorkspaceRow) => {
      haptics.selection();
      // The workspace already on screen: just close, like tapping the open
      // session's row in the drawer — never re-navigate to where we are.
      if (row.project.project_id === currentProjectId) {
        onProjectOpen?.();
        sheetRef.current?.dismiss();
        return;
      }
      setSelectedAccountId(row.account.account_id);
      onProjectOpen?.();
      sheetRef.current?.dismiss();
      goToProject(row.project.project_id);
    },
    [currentProjectId, setSelectedAccountId, onProjectOpen, goToProject]
  );

  const openSettings = useCallback(() => {
    haptics.tap();
    onProjectOpen?.();
    sheetRef.current?.dismiss();
    onOpenWorkspaceSettings?.();
  }, [onProjectOpen, onOpenWorkspaceSettings]);

  const create = useWebCreateWorkspace({
    deferHandoff,
    dismiss: () => sheetRef.current?.dismiss(),
    isPresented,
    present,
    onClose,
    setSelectedAccountId,
    onProjectOpen,
    goToProject,
  });
  const createLabel = t('workspace.create', 'Create workspace');

  return (
    <>
      <KortixBottomSheetModal
        ref={sheetRef}
        title={t('workspace.switcherTitle', 'Workspaces')}
        titleTrailing={
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onPress={create.openHandoff}
            disabled={create.webCreate.pending}
            accessibilityLabel={createLabel}
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
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <SheetTextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('workspace.search', 'Search workspaces')}
              accessibilityLabel={t('workspace.search', 'Search workspaces')}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>

          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: listBottomInset, gap: 18 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <WorkspaceInvitations invites={invites} onOpenInvite={openInvite} />
            <WorkspaceList
              workspaces={workspaces}
              filtered={filtered}
              query={query}
              currentProjectId={currentProjectId}
              openWorkspace={openWorkspace}
            />
            <SettingsGroup>
              <SettingsRow
                icon={PlusIcon}
                label={createLabel}
                right={null}
                onPress={create.webCreate.pending ? undefined : create.openHandoff}
              />
              {onOpenWorkspaceSettings && currentProjectId ? (
                <SettingsRow
                  icon={GearSixIcon}
                  label={t('workspace.settings', 'Workspace settings')}
                  onPress={openSettings}
                />
              ) : null}
            </SettingsGroup>
          </BottomSheetScrollView>
        </View>
      </KortixBottomSheetModal>

      <WebHandoffSheet
        ref={handoffRef}
        title={t('workspace.createOnWebTitle', 'Create a workspace on the web')}
        line={t('workspace.createOnWebLine', 'Workspaces are created on kortix.com.')}
        run={create.runHandoff}
        onCancel={create.handleHandoffCancel}
      />
    </>
  );
}
