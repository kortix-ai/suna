'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
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
  ClockCounterClockwiseIcon,
  GlobeIcon,
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  XIcon,
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

/**
 * How long a frame may take before we admit out loud that it is loading.
 *
 * A warm App paints far inside this — the card thumbnail already fetched the
 * signed URL, so the modal's frame is the second request for a document the
 * browser has cached. Painting the overlay from mount made every one of those
 * flash a spinner for a single frame on the way in, which reads as SLOWER than
 * showing nothing. Below the threshold the frame area stays on its calm
 * `bg-muted/20` surface and the App simply appears.
 */
export const PREVIEW_SPINNER_DELAY_MS = 280;

/**
 * The delay timer, extracted from the effect so the threshold is testable.
 * `apps/web` has no DOM test harness, so a hook's effect cannot be driven from
 * a test — this seam can, with fake timers.
 */
export function scheduleSlowPreview(
  onSlow: () => void,
  delayMs: number = PREVIEW_SPINNER_DELAY_MS,
): () => void {
  const timer = setTimeout(onSlow, delayMs);
  return () => clearTimeout(timer);
}

/**
 * True once a still-pending frame has passed the threshold above.
 *
 * There is no reset branch because there is nothing to reset: `pending` only
 * ever goes true → false (the frame loads, or it errors), and a frame that has
 * settled is covered by `loaded` / `failed`. A remount — a new deployment — gets
 * a fresh `key` from the caller and therefore fresh state.
 */
function useSlowPreview(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    return scheduleSlowPreview(() => setSlow(true));
  }, [pending]);
  return slow;
}

/**
 * What covers the frame while it is not showing the App.
 *
 * Exported for its own test: the whole point of this component is the state it
 * DOESN'T render (no spinner before the threshold), which is only assertable
 * against markup.
 */
export function AppPreviewOverlay({
  loaded,
  failed,
  slow,
}: {
  loaded: boolean;
  failed: boolean;
  slow: boolean;
}) {
  // A failure is never worth waiting to report — `onError` means the frame is
  // done and it is not going to paint.
  if (!failed && (loaded || !slow)) return null;
  return (
    <div className="bg-background/95 absolute inset-0 flex items-center justify-center px-6 text-center backdrop-blur-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {failed ? null : <Loading className="size-4 shrink-0" />}
        <span>{failed ? 'Preview unavailable. Open the App to retry.' : 'Loading preview'}</span>
      </div>
    </div>
  );
}

export function AppPreview({
  app,
  url,
  accessError,
  /**
   * `false` on a CARD: the card is one big button, and a live iframe would
   * swallow every click meant for it (and let someone interact with a page
   * inside a 300px tile). The card renders the frame purely as a thumbnail and
   * the card takes the click. `true` in the detail modal, where the frame IS
   * the App.
   */
  interactive,
  className,
}: {
  app: App;
  url: string | null;
  accessError: boolean;
  interactive: boolean;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const slow = useSlowPreview(!loaded && !failed);
  const frame = cn(
    'bg-muted/20 relative overflow-hidden',
    !interactive && 'aspect-video',
    className,
  );

  if (!app.active_deployment_id) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
        data-testid="app-preview-empty"
      >
        Deploy to see a live preview.
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
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
    <div className={frame}>
      <iframe
        key={app.active_deployment_id}
        src={url}
        title={`${app.name} live preview`}
        // The card thumbnail is one of many below the fold, so defer it. In the
        // modal the frame IS the content and it is already on screen — `lazy`
        // there makes the browser wait for layout before it even starts the
        // fetch, which is pure added latency on the one open that must feel
        // instant.
        loading={interactive ? 'eager' : 'lazy'}
        allow={CLIPBOARD_IFRAME_ALLOW}
        sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
        className={cn(
          'bg-background absolute inset-0 size-full border-0',
          !interactive && 'pointer-events-none',
        )}
        {...(interactive ? {} : { tabIndex: -1, 'aria-hidden': true })}
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
      <AppPreviewOverlay loaded={loaded} failed={failed} slow={slow} />
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
  // Apps own their leaves — the routes assert project.app.write for policy and
  // shape changes and project.app.deploy for anything that changes what the
  // public hostname serves. Gating on project.customize.write let a custom role
  // that granted Apps still render read-only, and one that revoked Apps still
  // render the controls.
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_WRITE).allowed === true;
  const canDeploy =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY).allowed === true;
  // Which App the detail modal is showing. Held by id, not by object, so a
  // refetch (a lifecycle toggle, a rollback) re-renders the modal against the
  // fresh row instead of a stale copy captured at click time.
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const openApp = apps.data?.find((item) => item.app_id === openAppId) ?? null;

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
      description="Deploy apps to stable Kortix URLs. They wake on request and stop when idle."
      docs="/docs/feature-flags/apps"
      className="max-w-5xl"
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
            <AppCard
              key={app.app_id}
              projectId={projectId}
              app={app}
              onOpen={() => setOpenAppId(app.app_id)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={GlobeIcon}
          title="No Apps deployed"
          description="Deploy a static site, JavaScript bundle, Dockerfile, or OCI image with the Kortix CLI. Deployed Apps appear here."
        />
      )}

      {openApp ? (
        <AppDetailModal
          key={openApp.app_id}
          projectId={projectId}
          app={openApp}
          canWrite={canWrite}
          canDeploy={canDeploy}
          open
          onOpenChange={(next) => {
            if (!next) setOpenAppId(null);
          }}
        />
      ) : null}
    </CustomizeSectionWrapper>
  );
}

