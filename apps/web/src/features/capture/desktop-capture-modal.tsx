'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { RecordIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopCaptureOpenLogs,
  desktopCaptureOpenPermission,
  desktopCaptureOpenTimeline,
  desktopCaptureSet,
  desktopCaptureSignInCancel,
  desktopCaptureSignInFinish,
  desktopCaptureSignInStart,
  desktopCaptureSignOut,
  desktopCaptureStatus,
  isDesktop,
  openExternalRoute,
  type DesktopCaptureLayer,
  type DesktopCaptureStatus,
} from '@/lib/desktop';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

import { connectDesktopCapture } from './connect-desktop-capture';

export const DESKTOP_CAPTURE_STATUS_KEY = ['desktop-capture-status'] as const;
const LAYERS: readonly DesktopCaptureLayer[] = ['screen', 'actions', 'audio'];

/** The bundled engine's status. `null` in a browser or a desktop build without Capture. */
export function useDesktopCaptureStatus({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: DESKTOP_CAPTURE_STATUS_KEY,
    queryFn: async () => (await desktopCaptureStatus()) ?? null,
    enabled: isDesktop(),
    refetchInterval: poll ? 3_000 : 30_000,
  });
}

/** The person's projects with the `capture` feature flag on. */
function useCaptureProjects() {
  const { sections, listsLoading } = useProjectSelectorData();
  const projects = useMemo(
    () => sections.flatMap((section) => section.projects).filter((project) => project.experimental?.capture),
    [sections],
  );
  return { projects, loading: listsLoading };
}

/** "Capture" in the workspace menu: only in the desktop app, with an engine, and a project to record into. */
export function DesktopCaptureMenuItem({ onSelect }: { onSelect: () => void }) {
  const t = useTranslations('capture.desktop');
  const status = useDesktopCaptureStatus();
  const { projects } = useCaptureProjects();
  if (!status.data?.available || (projects.length === 0 && !status.data.signedIn)) return null;
  return (
    <DropdownMenuItem onSelect={onSelect} size="sm">
      <RecordIcon />
      {t('menu')}
      {status.data.signedIn ? <CaptureStateDot state={status.data.state} className="ml-auto" /> : null}
    </DropdownMenuItem>
  );
}

function CaptureStateDot({ state, className }: { state?: string; className?: string }) {
  const t = useTranslations('capture.desktop');
  const recording = state === 'recording';
  const attention = state === 'permission_missing' || state === 'crashed' || state === 'signInRequired';
  return (
    <span
      role="img"
      aria-label={t(`state.${stateKey(state)}`)}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        recording ? 'bg-kortix-green' : attention ? 'bg-kortix-orange' : 'bg-muted-foreground',
        className,
      )}
    />
  );
}

const STATES = ['recording', 'paused', 'permission_missing', 'not_recording', 'starting', 'crashed', 'off', 'signInRequired', 'signedOut'];
const stateKey = (state?: string) => (state && STATES.includes(state) ? state : 'not_recording');

export function DesktopCaptureModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* A column: on a short window only the body scrolls; header and footer stay. */}
      <ModalContent className="flex flex-col lg:max-w-lg">
        {open ? <CaptureContent currentProjectId={projectId} /> : null}
      </ModalContent>
    </Modal>
  );
}

function CaptureHeader({ status }: { status: ReactNode }) {
  const t = useTranslations('capture.desktop');
  return (
    <ModalHeader className="pr-12">
      <ModalTitle>{t('title')}</ModalTitle>
      <ModalDescription className="flex items-center gap-1.5 text-xs">{status}</ModalDescription>
    </ModalHeader>
  );
}

