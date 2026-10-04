'use client';

import { DotsThreeIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  DESKTOP_CAPTURE_SETTINGS_COMMAND,
  desktopCaptureOpenLogs,
  desktopCaptureOpenTimeline,
  desktopCaptureSignInCancel,
  type DesktopCaptureStatus,
} from '@/lib/desktop';
import { cn } from '@/lib/utils';

import { CapturePermissions } from './capture-permissions';
import { CAPTURE_LAYERS, activeLayers, capturePhase, type CapturePhase } from './capture-state';
import { useCaptureProject, useDesktopCaptureActions, useDesktopCaptureStatus } from './use-desktop-capture';

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
 * "Record this computer": Kortix Capture on this computer, in the desktop
 * app. Its own surface, apart from "Your computer" (what agents may use).
 * One phase at a time (capture-state.ts), one primary action per phase.
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
      <ModalContent className="flex flex-col lg:max-w-lg">
        {open ? <CaptureContent projectId={projectId} onClose={() => onOpenChange(false)} /> : null}
      </ModalContent>
    </Modal>
  );
}

const DOT: Partial<Record<CapturePhase, string>> = {
  recording: 'bg-kortix-green',
  needsPermission: 'bg-kortix-orange',
  signInRequired: 'bg-kortix-orange',
  paused: 'bg-kortix-orange',
  error: 'bg-kortix-red',
};