function AppCard({
  projectId,
  app,
  onOpen,
}: {
  projectId: string;
  app: App;
  onOpen: () => void;
}) {
  // SESSION only, and only when the viewer may actually open this App. The
  // access POLICY is an administrative read that 403s for an ordinary member,
  // and the card never renders it — the detail modal asks. The SESSION 403s for
  // any App the viewer may see but not open, which is a state the server now
  // reports up front instead of leaving the card to discover it by failing.
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: canAccess });
  const deployed = Boolean(app.active_deployment_id);
  const live = deployed && app.desired_state === 'running';

  return (
    <li>
      {/* One control per card. Everything that used to be a row of six icon
          buttons now lives at the top of the detail modal, so there is exactly
          one thing to click and no nested hit areas. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${app.name}`}
        className={cn(
          'group bg-popover w-full overflow-hidden rounded-md border text-left',
          'transition-[box-shadow,border-color] hover:border-border hover:shadow-sm',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        )}
      >
        <div className="relative border-b">
          <AppPreview
            key={app.active_deployment_id ?? app.app_id}
            app={app}
            url={access.session.data?.url ?? null}
            accessError={!canAccess || access.session.isError}
            interactive={false}
          />
          {/* Hairline so the thumbnail never bleeds into the panel edge. */}
          <span className="pointer-events-none absolute inset-0 outline outline-black/10 -outline-offset-1 dark:outline-white/10" />
        </div>

        <div className="flex items-center gap-3 px-4 py-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-sm',
              live ? 'bg-kortix-green/15' : 'bg-muted',
            )}
          >
            <GlobeIcon
              weight="fill"
              className={cn('size-5', live ? 'text-kortix-green' : 'text-muted-foreground')}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-sm font-medium">{app.name}</p>
            <p className="text-muted-foreground truncate font-mono text-xs">{app.url}</p>
          </div>
          <Badge size="xs" variant={live ? 'success' : 'muted'}>
            {!deployed ? 'Not deployed' : app.desired_state === 'running' ? 'Running' : 'Suspended'}
          </Badge>
        </div>
      </button>
    </li>
  );
}

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place and the
 * actions that used to crowd the card sit in one bar over the top of it.
 */
