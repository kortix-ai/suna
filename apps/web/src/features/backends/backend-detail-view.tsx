'use client';

import Link from '@/components/site-link';
import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { getBackendCredentials, type ProjectBackend } from '@kortix/sdk';
import { useFeatureFlag, useProjectBackends } from '@kortix/sdk/react';
import { ArrowLeftIcon, DatabaseIcon, DotsThreeIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { BackendBackupsDialog, ResizeBackendDialog, backendSizeLabel } from './backend-dialogs';
import { BackendStatusBadge, backendDeployCommand, backendEnvText } from './backends-view';

/**
 * One backend: a Kortix header bar over Convex's own dashboard. The dashboard
 * asks its parent for credentials (`dashboard-credentials-request`); this page
 * answers with the admin key straight from the API, only to the dashboard's
 * origin. The key is never rendered or stored.
 */
export function BackendDetailView({ projectId, backendId }: { projectId: string; backendId: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const gate = useFeatureFlag(projectId, 'backends');
  const backends = useProjectBackends(gate.enabled ? projectId : null);
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_BACKEND_WRITE).allowed === true;
  const [dialog, setDialog] = useState<'resize' | 'backups' | null>(null);
  const backend = backends.data?.find((b) => b.backend_id === backendId) ?? null;
  const listHref = `/projects/${projectId}/backends`;

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      successToast(done);
    } catch {
      errorToast(t.raw('text4cb23f3c3b90'));
    }
  };

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={backend?.name ?? t.raw('text26cbb889e198')} href={listHref}>
        <div className="flex min-w-0 flex-1 items-center gap-2 pr-1">
          <Button asChild size="icon" variant="ghost" aria-label={t.raw('text1abb2f2abc1e')}>
            <Link href={listHref}>
              <ArrowLeftIcon className="size-4 shrink-0" />
            </Link>
          </Button>
          {backend ? (
            <>
              <BackendStatusBadge backend={backend} />
              <span className="text-muted-foreground hidden truncate text-xs md:inline">
                {backendSizeLabel(backend, t)}
              </span>
              {backend.url ? (
                <span className="hidden min-w-0 items-center gap-1 lg:flex">
                  <code className="text-muted-foreground truncate font-mono text-xs">{backend.url}</code>
                  <CopyButton code={backend.url} size="sm" className="shrink-0" />
                </span>
              ) : null}
              <div className="ml-auto flex shrink-0 items-center">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" aria-label={t.raw('text2de7b4934e29')}>
                      <DotsThreeIcon className="size-4 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {canWrite ? (
                      <DropdownMenuItem
                        disabled={backend.status !== 'running' || backend.operation !== null}
                        onClick={() => setDialog('resize')}
                      >
                        {t.raw('text5ad9ba3657f2')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem disabled={backend.status !== 'running'} onClick={() => setDialog('backups')}>
                      {t.raw('textf0e800ed571e')}
                    </DropdownMenuItem>
                    {canWrite ? (
                      <DropdownMenuItem
                        disabled={backend.status !== 'running'}
                        onClick={async () => {
                          try {
                            const credentials = await getBackendCredentials(projectId, backend.backend_id);
                            await copy(backendEnvText(credentials.env), t.raw('textaad2d1b4576e'));
                          } catch (error) {
                            errorToast(error instanceof Error ? error.message : t.raw('text9962d69a4916'));
                          }
                        }}
                      >
                        {t.raw('text3f044da00a6f')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      onClick={() => copy(backendDeployCommand(backend.name), t.raw('text5c3fa6a80824'))}
                    >
                      {t.raw('text21de8d7ddc3e')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          ) : null}
        </div>
      </ProjectPageHeader>

      <div className="min-h-0 flex-1">
        {gate.isLoading || backends.isLoading ? (
          <div className="p-6">
            <Skeleton className="h-full min-h-96 w-full" />
          </div>
        ) : !gate.enabled ? (
          <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
            <FeatureGateScreen featureName="Backends" internalOnly description={t.raw('text8dd10daddd77')} />
          </div>
        ) : !backend ? (
          <Notice title={t.raw('text88c4418c2c87')} body={t.raw('text992276f72e41')} />
        ) : backend.status !== 'running' || backend.operation ? (
          <Notice title={backend.name} body={t.raw('text354788a1e3e5')} />
        ) : !canWrite ? (
          <Notice title={backend.name} body={t.raw('text736d4f22425d')} />
        ) : !backend.dashboard_url ? (
          <Notice title={backend.name} body={t.raw('text6513690ca848')} />
        ) : (
          <ConvexDashboardFrame
            projectId={projectId}
            backend={backend}
            title={t.raw('text19eb2c0e5dca')}
            failed={t.raw('text9962d69a4916')}
          />
        )}
      </div>

      {backend && dialog === 'resize' ? (
        <ResizeBackendDialog
          backend={backend}
          isPending={backends.resize.isPending}
          onOpenChange={(open) => !open && setDialog(null)}
          onResize={(size) => backends.resize.mutateAsync({ backendId: backend.backend_id, ...size })}
        />
      ) : null}
      {backend && dialog === 'backups' ? (
        <BackendBackupsDialog
          projectId={projectId}
          backend={backend}
          canWrite={canWrite}
          restoring={backends.restore.isPending}
          onOpenChange={(open) => !open && setDialog(null)}
          onRestore={(snapshotId) => backends.restore.mutateAsync({ backendId: backend.backend_id, snapshotId })}
        />
      ) : null}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-7xl px-4 py-6 md:px-8">
      <EmptyState icon={DatabaseIcon} title={title} description={body} />
    </div>
  );
}

/** Convex's dashboard for one backend, signed in through Convex's own iframe handshake. */
function ConvexDashboardFrame({
  projectId,
  backend,
  title,
  failed,
}: {
  projectId: string;
  backend: ProjectBackend;
  title: string;
  failed: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const dashboardUrl = backend.dashboard_url!;
  const origin = new URL(dashboardUrl).origin;

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type !== 'dashboard-credentials-request') return;
      try {
        const credentials = await getBackendCredentials(projectId, backend.backend_id);
        frame.current?.contentWindow?.postMessage(
          {
            type: 'dashboard-credentials',
            adminKey: credentials.admin_key,
            deploymentUrl: credentials.url,
            deploymentName: backend.name,
          },
          origin,
        );
      } catch (error) {
        errorToast(error instanceof Error ? error.message : failed);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, projectId, backend.backend_id, backend.name, failed]);

  return (
    <iframe
      ref={frame}
      src={dashboardUrl}
      title={title}
      className="bg-background size-full border-0"
      allow="clipboard-read; clipboard-write"
    />
  );
}
