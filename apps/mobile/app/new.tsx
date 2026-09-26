/**
 * First run — `/new`, the screen for a user with no project in any account
 * (COR-161): after the upgrade screen on the first run, and on every start
 * while no account has a project (`app/index.tsx`, `startDestination`).
 *
 * Projects are created on the web (KRTX-246): no form here. Layout (Jay,
 * 2026-09-26, Paper "FP2 · Editorial headline"): a `secondary` `rounded-full`
 * Sign out at the top right; the project home hero (`ProjectHero`, the
 * tilt-following dither) centred in the free space; then, left-aligned,
 * "Set up your first project" (`h1`) and one `muted` line; then a "Create on
 * kortix.com ↗" pill (icon pinned left, the auth screen's pill); no second
 * action — coming back to the app re-checks every account and opens the
 * newest project (AppState 'active'). The pill
 * opens web `/new?account=<current account>` in an in-app auth session
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
import { AppState, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlatformFullWidthButton } from '@/components/kortix/platform-button';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useWebCreateHandoff } from '@/components/projects/useWebCreateHandoff';
import { ProjectHero } from '@/components/session/ProjectHero';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { haptics } from '@/lib/haptics';
import { ArrowUpRightIcon, FolderIcon } from '@/lib/icons';
import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { markComposerFocus } from '@/lib/onboarding/composer-handoff';
import { useProjects } from '@/lib/projects/hooks';
import type { KortixProject } from '@/lib/projects/projects-client';
import { projectHref } from '@/lib/projects/switcher';
import { newestProject } from '@/lib/projects/web-create';
import { newProjectWebUrl } from '@/lib/projects/web-project-links';
import { THEME } from '@/lib/utils/theme';
import { useCurrentAccountStore } from '@/stores/current-account-store';

export default function NewProjectScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signOut } = useAuthContext();
  const accountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useCurrentAccountStore((s) => s.setSelectedAccountId);
  const [signingOut, setSigningOut] = React.useState(false);
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
  const projectsQuery = useProjects(accountId);
  const existingProject = React.useMemo(
    () => newestProject(projectsQuery.data ?? []),
    [projectsQuery.data]
  );

  const handleContinue = React.useCallback(async () => {
    haptics.tap();
    const { after } = await webCreate.open(newProjectWebUrl(KORTIX_WEB_URL, accountId));
    const project = after ? newestProject(after.projects) : null;
    if (project) openProject(project);
  }, [webCreate, accountId, openProject]);

  // Back from another app (a project made on a computer): check every
  // account again, quietly, and open the newest project if one exists. The
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
      <View className="flex-1 bg-background px-6" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="flex-row justify-end" style={{ paddingTop: insets.top + 8 }}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={signingOut}
            onPress={handleSignOut}>
            <Text>Sign out</Text>
          </Button>
        </View>

        {/* Groups by space (better-layout): 32pt between the recovery row, the
            mark and the copy; 12pt inside the copy (heading → line). One left
            edge (px-6) for the mark, both text lines and the actions. */}
        <View className="flex-1 pb-10">
          {/* The project home hero (tilt-following dither), centred in the
              free space above the copy. */}
          <View className="flex-1 items-center justify-center">
            <ProjectHero />
          </View>

          {existingProject ? (
            <View className="mb-8">
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
              Set up your first project
            </Text>
            <Text variant="muted" className="text-base leading-6" lineBreakStrategyIOS="standard">
              A project is the repo your agents work from. Create it on kortix.com and it opens here when it's ready.
            </Text>
          </View>
        </View>

        {/* The auth screen's pill: label centred, icon pinned to the left
            edge (`PlatformFullWidthButton leading`). */}
        <PlatformFullWidthButton
          size="lg"
          label="Create on kortix.com"
          leading={<ArrowUpRightIcon size={18} color={onPrimary} />}
          disabled={busy}
          onPress={() => void handleContinue()}
        />
      </View>
    </>
  );
}
