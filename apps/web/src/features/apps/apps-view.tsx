'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { ShareOption, SubjectPicker } from '@/features/workspace/shared/sharing-picker';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import {
  CLIPBOARD_IFRAME_ALLOW,
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX,
} from '@/lib/security/iframe-sandbox';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  createAppAccessSession,
  type App,
  type AppAccessConfig,
  type AppAccessMode,
  type AppDeployment,
} from '@kortix/sdk';
import {
  qk,
  useAppAccess,
  useAppDeployments,
  useFeatureFlag,
  useProjectApps,
} from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  ClockCounterClockwiseIcon,
  GlobeIcon,
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  TerminalWindowIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

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

function AppPreview({
  app,
  url,
  accessError,
}: {
  app: App;
  url: string | null;
  accessError: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!app.active_deployment_id) {
    return (
      <div
        className="bg-muted/20 text-muted-foreground flex aspect-video items-center justify-center border-b px-6 text-center text-xs text-pretty"
        data-testid="app-preview-empty"
      >
        Deploy to see a live preview.
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className="bg-muted/20 text-muted-foreground flex aspect-video items-center justify-center border-b px-6 text-center text-xs text-pretty"
        data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}
      >
        {accessError ? (
          'You do not have access to preview this App.'
        ) : (
          <span className="flex items-center gap-2">
            <Loading className="size-4 shrink-0" />
            Preparing preview
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="bg-muted/20 relative aspect-video overflow-hidden border-b">
      <iframe
        key={app.active_deployment_id}
        src={url}
        title={`${app.name} live preview`}
        loading="lazy"
        allow={CLIPBOARD_IFRAME_ALLOW}
        sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
        className="bg-background absolute inset-0 size-full border-0"
        data-testid="app-live-preview"
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onError={() => {
          setLoaded(false);
          setFailed(true);
        }}
      />
      {!loaded ? (
        <div className="bg-background/95 absolute inset-0 flex items-center justify-center px-6 text-center backdrop-blur-sm">
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            {failed ? null : <Loading className="size-4 shrink-0" />}
            <span>{failed ? 'Preview unavailable. Open the App to retry.' : 'Loading preview'}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AppsView({ projectId }: { projectId: string }) {
  // One gating primitive, fail-closed. Apps NEVER enables itself from here:
  // activation lives only in Customize → Feature flags, so this page has no
  // mutation and no self-enable button.
  const appsGate = useFeatureFlag(projectId, 'apps');
  const apps = useProjectApps(appsGate.enabled ? projectId : null);
  const searchParams = useSearchParams();
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE).allowed === true;

  useEffect(() => {
    const target = searchParams.get('open_app');
    if (!target || !apps.data) return;
    const app = apps.data.find((item) => item.app_id === target);
    if (!app) return;
    void createAppAccessSession(projectId, app.app_id)
      .then((session) => window.location.replace(session.url))
      .catch((error) =>
        errorToast(error instanceof Error ? error.message : 'App access denied'),
      );
  }, [apps.data, projectId, searchParams]);

  return (
    <CustomizeSectionWrapper
      title="Apps"
      description="Deploy apps to stable dosco URLs. They wake on request and stop when idle."
      docs="/docs/sdk/apps"
      className="max-w-5xl"
      action={
        <Badge size="sm" variant="beta">
          Experimental
        </Badge>
      }
      showSidebarToggleButton
    >
      {appsGate.isLoading ? (
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
      ) : !appsGate.enabled ? (
        <FeatureGateScreen
          featureName="Apps"
          description="Apps deploy static sites, JavaScript bundles, Dockerfiles, and OCI images to stable URLs. Each App wakes on its next request and suspends after its idle timeout."
        />
      ) : apps.isLoading ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <li key={index} className="bg-popover overflow-hidden rounded-md border">
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="space-y-2 px-4 py-3">
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
        <ul className="grid gap-4 md:grid-cols-2">
          {apps.data.map((app) => (
            <AppRow key={app.app_id} projectId={projectId} app={app} canWrite={canWrite} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={GlobeIcon}
          title="No Apps deployed"
          description="Deploy a static site, JavaScript bundle, Dockerfile, or OCI image with the dosco CLI. Deployed Apps appear here."
        />
      )}

      {appsGate.enabled ? (
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
          <span className="text-muted-foreground block text-xs text-pretty">
            Run this in a linked project. A v2 <code className="text-foreground">kortix.yaml</code>{' '}
            can define build, resources, environment, and secret mappings.
          </span>
          <code className="text-foreground mt-2 block overflow-x-auto font-mono text-xs">
            kortix apps deploy .
          </code>
        </InfoBanner>
      ) : null}

    </CustomizeSectionWrapper>
  );
}

function AppRow({ projectId, app, canWrite }: { projectId: string; app: App; canWrite: boolean }) {
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const access = useAppAccess(projectId, app.app_id);
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const latest = deployments.data?.[0];
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;

  const lifecycle = async (action: 'start' | 'stop') => {
    try {
      await (action === 'start'
        ? apps.start.mutateAsync(app.app_id)
        : apps.stop.mutateAsync(app.app_id));
      successToast(`${app.name} ${action === 'start' ? 'is ready' : 'suspended'}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : `Failed to ${action} App`);
    }
  };

  return (
    <li aria-label={`${app.name} App`} className="bg-popover overflow-hidden rounded-md border">
      <AppPreview
        key={app.active_deployment_id ?? app.app_id}
        app={app}
        url={access.session.data?.url ?? null}
        accessError={access.session.isError}
      />
      <div className="flex items-start gap-3 px-4 py-3">
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
              {app.desired_state === 'running' ? 'Running' : 'Suspended'}
            </Badge>
            {latest ? (
              <Badge size="xs" variant={deploymentTone(latest.status)}>
                {latest.status}
              </Badge>
            ) : null}
            <Badge size="xs" variant="outline">
              {ACCESS_COPY[app.access_mode].label}
            </Badge>
          </div>
          <a
            href={access.session.data?.url ?? app.url}
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
        <div className="flex shrink-0 items-center gap-0.5">
          <Hint label="Open App">
            <Button asChild size="icon" variant="ghost" className="size-10">
              <a
                href={access.session.data?.url ?? app.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open App"
              >
                <ArrowSquareOutIcon className="size-4" />
              </a>
            </Button>
          </Hint>
          <Hint label="Copy deploy command">
            <CopyButton code={appCommand(app)} size="lg" />
          </Hint>
          {canWrite ? (
            <Hint label="App access">
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                aria-label="App access"
                onClick={() => setAccessOpen(true)}
              >
                <LockKeyIcon className="size-4" />
              </Button>
            </Hint>
          ) : null}
          {canWrite ? (
            <Hint label={app.desired_state === 'running' ? 'Suspend App' : 'Wake App'}>
              <Button
                size="icon"
                variant="ghost"
                className="size-10"
                disabled={busy || !app.active_deployment_id}
                aria-label={app.desired_state === 'running' ? 'Suspend App' : 'Wake App'}
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
              className="size-10"
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
        <div className="bg-muted/20 border-border/70 border-t px-4 py-3">
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
      {accessOpen ? (
        <AppAccessModal
          projectId={projectId}
          app={app}
          access={access}
          open={accessOpen}
          onOpenChange={setAccessOpen}
        />
      ) : null}
    </li>
  );
}

const ACCESS_COPY: Record<AppAccessMode, { label: string; desc: string }> = {
  private: { label: 'Only you', desc: 'Only the App creator can open it' },
  project: { label: 'Whole team', desc: 'Every member of this project' },
  restricted: { label: 'Select members', desc: 'Chosen members and groups' },
  public: { label: 'Public', desc: 'Anyone with the URL' },
  password: { label: 'Password', desc: 'Anyone with the App password' },
};

function AppAccessModal({
  projectId,
  app,
  access,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  access: ReturnType<typeof useAppAccess>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={(value) => !access.update.isPending && onOpenChange(value)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>App access</ModalTitle>
          <ModalDescription>
            Choose who can open {app.name}. Apps are private by default.
          </ModalDescription>
        </ModalHeader>
        {access.policy.isLoading ? (
          <ModalBody>
            <Skeleton className="h-48 w-full rounded-md" />
          </ModalBody>
        ) : access.policy.isError ? (
          <>
            <ModalBody>
              <ErrorState
                size="sm"
                title="Failed to load App access"
                description={(access.policy.error as Error).message}
                action={
                  <Button size="sm" variant="outline" onClick={() => access.policy.refetch()}>
                    Retry
                  </Button>
                }
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </ModalFooter>
          </>
        ) : access.policy.data ? (
          <AppAccessForm
            key={access.policy.data.revision}
            projectId={projectId}
            policy={access.policy.data}
            update={access.update}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function AppAccessForm({
  projectId,
  policy,
  update,
  onSaved,
}: {
  projectId: string;
  policy: AppAccessConfig;
  update: ReturnType<typeof useAppAccess>['update'];
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<AppAccessMode>(policy.mode);
  const [memberIds, setMemberIds] = useState<string[]>(policy.member_ids);
  const [groupIds, setGroupIds] = useState<string[]>(policy.group_ids);
  const [password, setPassword] = useState('');
  const incomplete = mode === 'restricted' && memberIds.length + groupIds.length === 0;
  const passwordMissing = mode === 'password' && !password && !policy.password_configured;

  const save = async () => {
    try {
      await update.mutateAsync({
        mode,
        ...(mode === 'restricted' ? { member_ids: memberIds, group_ids: groupIds } : {}),
        ...(mode === 'password' && password ? { password } : {}),
      });
      successToast('App access updated');
      onSaved();
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Failed to update App access');
    }
  };

  return (
    <>
      <ModalBody className="max-h-[65vh] space-y-4 overflow-y-auto">
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as AppAccessMode)}
          className="space-y-2"
        >
          {(Object.keys(ACCESS_COPY) as AppAccessMode[]).map((value) => (
            <ShareOption
              key={value}
              value={value}
              label={ACCESS_COPY[value].label}
              desc={ACCESS_COPY[value].desc}
            />
          ))}
        </RadioGroup>
        {mode === 'restricted' ? (
          <SubjectPicker
            projectId={projectId}
            memberIds={memberIds}
            groupIds={groupIds}
            onChange={(members, groups) => {
              setMemberIds(members);
              setGroupIds(groups);
            }}
          />
        ) : null}
        {mode === 'password' ? (
          <div className="space-y-2">
            <Label htmlFor="app-access-password">
              {policy.password_configured ? 'Replace password' : 'Password'}
            </Label>
            <Input
              id="app-access-password"
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={
                policy.password_configured
                  ? 'Leave blank to keep the current password'
                  : 'At least 8 characters'
              }
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button variant="outline-ghost" size="sm" onClick={onSaved} disabled={update.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={update.isPending || incomplete || passwordMissing}
        >
          {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </ModalFooter>
    </>
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
