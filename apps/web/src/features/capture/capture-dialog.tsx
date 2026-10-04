'use client';

import { approveCaptureDeviceGrant, revokeCaptureDevice } from '@kortix/sdk';
import { CursorClickIcon, MicrophoneIcon, MonitorIcon, type Icon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useTranslations } from '@/i18n/use-translations';
import {
  DESKTOP_CAPTURE_SETTINGS_COMMAND,
  desktopCaptureOpenLogs,
  desktopCaptureOpenTimeline,
  desktopCaptureRequestGrants,
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

/** The project's name, when the person can see it and it has the `capture` feature flag on. */
function useCaptureProject(projectId: string) {
  const { sections } = useProjectSelectorData();
  return useMemo(
    () =>
      sections
        .flatMap((section) => section.projects)
        .find((project) => project.project_id === projectId && project.experimental?.capture) ?? null,
    [sections, projectId],
  );
}

/**
 * The Capture dialog, opened by the desktop tray's "Capture…" (a desktop
 * command). Mounted once per project, in the sidebar's Capture entry.
 */
export function CaptureDialogHost({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail === DESKTOP_CAPTURE_SETTINGS_COMMAND) setOpen(true);
    };
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => window.removeEventListener('kortix-desktop-command', onCommand);
  }, []);
  return <CaptureDialog projectId={projectId} open={open} onOpenChange={setOpen} />;
}

/**
 * "Record this computer": Kortix Capture on this computer, in the desktop app.
 * Its own surface, apart from "Your computer" (the agents' access): turning it
 * on needs no download, browser, code, or computer pairing. The desktop app
 * starts the engine's device sign-in (`/v1/capture/device/*`) and this person
 * approves it with their own session and this computer's machine id; the
 * Capture service then records. Then the layers the project policy allows,
 * its notice, and Capture's macOS permissions.
 */
export function CaptureDialog({
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
      <ModalContent className="flex flex-col lg:max-w-lg">{open ? <CaptureContent projectId={projectId} /> : null}</ModalContent>
    </Modal>
  );
}

type Grant = 'screen' | 'accessibility' | 'microphone';
const GRANTS: readonly { key: Grant; icon: Icon }[] = [
  { key: 'screen', icon: MonitorIcon },
  { key: 'accessibility', icon: CursorClickIcon },
  { key: 'microphone', icon: MicrophoneIcon },
];
const STATES = ['recording', 'paused', 'permission_missing', 'not_recording', 'starting', 'crashed'];

