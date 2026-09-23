/**
 * SettingsNavPage — project settings (web parity: customize/sections/
 * settings-view). Opened from the drawer's gear button, top right of the
 * Kortix logo (Jay, 2026-09-22) — the only entry point; there is no
 * `PageHeader onBack`, same law as every other Customize-sheet page.
 *
 * Groups (Jay, 2026-09-22: `SettingsGroup`/`SettingsRow`, no group titles —
 * just the rounded card of rows; tap a row to edit, never an inline form on
 * the page):
 *   • General — the project name.
 *   • Repository — the git repo backing the project: open on GitHub, edit the
 *     default branch + manifest path, and (managed repos) invite a GitHub
 *     collaborator.
 *   • Danger zone (managers only) — delete the project, a two-step confirm:
 *     type the exact project name to enable Continue, then a native "are you
 *     sure" (Jay, 2026-09-22, GitHub's repo-delete shape). The SDK call is
 *     `archiveProject` (there is no hard delete); "Delete project" is the
 *     live label web itself shows over that same call (verified 2026-09-21,
 *     `suna-project-delete-redirect` memory).
 *
 * Every sheet here renders through `KortixBottomSheetModal` directly (Jay,
 * 2026-09-22: not the `<Sheet>` convenience wrapper) — the same shape as the
 * Schedules/Webhooks/Secrets detail sheets.
 */

import React, { useRef, useState } from 'react';
import { View, Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
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
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
}

interface SettingsNavPageProps {
  page: PageTabLike;
  projectId: string;
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
      Alert.alert('Failed', e?.message || `Failed to update ${config.title.toLowerCase()}.`);
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

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      haptics.success();
      setUsername('');
      modalRef.current?.dismiss();
      Alert.alert(
        res.alreadyCollaborator ? 'Already has access' : 'Invite sent',
        res.alreadyCollaborator
          ? `@${res.username} already has access to this repo.`
          : `Invite sent to @${res.username} — they accept it on GitHub to get access.`
      );
    },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to add collaborator.'),
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
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SettingsNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();

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
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to delete project.'),
    });
  };

  const githubUrl = githubRepoWebUrl(project?.repo_url);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || project?.repo_url || null;
  const managed = project ? isManagedGithubProject(project) : false;

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
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
              <SettingsGroup>
                <SettingsRow
                  label="Project name"
                  value={project.name}
                  onPress={canManage ? () => openNameEditor(project) : undefined}
                />
              </SettingsGroup>

              <SettingsGroup>
                <SettingsRow
                  icon={githubUrl ? Github : GitBranch}
                  label="Repository"
                  value={repoLabel ?? '—'}
                  external={!!githubUrl}
                  onPress={githubUrl ? () => { haptics.tap(); void Linking.openURL(githubUrl); } : undefined}
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
