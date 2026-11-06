/**
 * Create or join — `/new`, the screen for a user with no workspace
 * (Workspaces D3, ux.md §1): a new user has 0 accounts, because sign-up
 * creates none. The start screen opens it whenever no account has a project
 * (`app/index.tsx`, `startDestination`).
 *
 * Workspaces are created on the web (KRTX-246): no form here. Layout (Jay,
 * 2026-09-26, Paper "FP2 · Editorial headline"): a `secondary` `rounded-full`
 * Sign out at the top right; the home hero (`ProjectHero`, the tilt-following
 * dither) centred in the free space; then the pending invitations, if any
 * ("Invitations", each row with Join → the invite screen); then,
 * left-aligned, "Create a workspace" (`h1`) and one `muted` sentence; then a
 * "Create workspace" pill (icon pinned left, the auth screen's pill); with no
 * invitation, one quiet line under it: "Invited? Open the invite link from
 * your email, or ask an admin to invite {email}." The pill opens web `/new`
 * (no `?account=`: web creates the whole workspace) in an in-app auth
 * session (`useWebCreateHandoff`). On return the app refetches accounts and
 * projects and opens the NEWEST workspace across every account in the fresh
 * lists, composer focused (`markComposerFocus`): `/new` is only reached with
 * zero workspaces, so any workspace there is the one just made. Coming back
 * to the app (AppState 'active') checks again. Nothing sits under this
 * screen, so Sign out (header) is the way out.
 *
 * Never a dead end (COR-186): whenever the user already has a workspace —
 * made on the web while the diff could not load, or on another device — an
 * "Open <workspace>" row sits above the heading.
 */