function CaptureContent({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.dialog');
  const queryClient = useQueryClient();
  const status = useDesktopCaptureStatus({ poll: true });
  const project = useCaptureProject(projectId);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

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

  const signIn = useMutation({
    retry: false,
    mutationFn: async (machineId: string | null | undefined) => {
      const result = await connectDesktopCapture(projectId, {
        start: desktopCaptureSignInStart,
        approve: (userCode, target) => approveCaptureDeviceGrant(userCode, target, machineId ? { machineId } : {}),
        finish: desktopCaptureSignInFinish,
        cancel: desktopCaptureSignInCancel,
        openApproval: (url) => {
          setWaitingOnPage(true);
          if (!openExternalRoute(url.replace(/^https?:\/\/[^/]+/, ''))) window.open(url, '_blank');
        },
      });
      if (!result.ok) throw new Error(result.error === 'cancelled' ? t('signInCancelled') : result.error || t('signInFailed'));
      return result.status;
    },
    onSuccess: setStatus,
    onError: (error: Error) => errorToast(error.message),
    onSettled: () => setWaitingOnPage(false),
  });

  const signOut = useMutation({
    retry: false,
    // Kortix first (the device loses access), then this computer forgets it and the service goes.
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
  if (!view?.available || !project) {
    return (
      <>
        <CaptureHeader status={t('unavailableTitle')} />
        <ModalBody>
          <p className="text-muted-foreground text-sm text-pretty">{!project ? t('projectOff') : view?.error || t('unavailable')}</p>
        </ModalBody>
      </>
    );
  }

  const here = Boolean(view.signedIn && view.projectId === projectId);
  const recording = Boolean(here && view.on);
  const otherProject = Boolean(view.signedIn && view.projectId && view.projectId !== projectId);
  const busy = change.isPending || signIn.isPending;
  const toggle = (on: boolean) => {
    if (!on) return change.mutate({ on: false });
    if (here) return change.mutate({ on: true });
    signIn.mutate(view.machineId);
  };
  const state = view.state && STATES.includes(view.state) ? view.state : 'not_recording';

  return (
    <>
      <CaptureHeader
        status={
          recording ? (
            <>
              <StateDot state={state} />
              <span>{t(`state.${state}`)}</span>
            </>
          ) : (
            t('state.off')
          )
        }
      />
      <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
        <SettingsRowGroup>
          <SettingsRow
            label={t('record', { project: project.name })}
            description={signIn.isPending ? t('signingIn') : recording ? <LayersLine view={view} /> : t('offHint')}
          >
            {busy ? <Loading className="size-4 shrink-0" /> : null}
            <Switch checked={recording} disabled={busy} onCheckedChange={toggle} aria-label={t('record', { project: project.name })} />
          </SettingsRow>
        </SettingsRowGroup>

        {otherProject && !recording ? <p className="text-muted-foreground text-xs text-pretty">{t('otherProject')}</p> : null}
        {waitingOnPage ? <p className="text-muted-foreground text-xs">{t('waitingOnPage')}</p> : null}
        {view.signInRequired && view.projectId === projectId ? <InfoBanner tone="warning" title={t('signInRequired')} /> : null}

        {recording ? (
          <>
            <CapturePermissions view={view} setStatus={setStatus} />
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
            {view.policy?.notice ? <InfoBanner title={t('policyNotice')}>{view.policy.notice}</InfoBanner> : null}
          </>
        ) : null}
      </ModalBody>
      {here ? (
        <ModalFooter className="border-t py-3 sm:justify-between">
          <div className="flex w-full items-center gap-1 sm:w-auto">
            <Button size="sm" variant="ghost" onClick={() => void desktopCaptureOpenTimeline().catch((error: Error) => errorToast(error.message))}>
              {t('openTimeline')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void desktopCaptureOpenLogs().catch((error: Error) => errorToast(error.message))}>
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
      ) : null}
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

function CaptureHeader({ status }: { status: React.ReactNode }) {
  const t = useTranslations('capture.dialog');
  return (
    <ModalHeader className="pr-12">
      <ModalTitle>{t('title')}</ModalTitle>
      <ModalDescription className="flex items-center gap-1.5 text-xs">{status}</ModalDescription>
    </ModalHeader>
  );
}

function StateDot({ state }: { state: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        state === 'recording' ? 'bg-kortix-green' : state === 'permission_missing' || state === 'crashed' ? 'bg-kortix-orange' : 'bg-muted-foreground',
      )}
    />
  );
}

/** "Recording · Screen, Actions": the layers that record now. */
function LayersLine({ view }: { view: DesktopCaptureStatus }) {
  const t = useTranslations('capture.dialog');
  const layers = LAYERS.filter((layer) => view.layers?.[layer] && view.policy?.layers[layer] !== false).map((layer) => t(`layers.${layer}`));
  return <>{layers.length ? layers.join(', ') : t('noLayers')}</>;
}

/**
 * Capture's macOS permissions, granted to Kortix: Screen Recording,
 * Accessibility, and the Microphone only while Audio is on. Its own step and
 * state; the computer agent's setup is separate.
 */
function CapturePermissions({
  view,
  setStatus,
}: {
  view: DesktopCaptureStatus;
  setStatus: (next: DesktopCaptureStatus | null | undefined) => void;
}) {
  const t = useTranslations('capture.dialog');
  const [asked, setAsked] = useState(false);
  const request = useMutation({
    retry: false,
    mutationFn: () => desktopCaptureRequestGrants({ audio: Boolean(view.layers?.audio) }),
    onMutate: () => setAsked(true),
    onSuccess: setStatus,
    onError: (error: Error) => errorToast(error.message || t('changeFailed')),
  });
  if (!view.permissions) return null;
  const needed = GRANTS.filter(({ key }) => (key !== 'microphone' || view.layers?.audio) && !view.permissions?.[key]);
  if (needed.length === 0) return null;
  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('setup.title')}</p>
        <p className="text-muted-foreground text-xs text-pretty">{t('setup.hint')}</p>
      </div>
      <ul className="divide-border divide-y">
        {needed.map(({ key, icon: GrantIcon }) => (
          <li key={key} className="flex items-center gap-3 py-2.5">
            <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
              <GrantIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm">{t(`grants.${key}`)}</p>
              <p className="text-muted-foreground truncate text-xs">{t(`grants.${key}Description`)}</p>
            </div>
            <span className="text-muted-foreground shrink-0 text-xs">{asked ? t('setup.waiting') : t('setup.needed')}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <Button className="w-full" disabled={request.isPending} onClick={() => request.mutate()}>
          {request.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {t('setup.allowAll')}
        </Button>
        {asked ? <p className="text-muted-foreground text-xs text-pretty">{t('setup.settingsHint')}</p> : null}
      </div>
    </section>
  );
}
