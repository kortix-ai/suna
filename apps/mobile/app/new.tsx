/**
 * First run — `/new`, the screen for a user with no project in any account
 * (COR-161): after the upgrade screen on the first run, and on every start
 * while no account has a project (`app/index.tsx`, `startDestination`).
 *
 * Projects are created on the web (KRTX-246): no form here. "Create your
 * first project" (`h3`), one `muted` line, and one "Continue on web" pill
 * that opens web `/new?account=<current account>` in an in-app auth session
 * (`useWebCreateHandoff`). On return the app refetches accounts and
 * projects and opens the NEWEST project across every account in the fresh
 * lists, composer focused (`markComposerFocus`): `/new` is only reached with
 * zero projects in every account, so any project there is the one just made
 * — even when the before-snapshot failed or web created it in another
 * account. Nothing sits under this screen, so Sign out
 * (header) is the way out.
 *
 * Never a dead end (COR-186): whenever the current account already has a
 * project — made on the web while the diff could not load, or on another
 * device — an "Open <project>" row sits above the heading.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { FolderIcon } from '@/lib/icons';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { markComposerFocus } from '@/lib/onboarding/composer-handoff';
import { useProjects } from '@/lib/projects/hooks';
import type { KortixProject } from '@/lib/projects/projects-client';
import { projectHref } from '@/lib/projects/switcher';
import { newestProject } from '@/lib/projects/web-create';
import { newProjectWebUrl } from '@/lib/projects/web-project-links';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export default function NewProjectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuthContext();
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const [signingOut, setSigningOut] = React.useState(false);
  const webCreate = useWebCreateHandoff();

  const openProject = React.useCallback(
    (project: KortixProject) => {
      if (project.account_id) setSelectedAccountId(project.account_id);
      markComposerFocus(project.project_id);
      router.replace(projectHref(project.project_id));
    },
    [router, setSelectedAccountId]
  );

  // Empty on a true first run. Refetched on return from the web.
  const projectsQuery = useProjects(accountId);
  const existingProject = React.useMemo(() => newestProject(projectsQuery.data ?? []), [projectsQuery.data]);

  const handleContinue = React.useCallback(async () => {
    haptics.tap();
    const { after } = await webCreate.open(newProjectWebUrl(KORTIX_WEB_URL, accountId));
    const project = after ? newestProject(after.projects) : null;
    if (project) openProject(project);
  }, [webCreate, accountId, openProject]);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    haptics.tap();
    setSigningOut(true);
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    if (result?.success) router.replace('/auth');
  }, [router, signOut, signingOut]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background px-4" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row justify-end pb-2" style={{ paddingTop: insets.top + 8 }}>
          <Button variant="ghost" size="sm" disabled={signingOut} onPress={handleSignOut}>
            <Text>Sign out</Text>
          </Button>
        </View>

        <View className="flex-1 justify-center gap-4">
          {existingProject ? (
            <SettingsGroup title="Your project">
              <SettingsRow
                icon={FolderIcon}
                label={`Open ${existingProject.name}`}
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
          ) : null}

          <View>
            <Text variant="h3">Create your first project</Text>
            <Text variant="muted" className="mt-2">
              Projects are created on kortix.com.
            </Text>
          </View>
        </View>

        <Button size="lg" className="rounded-full" disabled={webCreate.pending} onPress={handleContinue}>
          <Text>Continue on web</Text>
        </Button>
      </View>
    </>
  );
}
