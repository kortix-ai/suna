/**
 * AppsPage — the project's Apps (web parity: /projects/<id>/apps).
 *
 * One list of the project's deployed Apps, the same inventory the web client
 * renders (`listApps`). A row opens the App: it mints a short-lived access
 * session (`createAppAccessSession`, the same call web's open makes) and
 * hands the URL to the Browser page tab, whose WebView follows the
 * `?__kortix_access=` exchange and keeps the App's cookie. Mobile leaves out
 * web's create, deploy and access editing — an App is managed on web.
 *
 * Entry point: the drawer's Apps row, shown only while the project's `apps`
 * feature flag is on (fail-closed, like web's sidebar entry). The page keeps
 * the same gate, so a restored tab never shows a disabled surface.
 */
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';

import { PageContent } from '@/components/kortix/page-content';
import { PageHeader } from '@/components/kortix/page-header';
import { PageList, StatusDot } from '@/components/kortix/page-list';
import { SettingsGroupItem, SettingsRow } from '@/components/kortix/settings-list';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { useToast } from '@/components/kortix/toast-provider';
import { Icon } from '@/components/ui/icon';
import { CaretRightIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';
import { useProject, useProjectApps } from '@/lib/projects/hooks';
import { createAppAccessSession, type App } from '@/lib/projects/projects-client';
import { useTabStore, type PageTab } from '@/stores/tab-store';

interface AppsPageProps {
  page: PageTab;
  projectId: string;
  onOpenDrawer?: () => void;
  isDrawerOpen?: boolean;
}

export function AppsPage({ page, projectId, onOpenDrawer, isDrawerOpen }: AppsPageProps) {
  const toast = useToast();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const project = useProject(projectId);
  const apps = useProjectApps(projectId);
  // Fail-closed like web: loading counts as disabled.
  const appsEnabled = project.data?.experimental?.apps === true;

  const openApp = useCallback(
    async (app: App) => {
      haptics.tap();
      setOpeningId(app.app_id);
      try {
        const session = await createAppAccessSession(projectId, app.app_id);
        const tabs = useTabStore.getState();
        // The Browser page tab is the mobile "open in the full browser" surface
        // (tool rows use the same state shape). The session URL carries the
        // access token; the App's server exchanges it for a cookie on landing.
        tabs.setTabState('page:browser', { savedUrl: session.url, savedDisplay: app.name });
        tabs.navigateToPage('page:browser');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to open this App. Try again.');
      } finally {
        setOpeningId(null);
      }
    },
    [projectId, toast]
  );

  const rows = apps.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        isDrawerOpen={isDrawerOpen}
      />
      <PageContent>
        <PageList<App>
          isLoading={apps.isLoading || (project.isLoading && !project.data)}
          errorMessage={apps.isError && rows.length === 0 ? (apps.error?.message ?? 'Unable to load Apps') : null}
          onRetry={() => void apps.refetch()}
          onRefresh={() => apps.refetch()}
          emptyLabel={
            !appsEnabled
              ? 'Apps is not enabled for this project'
              : rows.length === 0
                ? 'No Apps in this project yet'
                : null
          }
          header={<View className="h-1" />}
          data={rows}
          keyExtractor={(app) => app.app_id}
          renderItem={(app, index) => {
            const canOpen = app.viewer_can_access !== false;
            return (
              <View className="px-4">
                <SettingsGroupItem index={index} count={rows.length}>
                  <SettingsRow
                    label={app.name || app.slug}
                    description={canOpen ? app.slug : `${app.slug} · No access`}
                    onPress={canOpen ? () => openApp(app) : undefined}
                    accessibilityLabel={
                      canOpen
                        ? `Open App ${app.name || app.slug}, ${app.desired_state}`
                        : `App ${app.name || app.slug}, no access`
                    }
                    right={
                      openingId === app.app_id ? (
                        <KortixLoader size="small" />
                      ) : (
                        <View className="flex-row items-center gap-3">
                          <StatusDot
                            on={app.desired_state === 'running'}
                            label={app.desired_state === 'running' ? 'Running' : 'Stopped'}
                          />
                          {canOpen ? (
                            <Icon as={CaretRightIcon} size={16} className="text-muted-foreground/70" />
                          ) : null}
                        </View>
                      )
                    }
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
