/**
 * AppsPage (`page:apps`) — the project's Apps, the web Apps page's list
 * (`apps-view.tsx`): one row per App, its runtime state as the value, and a
 * tap that opens it — the same two hops web's `?open_app=` link runs, a
 * short-lived access session then the URL, in a browser instead of an iframe.
 * Apps are deployed from a sandbox with `kortix apps deploy`, so the page has
 * no create action and no search: it is a list you open things from.
 */

import { type App, createAppAccessSession, listApps } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useColorScheme } from 'nativewind';
import React, { useCallback } from 'react';
import { View } from 'react-native';

import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PageList } from '@/components/kortix/page-list';
import { SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { SquaresFourIcon } from '@/lib/icons';
import { AppAccessDeniedError, appStatus, openApp } from '@/lib/projects/apps';
import { projectKeys } from '@/lib/projects/hooks';
import { openLink } from '@/lib/utils/open-link';
import { THEME } from '@/lib/utils/theme';

interface PageTabLike {
  id: string;
  label: string;
}

interface AppsPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  isDrawerOpen?: boolean;
}

export function AppsPage({ page, projectId, onOpenDrawer, isDrawerOpen }: AppsPageProps) {
  const { colorScheme } = useColorScheme();
  const bgColor = colorScheme === 'dark' ? THEME.dark.background : THEME.light.background;
  const toast = useToast();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: projectKeys.apps(projectId),
    queryFn: () => listApps(projectId),
    enabled: !!projectId,
    staleTime: 10_000,
  });
  const apps = data ?? [];

  const openOne = useCallback(
    (app: App) => {
      haptics.tap();
      void openApp(app, {
        createSession: () => createAppAccessSession(projectId, app.app_id),
        openLink,
      }).catch((openError: unknown) => {
        toast.error(
          openError instanceof AppAccessDeniedError
            ? openError.message
            : openError instanceof Error
              ? openError.message
              : 'Could not open this app',
        );
      });
    },
    [projectId, toast],
  );

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader title={page.label} onOpenDrawer={onOpenDrawer} isDrawerOpen={isDrawerOpen} />

      <PageContent>
        <PageList<App>
          isLoading={isLoading}
          errorMessage={
            isError && apps.length === 0
              ? ((error as Error)?.message ?? 'Unable to load apps')
              : null
          }
          onRetry={() => void refetch()}
          onRefresh={() => refetch()}
          emptyLabel={apps.length === 0 ? 'No apps yet' : null}
          header={<View className="h-1" />}
          data={apps}
          keyExtractor={(app) => app.app_id}
          renderItem={(app, index) => {
            const denied = app.viewer_can_access === false;
            return (
              <View className="px-4">
                <SettingsGroupItem index={index} count={apps.length}>
                  <SettingsRow
                    icon={SquaresFourIcon}
                    label={app.name}
                    value={denied ? 'No access' : appStatus(app)}
                    disabled={denied}
                    external={!denied}
                    onPress={() => openOne(app)}
                  />
                </SettingsGroupItem>
              </View>
            );
          }}
        />
      </PageContent>
    </View>
  );
}