function CaptureContent({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('capture.dialog');
  const locale = useLocale();
  const status = useDesktopCaptureStatus({ poll: true });
  const { project, loading } = useCaptureProject(projectId);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const actions = useDesktopCaptureActions(projectId, { onWaitingOnPage: () => setWaitingOnPage(true) });
  const view = status.data ?? null;

  const turnOn = () => {
    if (!view) return;
    actions.turnOn.reset();
    actions.turnOn.mutate(view, {
      onSuccess: () => successToast(t('toast.started')),
      onSettled: () => setWaitingOnPage(false),
    });
  };
  const failed = actions.turnOn.isError;
  // The last status read (every 2 s) is "now", so render stays pure.
  const now = status.dataUpdatedAt;
  const phase = capturePhase(view, {
    now,
    projectId,
    projectHasCapture: Boolean(project),
    turningOn: actions.turnOn.isPending,
    failed,
  });

  if (status.isPending || loading) {
    return (
      <>
        <Header title={t('title')} status={null} />
        <ModalBody>
          <Loading className="size-4 shrink-0" />
        </ModalBody>
      </>
    );
  }

  const projectName = project?.name ?? '';
  const pausedUntil =
    view?.pausedUntilMs && view.pausedUntilMs > now
      ? new Date(view.pausedUntilMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : null;
  const statusWord =
    phase === 'paused'
      ? view?.policy?.paused
        ? t('status.pausedByProject')
        : pausedUntil
          ? t('status.pausedUntil', { time: pausedUntil })
          : t('status.paused')
      : t(`status.${phase}`);
  const on = phase === 'needsPermission' || phase === 'paused' || phase === 'starting' || phase === 'recording';
  const recordingWhat = view ? activeLayers(view).map((layer) => t(`layers.${layer}`)) : [];

  if (phase === 'unavailable' || phase === 'projectOff') {
    return (
      <>
        <Header title={t('title')} status={<StatusLine phase={phase} word={statusWord} />} />
        <ModalBody>
          <p className="text-muted-foreground text-sm text-pretty">
            {phase === 'projectOff' ? t('projectOff') : view?.error || t('unavailable')}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="outline-ghost" onClick={onClose}>
            {t('actions.close')}
          </Button>
        </ModalFooter>
      </>
    );
  }

  return (
    <>
      <Header
        title={t('title')}
        status={
          <>
            <span className="truncate">{projectName}</span>
            <span aria-hidden>·</span>
            <StatusLine phase={phase} word={statusWord} />
          </>
        }
      />
      <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
        {phase === 'signInRequired' ? (
          <InfoBanner tone="warning" icon={WarningIcon} title={t('signInRequired.title')}>
            {t('signInRequired.hint')}
          </InfoBanner>
        ) : null}
        {phase === 'error' ? (
          <InfoBanner tone="destructive" icon={WarningIcon} title={t('error.title')}>
            {actions.turnOn.error?.message || view?.error || t('error.fallback')}
          </InfoBanner>
        ) : null}

        {on ? (
          recordingWhat.length > 0 ? null : <p className="text-muted-foreground text-sm">{t('noLayers')}</p>
        ) : (
          <p className="text-muted-foreground text-sm text-pretty">{t('intro', { project: projectName })}</p>
        )}

        {phase === 'turningOn' ? (
          <div className="flex items-center gap-2 text-sm" role="status">
            <Loading className="size-4 shrink-0" />
            <span>{waitingOnPage ? t('turningOn.waitingOnPage') : t('turningOn.progress', { project: projectName })}</span>
          </div>
        ) : null}
        {phase === 'off' && view?.signedIn && view.projectId !== projectId ? (
          <p className="text-muted-foreground text-xs text-pretty">{t('otherProject')}</p>
        ) : null}

        {phase === 'needsPermission' && view ? (
          <CapturePermissions view={view} requesting={actions.grants.isPending} onAllow={() => actions.grants.mutate(Boolean(view.layers?.audio))} />
        ) : null}

        {view ? (
          <section className="space-y-2">
            <Label>{t('layersTitle')}</Label>
            <SettingsRowGroup>
              {CAPTURE_LAYERS.map((layer) => {
                const blocked = view.policy?.layers[layer] === false;
                return (
                  <SettingsRow
                    key={layer}
                    label={t(`layers.${layer}`)}
                    description={blocked ? t('layerOffByPolicy') : t(`layers.${layer}Description`)}
                  >
                    <Switch
                      checked={!blocked && Boolean(view.layers?.[layer])}
                      disabled={blocked || actions.set.isPending || phase === 'turningOn'}
                      onCheckedChange={(value) =>
                        actions.set.mutate({ [layer]: value }, { onError: (error: Error) => errorToast(error.message || t('changeFailed')) })
                      }
                      aria-label={t(`layers.${layer}`)}
                    />
                  </SettingsRow>
                );
              })}
            </SettingsRowGroup>
          </section>
        ) : null}

        {view?.policy?.notice && (on || phase === 'signInRequired') ? (
          <section className="space-y-1">
            <Label>{t('notice', { project: projectName })}</Label>
            <p className="text-muted-foreground text-sm text-pretty">{view.policy.notice}</p>
          </section>
        ) : null}
      </ModalBody>

      <ModalFooter className="border-t py-3 sm:justify-between">
        <div className="flex items-center gap-1">
          {on || phase === 'error' || phase === 'signInRequired' ? (
            <MoreMenu
              canStop={on}
              onStop={() =>
                actions.set.mutate({ on: false }, {
                  onSuccess: () => successToast(t('toast.stopped')),
                  onError: (error: Error) => errorToast(error.message || t('changeFailed')),
                })
              }
              onSignOut={() => setConfirmSignOut(true)}
            />
          ) : null}
          {phase === 'turningOn' ? (
            <Button variant="outline-ghost" onClick={() => void desktopCaptureSignInCancel()}>
              {t('actions.cancel')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {on ? (
            <Button variant="outline" onClick={() => void desktopCaptureOpenTimeline().catch((error: Error) => errorToast(error.message))}>
              {t('actions.openTimeline')}
            </Button>
          ) : null}
          <PrimaryAction
            phase={phase}
            pausedByProject={Boolean(view?.policy?.paused)}
            busy={actions.pause.isPending || actions.resume.isPending}
            onStart={turnOn}
            onPause={() => actions.pause.mutate(undefined, { onSuccess: () => successToast(t('toast.paused')) })}
            onResume={() => actions.resume.mutate(undefined, { onSuccess: () => successToast(t('toast.resumed')) })}
          />
        </div>
      </ModalFooter>

      {view ? (
        <ConfirmDialog
          open={confirmSignOut}
          onOpenChange={setConfirmSignOut}
          title={t('signOut.title')}
          description={t('signOut.description')}
          confirmLabel={t('signOut.confirm')}
          confirmVariant="destructive"
          isPending={actions.signOut.isPending}
          onConfirm={() =>
            actions.signOut.mutate(view, {
              onSuccess: () => {
                setConfirmSignOut(false);
                successToast(t('toast.signedOut'));
              },
              onError: (error: Error) => errorToast(error.message || t('changeFailed')),
            })
          }
        />
      ) : null}
    </>
  );
}

function Header({ title, status }: { title: string; status: ReactNode }) {
  return (
    <ModalHeader className="pr-12">
      <ModalTitle>{title}</ModalTitle>
      {status ? <ModalDescription className="flex min-w-0 items-center gap-1.5 text-xs">{status}</ModalDescription> : null}
    </ModalHeader>
  );
}

function StatusLine({ phase, word }: { phase: CapturePhase; word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[phase] ?? 'bg-muted-foreground')} />
      <span>{word}</span>
    </span>
  );
}

/** One primary action per phase. */
function PrimaryAction({
  phase,
  pausedByProject,
  busy,
  onStart,
  onPause,
  onResume,
}: {
  phase: CapturePhase;
  pausedByProject: boolean;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const t = useTranslations('capture.dialog');
  const pending = busy ? <Loading className="size-4 shrink-0" /> : null;
  switch (phase) {
    case 'off':
      return <Button onClick={onStart}>{t('actions.start')}</Button>;
    case 'turningOn':
      return (
        <Button disabled>
          <Loading className="size-4 shrink-0" />
          {t('actions.starting')}
        </Button>
      );
    case 'signInRequired':
      return <Button onClick={onStart}>{t('actions.signInAgain')}</Button>;
    case 'error':
      return <Button onClick={onStart}>{t('actions.tryAgain')}</Button>;
    case 'paused':
      return pausedByProject ? null : (
        <Button disabled={busy} onClick={onResume}>
          {pending}
          {t('actions.resume')}
        </Button>
      );
    case 'recording':
    case 'starting':
      return (
        <Button variant="secondary" disabled={busy} onClick={onPause}>
          {pending}
          {t('actions.pause')}
        </Button>
      );
    default:
      return null;
  }
}

function MoreMenu({ canStop, onStop, onSignOut }: { canStop: boolean; onStop: () => void; onSignOut: () => void }) {
  const t = useTranslations('capture.dialog');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('actions.more')}>
          <DotsThreeIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onSelect={() => void desktopCaptureOpenLogs().catch((error: Error) => errorToast(error.message))}>
          {t('actions.showLogs')}
        </DropdownMenuItem>
        {canStop ? <DropdownMenuItem onSelect={onStop}>{t('actions.stop')}</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          {t('actions.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
