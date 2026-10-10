'use client';

import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useTranslations } from '@/i18n/use-translations';
import { getAppCredentials, type App } from '@kortix/sdk';
import { DatabaseIcon } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

/**
 * The detail body of an App with capability `dashboard`: its own admin
 * dashboard, framed. The dashboard asks its parent for credentials
 * (`dashboard-credentials-request`); this frame answers with the admin key
 * straight from the audited credentials route, only to the dashboard's
 * origin. The key is never rendered or stored. Reading it needs
 * `project.app.admin`, so a member without it sees a notice instead.
 */
export function AppDashboard({ projectId, app, canAdmin }: { projectId: string; app: App; canAdmin: boolean }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const instance = app.instance;
  if (!instance || instance.status !== 'running' || !instance.dashboard_url) {
    return <Notice title={app.name} body={t.raw('text80cf9a7c2d86')} />;
  }
  // A snapshot keeps the machine serving; every other operation restarts it.
  if (instance.operation && instance.operation !== 'snapshotting') {
    return <Notice title={app.name} body={t.raw('text80cf9a7c2d86')} />;
  }
  if (!canAdmin) return <Notice title={app.name} body={t.raw('text9c36bdc2dbbf')} />;
  return <DashboardFrame projectId={projectId} app={app} dashboardUrl={instance.dashboard_url} />;
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full px-4 py-6 md:px-8">
      <EmptyState icon={DatabaseIcon} title={title} description={body} />
    </div>
  );
}

function DashboardFrame({ projectId, app, dashboardUrl }: { projectId: string; app: App; dashboardUrl: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = new URL(dashboardUrl).origin;
  const failed = t.raw('text9962d69a4916');

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type !== 'dashboard-credentials-request') return;
      try {
        const credentials = await getAppCredentials(projectId, app.app_id);
        frame.current?.contentWindow?.postMessage(
          {
            type: 'dashboard-credentials',
            adminKey: credentials.admin_key,
            deploymentUrl: credentials.url,
            deploymentName: app.slug,
          },
          origin,
        );
      } catch (error) {
        errorToast(error instanceof Error ? error.message : failed);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, projectId, app.app_id, app.slug, failed]);

  return (
    <iframe
      ref={frame}
      src={dashboardUrl}
      title={t.raw('text67b696468610')}
      data-testid="app-dashboard"
      className="bg-background absolute inset-0 size-full border-0"
      allow="clipboard-read; clipboard-write"
    />
  );
}
