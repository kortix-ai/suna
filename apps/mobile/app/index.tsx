/**
 * Start screen — the door into the app (mirror of web's /projects/start).
 *
 * Signed out → /auth. Signed in → the project the user had open last, else the
 * first project (lib/projects/landing.ts), opened with `router.replace` so no
 * screen sits under the project and back can never leave it. With no project
 * in any account (a new user): the upgrade screen once per user
 * (`/welcome`), then `/new` to create the first project — never an empty
 * list (`startDestination`, lib/onboarding/onboarding.ts; COR-161).
 *
 * Every automatic "take me into the app" redirect (sign-in, a back button with
 * no history, leaving an account) replaces to `/` so it lands here. A failure
 * retries twice, then shows why (lib/projects/start-failure.ts) and three ways
 * forward: Try again, All projects, Sign out. An ended session leads with
 * Sign in again. The screen is never a dead end.
 */

import * as React from 'react';
import { View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuthContext } from '@/contexts';
import { log } from '@/lib/logger';
import { projectKeys } from '@/lib/projects/hooks';
import { resolveLandingProject } from '@/lib/projects/landing';
import {
  classifyStartFailure,
  startFailureCopy,
  type StartFailure,
} from '@/lib/projects/start-failure';
import { listAccounts, listProjectsForAccount } from '@/lib/projects/projects-client';
import { onboardingAccountId, startDestination } from '@/lib/onboarding/onboarding';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useLastProjectStore } from '@/stores/last-project-store';
import { useOnboardingStore } from '@/stores/onboarding-store';
import { useBootStore } from '@/stores/boot-store';

/** Delays before the second and third resolve attempts. */
const RETRY_DELAY_MS = [400, 1200];

interface PersistedStore {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
  };
}

/** Resolve once a persisted zustand store has read AsyncStorage. */
function whenHydrated(store: PersistedStore): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export default function StartScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isAuthenticated, isLoading: authLoading, signOut } = useAuthContext();
  const userId = user?.id ?? null;
  const [failure, setFailure] = React.useState<StartFailure | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);
  // Bumped by Try again to re-run the resolve.
  const [attempt, setAttempt] = React.useState(0);
  // At launch the native splash covers this screen until it redirects or
  // shows a failure (KRTX-244): the loader draws only once the splash is
  // gone (a later visit, or the splash safety timeout), so it never slides
  // out under the destination as a second loader.
  const splashHidden = useBootStore((s) => s.splashHidden);

  React.useEffect(() => {
    if (failure) useBootStore.getState().settleLanding();
  }, [failure]);

  React.useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      log.log('🚀 → /auth (not authenticated)');
      router.replace('/auth');
      return;
    }
    // The last project is stored per user: wait for the user id.
    if (!userId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const run = async (tries: number) => {
      try {
        await Promise.all([
          whenHydrated(useLastProjectStore),
          whenHydrated(useCurrentAccountStore),
          whenHydrated(useOnboardingStore),
        ]);
        const accounts = await queryClient.fetchQuery({
          queryKey: projectKeys.accounts,
          queryFn: () => listAccounts(),
        });
        const resolution = await resolveLandingProject({
          accounts,
          selectedAccountId: useCurrentAccountStore.getState().selectedAccountId,
          lastProjectId: useLastProjectStore.getState().byUser[userId] ?? null,
          listProjects: (accountId) =>
            queryClient.fetchQuery({
              queryKey: projectKeys.projects(accountId),
              queryFn: () => listProjectsForAccount(accountId),
            }),
        });
        if (cancelled) return;

        const destination = startDestination(
          resolution,
          !!useOnboardingStore.getState().upgradeSeenByUser[userId]
        );
        if (destination.kind === 'project') {
          // Every account-scoped surface agrees with where the user landed.
          useCurrentAccountStore.getState().setSelectedAccountId(destination.accountId);
          log.log(`🚀 → /projects/${destination.projectId} (last or first project)`);
          router.replace(`/projects/${destination.projectId}`);
          return;
        }
        // No project in any account: the upgrade screen and `/new` open on
        // the account the first project would be created in.
        const accountId = onboardingAccountId(
          accounts,
          useCurrentAccountStore.getState().selectedAccountId
        );
        useCurrentAccountStore.getState().setSelectedAccountId(accountId);
        if (destination.kind === 'welcome') {
          log.log('🚀 → /welcome (no project, upgrade screen not seen)');
          router.replace('/welcome');
        } else {
          log.log('🚀 → /new (no project in any account)');
          router.replace('/new');
        }
      } catch (err) {
        if (cancelled) return;
        const delay = RETRY_DELAY_MS[tries];
        if (delay !== undefined) {
          retryTimer = setTimeout(() => void run(tries + 1), delay);
          return;
        }
        log.error(
          '❌ [start] could not resolve a project to open:',
          err instanceof Error ? err.message : err
        );
        setFailure(classifyStartFailure(err));
      }
    };

    setFailure(null);
    void run(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [authLoading, isAuthenticated, userId, attempt, queryClient, router]);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    // A failed sign-out (auth server down) still leaves the screen usable.
    const result = await signOut().catch(() => null);
    setSigningOut(false);
    if (result?.success) router.replace('/auth');
  }, [router, signOut, signingOut]);

  const copy = failure ? startFailureCopy(failure) : null;
  const sessionEnded = failure === 'session';

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 items-center justify-center bg-background px-8">
        {copy ? (
          <View className="w-full max-w-xs items-center">
            <Text variant="large" className="text-center">
              {copy.title}
            </Text>
            <Text variant="muted" className="mt-2 text-center">
              {copy.body}
            </Text>
            <View className="mt-6 w-full gap-2">
              {sessionEnded ? (
                <Button size="lg" className="rounded-full" disabled={signingOut} onPress={handleSignOut}>
                  <Text>Sign in again</Text>
                </Button>
              ) : (
                <>
                  <Button size="lg" className="rounded-full" onPress={() => setAttempt((n) => n + 1)}>
                    <Text>Try again</Text>
                  </Button>
                  <Button
                    size="lg"
                    variant="secondary"
                    className="rounded-full"
                    onPress={() => router.replace('/projects')}
                  >
                    <Text>All projects</Text>
                  </Button>
                  <Button
                    size="lg"
                    variant="ghost"
                    className="rounded-full"
                    disabled={signingOut}
                    onPress={handleSignOut}
                  >
                    <Text>Sign out</Text>
                  </Button>
                </>
              )}
            </View>
          </View>
        ) : splashHidden ? (
          <KortixLoader size="xlarge" />
        ) : null}
      </View>
    </>
  );
}
