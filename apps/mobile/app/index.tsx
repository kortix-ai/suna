/**
 * Start screen — the door into the app (mirror of web's /projects/start).
 *
 * Signed out → /auth. Signed in → the project the user had open last, else the
 * first project (lib/projects/landing.ts), opened with `router.replace` so no
 * screen sits under the project and back can never leave it. The Projects list
 * opens only when the user has no project in any account; otherwise the list
 * is reached from the project menu (All projects) alone.
 *
 * Every automatic "take me into the app" redirect (sign-in, a back button with
 * no history, leaving an account) replaces to `/` so it lands here. A network
 * failure retries twice, then shows Try again. It never falls back to the list.
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
import { listAccounts, listProjectsForAccount } from '@/lib/projects/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { useLastProjectStore } from '@/stores/last-project-store';

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
  const { user, isAuthenticated, isLoading: authLoading } = useAuthContext();
  const userId = user?.id ?? null;
  const [failed, setFailed] = React.useState(false);
  // Bumped by Try again to re-run the resolve.
  const [attempt, setAttempt] = React.useState(0);

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
        await Promise.all([whenHydrated(useLastProjectStore), whenHydrated(useCurrentAccountStore)]);
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

        if (resolution.kind === 'project') {
          // Every account-scoped surface agrees with where the user landed.
          useCurrentAccountStore.getState().setSelectedAccountId(resolution.accountId);
          log.log(`🚀 → /projects/${resolution.projectId} (last or first project)`);
          router.replace(`/projects/${resolution.projectId}`);
        } else {
          log.log('🚀 → /projects (no project in any account)');
          router.replace('/projects');
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
        setFailed(true);
      }
    };

    setFailed(false);
    void run(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [authLoading, isAuthenticated, userId, attempt, queryClient, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 items-center justify-center gap-4 bg-background px-8">
        {failed ? (
          <>
            <Text variant="large" className="text-center">
              Could not open your project
            </Text>
            <Button variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
              <Text>Try again</Text>
            </Button>
          </>
        ) : (
          <KortixLoader size="xlarge" />
        )}
      </View>
    </>
  );
}