import * as React from 'react';
import { AppState, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlatformFullWidthButton } from '@/components/kortix/platform-button';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { WorkspaceInvitations } from '@/components/projects/WorkspaceInvitations';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { ProjectHero } from '@/components/session/ProjectHero';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext, useLanguage } from '@/contexts';
import { useSignOutAndRoute } from '@/hooks/useSignOutAndRoute';
import { haptics } from '@/lib/haptics';
import { ArrowUpRightIcon, FolderIcon } from '@/lib/icons';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { markComposerFocus } from '@/lib/onboarding/composer-handoff';
import { useMyInvites } from '@/lib/invites/hooks';
import { inviteHref } from '@/lib/invites/invite-landing';
import { useWorkspaces } from '@/lib/projects/hooks';
import { isOpenableWorkspaceRow } from '@/lib/projects/switcher';
import type { KortixProject } from '@/lib/projects/projects-client';
import { projectHref } from '@/lib/projects/switcher';
import { newestProject } from '@/lib/projects/web-create';
import { newWorkspaceWebUrl } from '@/lib/projects/web-project-links';
import { THEME } from '@/lib/utils/theme';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export default function NewProjectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const { signingOut, signOutAndRoute } = useSignOutAndRoute();
  const webCreate = useWebCreateHandoff();
  const { colorScheme } = useColorScheme();
  // Glyph colour on a `default` fill (CLAUDE.md Color rule 6), as on the auth screen.
  const onPrimary = THEME[colorScheme === 'dark' ? 'dark' : 'light'].primaryForeground;

  const openProject = React.useCallback(
    (project: KortixProject) => {
      if (project.account_id) setSelectedAccountId(project.account_id);
      markComposerFocus(project.project_id);
      router.replace(projectHref(project.project_id));
    },
    [router, setSelectedAccountId]
  );

  // Empty on a true first run. Refetched on return from the web.
  const workspaces = useWorkspaces();
  const existingProject = React.useMemo(
    () => newestProject(workspaces.rows.filter(isOpenableWorkspaceRow).map((row) => row.project)),
    [workspaces.rows]
  );
  const invites = useMyInvites(true).data ?? [];
  const openInvite = React.useCallback(
    (inviteId: string) => {
      haptics.tap();
      router.push(inviteHref(inviteId));
    },
    [router]
  );

  const handleContinue = React.useCallback(async () => {
    haptics.tap();
    const { after } = await webCreate.open(newWorkspaceWebUrl(KORTIX_WEB_URL));
    const project = after ? newestProject(after.projects) : null;
    if (project) openProject(project);
  }, [webCreate, openProject]);

  // Back from another app (a workspace made on a computer): check every
  // account again, quietly, and open the newest workspace if one exists. The
  // in-app browser round trip does its own check (`handleContinue`).
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || webCreate.pending) return;
      void webCreate
        .refresh()
        .then((snapshot) => {
          const project = newestProject(snapshot.projects);
          if (project) openProject(project);
        })
        .catch(() => {});
    });
    return () => sub.remove();
  }, [webCreate, openProject]);
  const busy = webCreate.pending;

  const handleSignOut = React.useCallback(() => {
    if (signingOut) return;
    haptics.tap();
    void signOutAndRoute();
  }, [signingOut, signOutAndRoute]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background px-6" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row justify-end" style={{ paddingTop: insets.top + 8 }}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={signingOut}
            onPress={handleSignOut}>
            <Text>{t('auth.signOut', 'Sign out')}</Text>
          </Button>
        </View>

        {/* Groups by space (better-layout): 32pt between the recovery row, the
            mark and the copy; 12pt inside the copy (heading → line). One left
            edge (px-6) for the mark, both text lines and the actions. */}
        <View className="flex-1 pb-10">
          {/* The home hero (tilt-following dither), centred in the free
              space above the copy. */}
          <View className="flex-1 items-center justify-center">
            <ProjectHero />
          </View>

          {invites.length > 0 ? (
            <View className="mb-8">
              <WorkspaceInvitations invites={invites} onOpenInvite={openInvite} disabled={busy} />
            </View>
          ) : null}

          {existingProject ? (
            <View className="mb-8">
              <SettingsGroup title={t('workspace.yours', 'Your workspace')}>
                <SettingsRow
                  icon={FolderIcon}
                  label={t('workspace.openNamed', { defaultValue: 'Open {{workspace}}', workspace: existingProject.name })}
                  onPress={
                    webCreate.pending
                      ? undefined
                      : () => {
                          haptics.tap();
                          openProject(existingProject);
                        }
                  }
                />
              </SettingsGroup>
            </View>
          ) : null}

          {/* Measure capped for tablets (better-typography: ~60–75 chars). */}
          <View className="max-w-md gap-3">
            {/* `h1` is centred and extrabold by default: this screen is
                left-aligned, and every other app heading is semibold. */}
            <Text
              variant="h1"
              className="text-left font-semibold"
              textBreakStrategy="balanced"
              lineBreakStrategyIOS="standard">
              {t('workspace.createTitle', 'Create a workspace')}
            </Text>
            <Text variant="muted" className="text-base leading-6" lineBreakStrategyIOS="standard">
              {t(
                'workspace.createBody',
                'A workspace is where your company works with Kortix: people, agents and everything they make.'
              )}
            </Text>
          </View>
        </View>

        {/* The auth screen's pill: label centred, icon pinned to the left
            edge (`PlatformFullWidthButton leading`). */}
        <PlatformFullWidthButton
          size="lg"
          label={t('workspace.create', 'Create workspace')}
          leading={<ArrowUpRightIcon size={18} color={onPrimary} />}
          disabled={busy}
          onPress={() => void handleContinue()}
        />
        {invites.length === 0 ? (
          <Text variant="muted" className="mt-4 text-center text-sm" lineBreakStrategyIOS="standard">
            {t('workspace.invitedHint', {
              defaultValue: 'Invited? Open the invite link from your email, or ask an admin to invite {{email}}.',
              email: user?.email ?? '',
            })}
          </Text>
        ) : null}
      </View>
    </>
  );
}
