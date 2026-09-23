/**
 * SettingsNavPage — the project Settings page (`page:settings`; web parity:
 * customize/sections/settings-view). One entry point: the Account page's
 * project row (`app/projects/[id]/account.tsx`, COR-120 Task 2), which pushes
 * it as a sub-page (`openSubPage('page:settings')`, the `page` route) over
 * Settings (the drawer's own gear button, its other entry point, was removed
 * — COR-124/COR-157 Task 4). As a sub-page its `PageHeader` shows Go back
 * (`onBack`) in place of the hamburger, and back returns to Settings. The
 * Customize rows push Schedules and Secrets the same way (`onOpenPage`), so
 * back from them returns here. `PageHeader title` is the project's name, not
 * the tab label "Settings" (Jay, 2026-09-23), with the tab label as a
 * loading fallback.
 *
 * Groups (Jay, 2026-09-23 — titled, unlike the rest of this page's earlier
 * shape: `SettingsGroup`/`SettingsRow`, tap a row to edit, never an inline
 * form on the page):
 *   • Customize — Schedules and Secrets (`PROJECT_CUSTOMIZE_ITEMS`,
 *     `lib/session/dock-menu.ts`; each opens its page as a sub-page), then two
 *     web-handoff rows opened in the in-app browser
 *     (`lib/projects/web-project-links.ts`): Members and "More on
 *     kortix.com" (the project's full Customize hub). This group replaces
 *     the project sheet (`CustomizeSheet`), deleted in the same change
 *     (COR-123/COR-160 Task 3): Agents, Skills, Members and Terminal have no
 *     mobile page any more; Review moves into the drawer (Task 4).
 *   • Details — Name (was "Project name"), Repository (open on GitHub, edit
 *     the default branch + manifest path), and (managed repos) invite a
 *     GitHub collaborator.
 *   • Delete project (managers only, alone, untitled) — a two-step confirm:
 *     type the exact project name to enable Continue, then a native "are you
 *     sure" (Jay, 2026-09-22, GitHub's repo-delete shape). The SDK call is
 *     `archiveProject` (there is no hard delete); "Delete project" is the
 *     live label web itself shows over that same call (verified 2026-09-21,
 *     `suna-project-delete-redirect` memory).
 *
 * Every sheet here renders through `KortixBottomSheetModal` directly (Jay,
 * 2026-09-22: not the `<Sheet>` convenience wrapper) — the same shape as the
 * Schedules/Secrets detail sheets.
 */

import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as WebBrowser from 'expo-web-browser';
import { BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';

import {
  GitBranchIcon as GitBranch,
  TrashIcon as Trash2,
  UserPlusIcon as UserPlus,
  GithubLogoIcon as Github,
  CheckIcon as Check,
  UsersIcon as Users,
  GlobeIcon as Globe,
} from '@/lib/icons';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageHeader } from '@/components/kortix/page-header';
import { useToast } from '@/components/kortix/toast-provider';
import { PageContent } from '@/components/kortix/page-content';
import { PageList } from '@/components/kortix/page-list';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { useProject, useUpdateProject, useArchiveProject } from '@/lib/projects/hooks';
import { inviteRepoCollaborator, isManagedGithubProject } from '@/lib/projects/projects-client';
import type { KortixProject } from '@/lib/projects/projects-client';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { projectCustomizeWebUrl, projectMembersWebUrl } from '@/lib/projects/web-project-links';
import { PROJECT_CUSTOMIZE_ITEMS } from '@/lib/session/dock-menu';
import type { SubPageId } from '@/lib/session/project-stack';
import { DOCK_ICONS } from '@/components/session/dock-icons';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';

interface PageTabLike {
  id: string;
  label: string;
}

interface SettingsNavPageProps {
  page: PageTabLike;
  projectId: string;
  /** Pushed as a sub-page: Go back in the header, in place of the hamburger. */
  onBack?: () => void;
  /** Open a Customize row's page (Schedules, Secrets) as a sub-page over this one. */
  onOpenPage: (pageId: SubPageId) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return null;
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}