function CaptureContent({ currentProjectId }: { currentProjectId: string }) {
  const t = useTranslations('capture.desktop');
  const queryClient = useQueryClient();
  const status = useDesktopCaptureStatus({ poll: true });
  const { projects, loading } = useCaptureProjects();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [changing, setChanging] = useState(false);

  const setStatus = (next: DesktopCaptureStatus | null | undefined) => {
    if (next) queryClient.setQueryData(DESKTOP_CAPTURE_STATUS_KEY, next);
    void queryClient.invalidateQueries({ queryKey: DESKTOP_CAPTURE_STATUS_KEY });
  };

  const change = useMutation({
    retry: false,
    mutationFn: desktopCaptureSet,
    onSuccess: setStatus,
    onError: (error: Error) => errorToast(error.message || t('changeFailed')),
  });

  const signOut = useMutation({
    retry: false,
    // Server first: the device loses its access in Kortix, then this app forgets it.
    mutationFn: async (view: DesktopCaptureStatus) => {
      if (view.projectId && view.deviceId) await revokeCaptureDevice(view.projectId, view.deviceId).catch(() => undefined);
      return desktopCaptureSignOut();
    },
    onSuccess: (next) => {
      setConfirmSignOut(false);
      setStatus(next);
      successToast(t('signedOut'));
    },
    onError: (error: Error) => errorToast(error.message || t('signOutFailed')),
  });

  const view = status.data;
  if (status.isPending) {
    return (
      <>
        <CaptureHeader status={t('state.starting')} />
        <ModalBody>
          <Loading className="size-4 shrink-0" />
        </ModalBody>
      </>
    );
  }
  if (!view?.available) {
    return (
      <>
        <CaptureHeader status={t('unavailableTitle')} />
        <ModalBody>
          <p className="text-muted-foreground text-sm text-pretty">{view?.error || t('unavailable')}</p>
        </ModalBody>
      </>
    );
  }

  if (!view.signedIn || changing) {
    return (
      <SignIn
        view={view}
        projects={projects}
        loading={loading}
        defaultProjectId={changing ? (view.projectId ?? null) : currentProjectId}
        onDone={(next) => {
          setChanging(false);
          setStatus(next);
        }}
        onCancel={changing ? () => setChanging(false) : undefined}
      />
    );
  }

  const project = projects.find((p) => p.project_id === view.projectId);
  const lastUpload = view.sync?.lastUploadMs ? relativeTime(new Date(view.sync.lastUploadMs).toISOString()) : '';

  return (
    <>
      <CaptureHeader
        status={
          <>
            <CaptureStateDot state={view.state} />
            <span>{t(`state.${stateKey(view.state)}`)}</span>
            {project ? <span>· {project.name}</span> : null}
          </>
        }
      />
      <ModalBody className="min-h-0 space-y-6 overflow-y-auto">
        {view.state === 'crashed' && view.error ? <InfoBanner tone="warning" title={t('crashed')}>{view.error}</InfoBanner> : null}
        {view.policy?.notice ? <InfoBanner title={t('policyNotice')}>{view.policy.notice}</InfoBanner> : null}

        <SettingsRowGroup>
          <SettingsRow label={t('record')} description={t('recordDescription')}>
            <Switch
              checked={Boolean(view.on)}
              disabled={change.isPending}
              onCheckedChange={(on) => change.mutate({ on })}
              aria-label={t('record')}
            />
          </SettingsRow>
        </SettingsRowGroup>

        <section className="space-y-2">
          <Label>{t('layersTitle')}</Label>
          <SettingsRowGroup>
            {LAYERS.map((layer) => {
              const blocked = view.policy?.layers[layer] === false;
              return (
                <SettingsRow
                  key={layer}
                  label={t(`layers.${layer}`)}
                  description={blocked ? t('layerOffByPolicy') : t(`layers.${layer}Description`)}
                >
                  <Switch
                    checked={!blocked && Boolean(view.layers?.[layer])}
                    disabled={blocked || change.isPending}
                    onCheckedChange={(on) => change.mutate({ [layer]: on })}
                    aria-label={t(`layers.${layer}`)}
                  />
                </SettingsRow>
              );
            })}
          </SettingsRowGroup>
        </section>

        {view.permissions ? <Permissions view={view} /> : null}

        <section className="space-y-1">
          <p className="text-muted-foreground text-xs text-pretty">
            {project ? t('recordsInto', { project: project.name }) : t('recordsIntoUnknown')}{' '}
            {view.sync?.error
              ? t('syncError', { error: view.sync.error })
              : lastUpload
                ? t('lastUpload', { time: lastUpload, pending: view.sync?.pending ?? 0 })
                : t('noUploadYet')}
          </p>
          <Button size="sm" variant="link" className="h-auto px-0 text-xs" onClick={() => setChanging(true)}>
            {t('changeProject')}
          </Button>
        </section>
      </ModalBody>
      <ModalFooter className="border-t py-3 sm:justify-between">
        <div className="flex w-full items-center gap-1 sm:w-auto">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void desktopCaptureOpenTimeline().catch((error: Error) => errorToast(error.message))}
          >
            {t('openTimeline')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void desktopCaptureOpenLogs().catch((error: Error) => errorToast(error.message))}
          >
            {t('showLogs')}
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-kortix-red hover:bg-kortix-red/15 hover:text-kortix-red w-full sm:w-auto"
          onClick={() => setConfirmSignOut(true)}
        >
          {t('signOutEllipsis')}
        </Button>
      </ModalFooter>

      <ConfirmDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title={t('signOutTitle')}
        description={t('signOutDescription')}
        confirmLabel={t('signOut')}
        confirmVariant="destructive"
        isPending={signOut.isPending}
        onConfirm={() => signOut.mutate(view)}
      />
    </>
  );
}