function AppDetailModal({
  projectId,
  app,
  canWrite,
  canDeploy,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canDeploy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: canWrite, session: canAccess });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const latest = deployments.data?.[0];
  const deployed = Boolean(app.active_deployment_id);
  const live = deployed && app.desired_state === 'running';
  const running = app.desired_state === 'running';
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;
  const liveUrl = access.session.data?.url ?? app.url;

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
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        side="fullscreen"
        showCloseButton={false}
        // Radix focuses the first focusable descendant on open, which is an
        // action in the bar — and a focused icon button shows its Hint, so the
        // modal opened with a black tooltip sitting over its own controls.
        // Focus the dialog instead: the focus trap still holds, Tab still walks
        // into the bar, and nothing pops unbidden.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus?.();
        }}
        className="border-border bg-background! focus:outline-none focus-visible:outline-none inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none! translate-x-0! translate-y-0! gap-0! space-y-0! overflow-hidden! rounded-none! border-0! md:inset-4! md:h-auto! md:min-h-0! md:rounded-md! md:border!"
        aria-label={`${app.name} App`}
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-sm',
                live ? 'bg-kortix-green/15' : 'bg-muted',
              )}
            >
              <GlobeIcon
                weight="fill"
                className={cn('size-4', live ? 'text-kortix-green' : 'text-muted-foreground')}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-foreground truncate text-sm font-medium">{app.name}</p>
                <Badge size="xs" variant={live ? 'success' : 'muted'}>
                  {!deployed ? 'Not deployed' : running ? 'Running' : 'Suspended'}
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
              <p className="text-muted-foreground truncate font-mono text-xs">{app.url}</p>
            </div>

            <ButtonGroup>
              {canDeploy ? (
                <Hint label={running ? 'Suspend App' : 'Wake App'}>
                  <Button
                    size="icon"
                    variant="outline"
                    disabled={busy || !deployed}
                    aria-label={running ? 'Suspend App' : 'Wake App'}
                    onClick={() => lifecycle(running ? 'stop' : 'start')}
                  >
                    {busy ? (
                      <Loading className="size-4 shrink-0" />
                    ) : running ? (
                      <PauseIcon className="size-4 shrink-0" />
                    ) : (
                      <PlayIcon className="size-4 shrink-0" />
                    )}
                  </Button>
                </Hint>
              ) : null}
              {canWrite ? (
                <Hint label="App access">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label="App access"
                    onClick={() => setAccessOpen(true)}
                  >
                    <LockKeyIcon className="size-4 shrink-0" />
                  </Button>
                </Hint>
              ) : null}
              <Hint label="Versions">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Show versions"
                  aria-expanded={versionsOpen}
                  onClick={() => setVersionsOpen((value) => !value)}
                >
                  <ClockCounterClockwiseIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
              <Hint label="Open in a new tab">
                <Button asChild size="icon" variant="outline">
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Open in a new tab"
                  >
                    <ArrowSquareOutIcon className="size-4 shrink-0" />
                  </a>
                </Button>
              </Hint>
              <Hint label="Close">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Close"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
            </ButtonGroup>
          </header>

          <div className="relative min-h-0 flex-1">
            <AppPreview
              key={app.active_deployment_id ?? app.app_id}
              app={app}
              url={access.session.data?.url ?? null}
              accessError={!canAccess || access.session.isError}
              interactive
              className="absolute inset-0 size-full"
            />
          </div>

          {versionsOpen ? (
            <div className="bg-muted/20 max-h-[40vh] shrink-0 overflow-y-auto border-t px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-foreground text-xs font-medium">Versions</p>
                <div className="flex items-center gap-2">
                  <Hint label="Copy deploy command">
                    <CopyButton code={appCommand(app)} size="md" />
                  </Hint>
                  {canWrite ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <TrashIcon className="size-3.5 shrink-0" />
                      Delete App
                    </Button>
                  ) : null}
                </div>
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
                      canDeploy={canDeploy}
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
        </div>
      </ModalContent>

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
            // The App this modal is about no longer exists — close it, or the
            // frame keeps rendering a deleted App behind a dead action bar.
            onOpenChange(false);
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
    </Modal>
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
  canDeploy,
  rollbackPending,
  onRollback,
}: {
  deployment: AppDeployment;
  active: boolean;
  canDeploy: boolean;
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
      {canDeploy && deployment.status === 'ready' && !active ? (
        <Button size="xs" variant="ghost" disabled={rollbackPending} onClick={onRollback}>
          {rollbackPending ? <Loading /> : <ClockCounterClockwiseIcon className="size-3.5" />}
          Roll back
        </Button>
      ) : null}
    </div>
  );
}