// ─── Edit-field sheet ───────────────────────────────────────────────────────

/** One row's edit config, opened imperatively so the page needs only one sheet instance. */
interface EditFieldConfig {
  title: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  maxLength?: number;
  onSave: (value: string) => Promise<void>;
}

export interface EditFieldSheetRef {
  open: (config: EditFieldConfig) => void;
}

/**
 * A single-field rename sheet, reused for the project name, the default
 * branch, and the manifest path — the row's tap opens it, never an inline
 * input on the page (Jay, 2026-09-22).
 */
const EditFieldSheet = React.forwardRef<EditFieldSheetRef, unknown>(function EditFieldSheet(_props, ref) {
  const modalRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const [config, setConfig] = useState<EditFieldConfig | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  React.useImperativeHandle(ref, () => ({
    open: (next) => {
      setConfig(next);
      setDraft(next.value);
      modalRef.current?.present();
    },
  }));

  const trimmed = draft.trim();
  const canSave = !!config && !saving && trimmed.length > 0 && trimmed !== config.value.trim();

  const save = async () => {
    if (!config || !canSave) return;
    haptics.tap();
    setSaving(true);
    try {
      await config.onSave(trimmed);
      haptics.success();
      modalRef.current?.dismiss();
    } catch (e: any) {
      haptics.warning();
      toast.error(`Unable to update the ${config.title.toLowerCase()}`, { description: e?.message || 'Try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <KortixBottomSheetModal ref={modalRef} title={config?.title} keyboardBehavior="interactive" keyboardBlurBehavior="restore">
      <BottomSheetView>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 16 }}>
          <SheetTextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={config?.placeholder}
            mono={config?.mono}
            maxLength={config?.maxLength}
            autoCapitalize={config?.mono ? 'none' : 'sentences'}
            autoCorrect={!config?.mono}
            spellCheck={!config?.mono}
            editable={!saving}
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel={config?.title}
          />
          <Button size="lg" className="rounded-full" disabled={!canSave} onPress={save}>
            <Text>{saving ? 'Saving…' : 'Save'}</Text>
          </Button>
        </View>
      </BottomSheetView>
    </KortixBottomSheetModal>
  );
});

// ─── Repository: add collaborator sheet ─────────────────────────────────────

function AddCollaboratorSheet({ projectId, modalRef }: { projectId: string; modalRef: React.RefObject<BottomSheetModal | null> }) {
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');
  const toast = useToast();

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      haptics.success();
      setUsername('');
      modalRef.current?.dismiss();
      toast.success(res.alreadyCollaborator ? 'Already has access' : 'Invite sent', {
        description: res.alreadyCollaborator
          ? `@${res.username} already has access to this repo.`
          : `@${res.username} accepts it on GitHub to get access.`,
      });
    },
    onError: (e: any) => toast.error('Unable to add the collaborator', { description: e?.message || 'Try again.' }),
  });
  const canSubmit = username.trim().length > 0 && !invite.isPending;

  return (
    <KortixBottomSheetModal ref={modalRef} title="Add collaborator" keyboardBehavior="interactive" keyboardBlurBehavior="restore">
      <BottomSheetView>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 16 }}>
          <Text variant="muted">
            Kortix owns this repo. Add a GitHub user as a collaborator so they can clone, browse, and work on it
            directly on github.com.
          </Text>
          <SheetTextInput
            value={username}
            onChangeText={setUsername}
            placeholder="GitHub username"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
          />
          <View className="flex-row gap-2">
            {(['write', 'read'] as const).map((p) => {
              const active = permission === p;
              return (
                <PressableSurface
                  key={p}
                  onPress={() => {
                    haptics.selection();
                    setPermission(p);
                  }}
                  className="flex-1 flex-row items-center justify-center gap-1.5 rounded-full py-2"
                  style={() => ({
                    backgroundColor: active ? theme.primaryLight : withAlpha(fg, 0.05),
                  })}>
                  {active ? <Check size={13} color={theme.primary} /> : null}
                  <Text
                    variant="small"
                    style={{ color: active ? theme.primary : undefined }}
                    className={active ? undefined : 'text-muted-foreground'}>
                    {p === 'write' ? 'Can edit' : 'Can view'}
                  </Text>
                </PressableSurface>
              );
            })}
          </View>
          <Button size="lg" className="rounded-full" disabled={!canSubmit} onPress={() => invite.mutate()}>
            {invite.isPending ? null : <UserPlus size={14} color={theme.primaryForeground} />}
            <Text>{invite.isPending ? 'Sending…' : 'Add'}</Text>
          </Button>
        </View>
      </BottomSheetView>
    </KortixBottomSheetModal>
  );
}

