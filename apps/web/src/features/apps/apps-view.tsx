'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useAppsFeatureEnabled } from '@/hooks/projects/use-apps-feature-enabled';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import type { App, AppDeployment } from '@kortix/sdk';
import { useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  GlobeIcon,
  PauseIcon,
  PlayIcon,
  TerminalWindowIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import { notFound } from 'next/navigation';

function deploymentTone(
  status: AppDeployment['status'],
): 'success' | 'destructive' | 'warning' | 'muted' {
  if (status === 'ready') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  if (
    status === 'queued' ||
    status === 'validating' ||
    status === 'building' ||
    status === 'provisioning' ||
    status === 'checking'
  )
    return 'warning';
  return 'muted';
}

function appCommand(app: App): string {
  return `kortix apps deploy . --app ${app.app_id}`;
}

export function AppsView({ projectId }: { projectId: string }) {
  const appsGate = useAppsFeatureEnabled(projectId);
  const apps = useProjectApps(appsGate.enabled ? projectId : null);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;
  if (!appsGate.isLoading && !appsGate.enabled) notFound();

  return (
    <CustomizeSectionWrapper
      title="Apps"
      description="Deploy apps to stable Kortix URLs. They wake on request and stop when idle."
      docs="/docs/sdk/apps"
      showSidebarToggleButton
    >
      {appsGate.isLoading || apps.isLoading ? (
        <ul className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <li
              key={index}
              className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3"
            >
              <Skeleton className="size-9 shrink-0 rounded-sm" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3 rounded-sm" />
                <Skeleton className="h-3 w-2/3 rounded-sm" />
              </div>
            </li>
          ))}
        </ul>
      ) : apps.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load Apps"
          description={(apps.error as Error).message}
          action={
            <Button size="sm" variant="outline" onClick={() => apps.refetch()}>
              Retry
            </Button>
          }
        />
      ) : apps.data?.length ? (
        <ul className="space-y-2">
          {apps.data.map((app) => (
            <AppRow key={app.app_id} projectId={projectId} app={app} canWrite={canWrite} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={GlobeIcon}
          title="No Apps deployed"
          description="Deploy a static site, JavaScript bundle, Dockerfile, or OCI image with the Kortix CLI. Deployed Apps appear here."
        />
      )}

      <InfoBanner
        tone="neutral"
        icon={TerminalWindowIcon}
        title="Deploy from a terminal"
        action={
          <Hint label="Copy deploy command">
            <CopyButton code="kortix apps deploy ." size="md" />
          </Hint>
        }
      >
        <span className="text-muted-foreground block text-xs">
          Run this in a linked project. A v2 <code className="text-foreground">kortix.yaml</code>{' '}
          can define build, resources, environment, and secret mappings.
        </span>
        <code className="text-foreground mt-2 block overflow-x-auto font-mono text-xs">
          kortix apps deploy .
        </code>
      </InfoBanner>

    </CustomizeSectionWrapper>
  );
}