const PERMISSIONS = ['screen', 'accessibility', 'microphone'] as const;

/** macOS grants Kortix holds for Capture, each with its System Settings pane. */
function Permissions({ view }: { view: DesktopCaptureStatus }) {
  const t = useTranslations('capture.desktop');
  const needed = PERMISSIONS.filter((key) => key !== 'microphone' || view.layers?.audio);
  return (
    <section className="space-y-2">
      <Label>{t('permissionsTitle')}</Label>
      <SettingsRowGroup>
        {needed.map((key) => {
          const granted = view.permissions?.[key] === true;
          return (
            <SettingsRow key={key} label={t(`permissions.${key}`)} description={granted ? t('permissionGranted') : t('permissionMissing')}>
              {granted ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void desktopCaptureOpenPermission(key).catch((error: Error) => errorToast(error.message))}
                >
                  {t('openSystemSettings')}
                </Button>
              )}
            </SettingsRow>
          );
        })}
      </SettingsRowGroup>
      <p className="text-muted-foreground text-xs text-pretty">{t('permissionsHint')}</p>
    </section>
  );
}

function SignIn({
  view,
  projects,
  loading,
  defaultProjectId,
  onDone,
  onCancel,
}: {
  view: DesktopCaptureStatus;
  projects: { project_id: string; name: string }[];
  loading: boolean;
  defaultProjectId: string | null;
  onDone: (status: DesktopCaptureStatus | null | undefined) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('capture.desktop');
  const tAuthorize = useTranslations('capture.authorize');
  const [picked, setPicked] = useState<string | null>(null);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const fallback = projects.some((p) => p.project_id === defaultProjectId) ? defaultProjectId : projects.length === 1 ? projects[0]!.project_id : null;
  const projectId = picked ?? fallback;

  const connect = useMutation({
    retry: false,
    mutationFn: async (target: string) => {
      const result = await connectDesktopCapture(target, {
        start: desktopCaptureSignInStart,
        approve: approveCaptureDeviceGrant,
        finish: desktopCaptureSignInFinish,
        cancel: desktopCaptureSignInCancel,
        openApproval: (url) => {
          setWaitingOnPage(true);
          // The approval page of this instance, in the person's browser.
          const route = url.replace(/^https?:\/\/[^/]+/, '');
          if (!openExternalRoute(route)) window.open(url, '_blank');
        },
      });
      if (!result.ok) throw new Error(result.error === 'cancelled' ? t('signInCancelled') : result.error || t('signInFailed'));
      return result.status;
    },
    onSuccess: (next) => {
      successToast(t('signedIn'));
      onDone(next);
    },
    onSettled: () => setWaitingOnPage(false),
  });

  return (
    <>
      <CaptureHeader status={view.signInRequired ? t('state.signInRequired') : t('state.signedOut')} />
      <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
        {view.signInRequired ? <InfoBanner tone="warning" title={t('signInRequiredHint')} /> : null}
        <p className="text-muted-foreground text-sm text-pretty">{t('intro')}</p>
        <section className="space-y-3">
          <Label>{tAuthorize('projectLabel')}</Label>
          {loading ? (
            <Loading className="size-4" />
          ) : projects.length === 0 ? (
            <p className="text-muted-foreground text-xs text-pretty">{tAuthorize('noProjects')}</p>
          ) : (
            <RadioGroup value={projectId ?? ''} onValueChange={setPicked}>
              {projects.map((project) => (
                <RadioGroupItem key={project.project_id} value={project.project_id} variant="outline" label={project.name} />
              ))}
            </RadioGroup>
          )}
        </section>
        <p className="text-muted-foreground text-xs text-pretty">{tAuthorize('notice')}</p>
        {connect.error ? <InfoBanner tone="warning" title={connect.error.message} /> : null}
        {waitingOnPage ? <p className="text-muted-foreground text-xs">{t('waitingOnPage')}</p> : null}
        <div className="space-y-2">
          <Button className="w-full" disabled={!projectId || connect.isPending} onClick={() => projectId && connect.mutate(projectId)}>
            {connect.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {connect.isPending ? t('signingIn') : t('turnOn')}
          </Button>
          {connect.isPending ? (
            <Button variant="ghost" className="w-full" onClick={() => void desktopCaptureSignInCancel()}>
              {t('cancel')}
            </Button>
          ) : onCancel ? (
            <Button variant="ghost" className="w-full" onClick={onCancel}>
              {t('cancel')}
            </Button>
          ) : null}
        </div>
      </ModalBody>
    </>
  );
}