// ─── Danger zone: two-step delete ───────────────────────────────────────────

/**
 * Step 1 — type the exact project name to enable Continue (GitHub's
 * repo-delete shape, Jay, 2026-09-22). Step 2 is a native "are you sure",
 * fired after this sheet dismisses.
 */
function DeleteProjectSheet({
  project,
  modalRef,
  onConfirmed,
}: {
  project: KortixProject;
  modalRef: React.RefObject<BottomSheetModal | null>;
  onConfirmed: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState('');
  const matches = typed === project.name;

  return (
    <KortixBottomSheetModal ref={modalRef} title="Delete project" onDismiss={() => setTyped('')}>
      <BottomSheetView>
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 16) + 8, gap: 16 }}>
          <Text variant="muted">
            This permanently deletes "{project.name}". Current sessions remain recoverable elsewhere, but the
            project itself cannot be undone. Type the project name to confirm.
          </Text>
          <SheetTextInput
            value={typed}
            onChangeText={setTyped}
            placeholder={project.name}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            accessibilityLabel="Type the project name to confirm"
          />
          <Button
            variant="destructive"
            size="lg"
            className="rounded-full"
            disabled={!matches}
            onPress={() => {
              haptics.tap();
              modalRef.current?.dismiss();
              onConfirmed();
            }}>
            <Text>Continue</Text>
          </Button>
        </View>
      </BottomSheetView>
    </KortixBottomSheetModal>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function SettingsNavPage({
  page,
  projectId,
  onBack,
  onOpenPage,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SettingsNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const toast = useToast();

  const { data: project, isLoading, isError, error, refetch } = useProject(projectId);
  const canManage = project?.effective_project_role === 'manager';
  const bgColor = isDark ? THEME.dark.background : THEME.light.background;

  const update = useUpdateProject(projectId);
  const archive = useArchiveProject();

  const editFieldRef = useRef<EditFieldSheetRef>(null);
  const collaboratorModalRef = useRef<BottomSheetModal>(null);
  const deleteModalRef = useRef<BottomSheetModal>(null);

  const openNameEditor = (current: KortixProject) =>
    editFieldRef.current?.open({
      title: 'Project name',
      value: current.name,
      maxLength: 120,
      onSave: async (name) => {
        await update.mutateAsync({ name });
      },
    });

  const openBranchEditor = (current: KortixProject) =>
    editFieldRef.current?.open({
      title: 'Default branch',
      value: current.default_branch,
      mono: true,
      onSave: async (default_branch) => {
        await update.mutateAsync({ default_branch });
      },
    });

  const openManifestEditor = (current: KortixProject) =>
    editFieldRef.current?.open({
      title: 'Manifest path',
      value: current.manifest_path,
      mono: true,
      onSave: async (manifest_path) => {
        await update.mutateAsync({ manifest_path });
      },
    });

  // Step 2 of the delete flow: the app's AlertDialog (never Alert.alert —
  // Jay, 2026-09-22), opened after the typed-name sheet already confirmed.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const handleDeleteConfirmed = () => {
    if (!project) return;
    haptics.medium();
    archive.mutate(project.project_id, {
      onSuccess: () => {
        haptics.success();
        router.replace('/projects');
      },
      onError: (e: any) => toast.error('Unable to delete the project', { description: e?.message || 'Try again.' }),
    });
  };

  const githubUrl = githubRepoWebUrl(project?.repo_url);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || project?.repo_url || null;
  const managed = project ? isManagedGithubProject(project) : false;

  const openMembersOnWeb = () => {
    haptics.tap();
    WebBrowser.openBrowserAsync(projectMembersWebUrl(KORTIX_WEB_URL, projectId)).catch((error) => {
      log.error('Error opening project members:', error);
    });
  };

  const openCustomizeOnWeb = () => {
    haptics.tap();
    WebBrowser.openBrowserAsync(projectCustomizeWebUrl(KORTIX_WEB_URL, projectId)).catch((error) => {
      log.error('Error opening project customize page:', error);
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={project?.name || page.label}
        onBack={onBack}
        onOpenDrawer={onBack ? undefined : onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
        <PageList
          isLoading={isLoading}
          errorMessage={isError ? ((error as Error)?.message ?? 'Unable to load project') : null}
          onRetry={() => void refetch()}>
          {project ? (
            <View className="gap-6 px-4 pt-1">
              <SettingsGroup title="Customize">
                {PROJECT_CUSTOMIZE_ITEMS.map((item) => (
                  <SettingsRow
                    key={item.pageId}
                    icon={DOCK_ICONS[item.icon]}
                    label={item.label}
                    onPress={() => {
                      haptics.tap();
                      onOpenPage(item.pageId);
                    }}
                  />
                ))}
                <SettingsRow icon={Users} label="Members" external onPress={openMembersOnWeb} />
                <SettingsRow icon={Globe} label="More on kortix.com" external onPress={openCustomizeOnWeb} />
              </SettingsGroup>

              <SettingsGroup title="Details">
                <SettingsRow
                  label="Name"
                  value={project.name}
                  onPress={canManage ? () => openNameEditor(project) : undefined}
                />
                <SettingsRow
                  icon={githubUrl ? Github : GitBranch}
                  label="Repository"
                  value={repoLabel ?? '—'}
                  external={!!githubUrl}
                  onPress={githubUrl ? () => { haptics.tap(); void openLink(githubUrl).catch(() => {}); } : undefined}
                />
                <SettingsRow
                  label="Default branch"
                  value={project.default_branch}
                  onPress={canManage ? () => openBranchEditor(project) : undefined}
                />
                <SettingsRow
                  label="Manifest path"
                  value={project.manifest_path || '—'}
                  onPress={canManage ? () => openManifestEditor(project) : undefined}
                />
                {managed && canManage ? (
                  <SettingsRow
                    icon={UserPlus}
                    label="Add collaborator"
                    onPress={() => { haptics.tap(); collaboratorModalRef.current?.present(); }}
                  />
                ) : null}
              </SettingsGroup>

              {canManage ? (
                <SettingsGroup>
                  <SettingsRow
                    icon={Trash2}
                    label="Delete project"
                    destructive
                    onPress={() => { haptics.tap(); deleteModalRef.current?.present(); }}
                  />
                </SettingsGroup>
              ) : null}
            </View>
          ) : null}
        </PageList>
      </PageContent>

      <EditFieldSheet ref={editFieldRef} />
      <AddCollaboratorSheet projectId={projectId} modalRef={collaboratorModalRef} />
      {project ? (
        <DeleteProjectSheet
          project={project}
          modalRef={deleteModalRef}
          onConfirmed={() => setConfirmDeleteOpen(true)}
        />
      ) : null}

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes "{project?.name}" permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Text>Cancel</Text>
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive active:bg-destructive/90 dark:bg-destructive/60 text-white"
              onPress={handleDeleteConfirmed}>
              <Text>Delete</Text>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