function AppRow({ projectId, app, canWrite }: { projectId: string; app: App; canWrite: boolean }) {
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const latest = deployments.data?.[0];
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;

  const lifecycle = async (action: 'start' | 'stop') => {
    try {
      await (action === 'start'
        ? apps.start.mutateAsync(app.app_id)
        : apps.stop.mutateAsync(app.app_id));
      successToast(`${app.name} ${action === 'start' ? 'started' : 'stopped'}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : `Failed to ${action} App`);
    }
  };

  return (
    <li aria-label={`${app.name} App`} className="bg-popover overflow-hidden rounded-md border">
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-sm',
            app.desired_state === 'running'
              ? 'bg-kortix-green/15 text-kortix-green'
              : 'bg-muted text-muted-foreground',
          )}
        >
          <GlobeIcon className="size-5" weight="fill" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-foreground truncate text-sm font-medium">{app.name}</p>
            <Badge size="xs" variant={app.desired_state === 'running' ? 'success' : 'muted'}>
              {app.desired_state}
            </Badge>
            {latest ? (
              <Badge size="xs" variant={deploymentTone(latest.status)}>
                {latest.status}
              </Badge>
            ) : null}
          </div>
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground mt-0.5 block truncate font-mono text-xs transition-colors"
          >
            {app.url}
          </a>
          <p className="text-muted-foreground mt-1 text-xs tabular-nums">
            {app.machine.cpu} vCPU · {app.machine.memory_gb} GB RAM · {app.machine.disk_gb} GB disk
            · {app.idle_timeout_seconds}s idle
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Hint label="Open App">
            <Button asChild size="icon" variant="ghost" className="size-8">
              <a href={app.url} target="_blank" rel="noopener noreferrer" aria-label="Open App">
                <ArrowSquareOutIcon className="size-4" />
              </a>
            </Button>
          </Hint>
          <Hint label="Copy deploy command">
            <CopyButton code={appCommand(app)} size="lg" />
          </Hint>
          {canWrite ? (
            <Hint label={app.desired_state === 'running' ? 'Stop App' : 'Start App'}>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                disabled={busy || !app.active_deployment_id}
                aria-label={app.desired_state === 'running' ? 'Stop App' : 'Start App'}
                onClick={() => lifecycle(app.desired_state === 'running' ? 'stop' : 'start')}
              >
                {busy ? (
                  <Loading />
                ) : app.desired_state === 'running' ? (
                  <PauseIcon className="size-4" />
                ) : (
                  <PlayIcon className="size-4" />
                )}
              </Button>
            </Hint>
          ) : null}
          <Hint label="Versions">
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Show versions"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <CaretDownIcon
                className={cn('size-4 transition-transform', expanded && 'rotate-180')}
              />
            </Button>
          </Hint>
        </div>
      </div>

      {expanded ? (
        <div className="bg-muted/20 border-border/70 border-t px-4 py-3 pl-16">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-foreground text-xs font-medium">Versions</p>
            {canWrite ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <TrashIcon className="size-3.5" />
                Delete App
              </Button>
            ) : null}
          </div>
          {deployments.isLoading ? (
            <Loading className="text-muted-foreground" />
          ) : deployments.data?.length ? (
            <div className="space-y-1">
              {deployments.data.map((deployment) => (
                <DeploymentRow
                  key={deployment.deployment_id}
                  deployment={deployment}
                  active={deployment.deployment_id === app.active_deployment_id}
                  canWrite={canWrite}
                  rollbackPending={deployments.rollback.isPending}
                  onRollback={async () => {
                    try {
                      await deployments.rollback.mutateAsync(deployment.deployment_id);
                      successToast(`Rolled back to version ${deployment.version}`);
                    } catch (error) {
                      errorToast(error instanceof Error ? error.message : 'Rollback failed');
                    }
                  }}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No deployments yet.</p>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete App"
        description={`Delete ${app.name} and every runtime? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={apps.remove.isPending}
        onConfirm={async () => {
          try {
            await apps.remove.mutateAsync(app.app_id);
            setDeleteOpen(false);
            successToast(`${app.name} deleted`);
          } catch (error) {
            errorToast(error instanceof Error ? error.message : 'Failed to delete App');
          }
        }}
      />
    </li>
  );
}

function DeploymentRow({
  deployment,
  active,
  canWrite,
  rollbackPending,
  onRollback,
}: {
  deployment: AppDeployment;
  active: boolean;
  canWrite: boolean;
  rollbackPending: boolean;
  onRollback: () => void;
}) {
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
      <span className="text-foreground w-8 font-mono text-xs">v{deployment.version}</span>
      <Badge size="xs" variant={deploymentTone(deployment.status)}>
        {deployment.status}
      </Badge>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {deployment.source_kind}
        {deployment.hosting_provider ? ` · ${deployment.hosting_provider}` : ''}
      </span>
      {active ? <span className="text-muted-foreground text-xs">Live</span> : null}
      {canWrite && deployment.status === 'ready' && !active ? (
        <Button size="xs" variant="ghost" disabled={rollbackPending} onClick={onRollback}>
          {rollbackPending ? <Loading /> : <ClockCounterClockwiseIcon className="size-3.5" />}
          Roll back
        </Button>
      ) : null}
    </div>
  );
}
