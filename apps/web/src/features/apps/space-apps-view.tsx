'use client';

import { useProjectSpaceApps } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { cardPreviewApp, gridApps } from '@kortix/ui/apps';
import { Button } from '@kortix/ui/button';
import { EmptyArt } from '@kortix/ui/empty-art';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { SquaresFourIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import { APP_GRID_COLUMN_OPTIONS, APP_GRID_CONTAINER, useAppGridColumns } from './app-density';
import { AppDetailModal } from './app-detail';
import { AppCard } from './apps-view';

/**
 * A channel's Apps tab: the Apps deployed from its threads, as the same cards
 * and detail modal as the Apps page, at the Apps page's column count.
 */
export function SpaceAppsView({ projectId, spaceId, place }: { projectId: string; spaceId: string; place: string }) {
  const t = useTranslations('spaces.view');
  const apps = useProjectSpaceApps(projectId, spaceId);
  const [columns] = useAppGridColumns();
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_WRITE).allowed === true;
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY).allowed === true;
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  const openApp = apps.data?.find((app) => app.app_id === openAppId) ?? null;
  const shown = apps.data ? gridApps(apps.data, canAdmin) : [];

  let body = null;
  if (apps.isError && !apps.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('appsLoadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => apps.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (apps.data && shown.length === 0) {
    body = (
      <EmptyState
        className="min-h-full"
        media={<EmptyArt icon={SquaresFourIcon} />}
        title={t('empty.apps.title')}
        description={t('empty.apps.description', { place })}
      />
    );
  } else if (apps.data) {
    body = (
      <ul className={cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[columns].grid)}>
        {shown.map((app) => (
          <AppCard
            key={app.app_id}
            projectId={projectId}
            app={app}
            shown={cardPreviewApp(apps.data!, app, canAdmin)}
            onOpen={() => setOpenAppId(app.app_id)}
          />
        ))}
      </ul>
    );
  }

  return (
    // No grid: the empty state fills the tab, as in the other tabs; an error keeps `py-16`.
    <div
      className={cn(
        'w-full',
        APP_GRID_CONTAINER,
        shown.length ? 'px-5 py-4' : apps.data ? 'flex min-h-full flex-col' : 'px-5 py-16',
      )}
    >
      {body}
      {openApp ? (
        <AppDetailModal
          key={openApp.app_id}
          projectId={projectId}
          app={openApp}
          canWrite={canWrite}
          canDeploy={canDeploy}
          canAdmin={canAdmin}
          open
          onOpenChange={(next) => {
            if (!next) setOpenAppId(null);
          }}
        />
      ) : null}
    </div>
  );
}
