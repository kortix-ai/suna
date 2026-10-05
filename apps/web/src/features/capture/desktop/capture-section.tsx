'use client';

import { CursorClickIcon, DotsThreeIcon, MicrophoneIcon, MonitorIcon, WarningIcon, type Icon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

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
import Loading from '@/components/ui/loading';
import { ModalBody, ModalFooter } from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { ComputerRow, ComputerSection, type StatusTone } from '@/features/tunnel/computer-rows';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { desktopCaptureOpenLogs, desktopCaptureSignInCancel, type DesktopCaptureLayer, type DesktopCaptureStatus } from '@/lib/desktop';

import { CapturePermissions } from './capture-permissions';
import { CAPTURE_LAYERS, activeLayers, capturePhase, type CapturePhase } from './capture-state';
import { useCaptureProject, useDesktopCaptureActions, useDesktopCaptureStatus } from './use-desktop-capture';

const LAYER_ICONS: Record<DesktopCaptureLayer, Icon> = { screen: MonitorIcon, actions: CursorClickIcon, audio: MicrophoneIcon };

const TONES: Partial<Record<CapturePhase, StatusTone>> = {
  recording: 'good',
  needsPermission: 'attention',
  signInRequired: 'attention',
  paused: 'attention',
  error: 'bad',
};

/**
 * My Capture in "Your computer": shown when this desktop app bundles the
 * engine and the project has its `capture` flag on. `visible` gates the tab;
 * `tone` and `word` are the header's Capture status.
 */
export function useMyCapture(projectId: string, { poll = false }: { poll?: boolean } = {}) {
  const t = useTranslations('capture.dialog');
  const locale = useLocale();
  const status = useDesktopCaptureStatus({ poll });
  const { project, loading } = useCaptureProject(projectId);
  const view = status.data ?? null;
  // The last status read is "now", so render stays pure.
  const now = status.dataUpdatedAt;
  const phase = capturePhase(view, { now, projectId, projectHasCapture: Boolean(project) });
  const visible = !loading && Boolean(view?.available) && Boolean(project);
  const pausedUntil =
    view?.pausedUntilMs && view.pausedUntilMs > now
      ? new Date(view.pausedUntilMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : null;
  const word =
    phase !== 'paused'
      ? t(`status.${phase}`)
      : view?.policy?.paused
        ? t('status.pausedByProject')
        : pausedUntil
          ? t('status.pausedUntil', { time: pausedUntil })
          : t('status.paused');
  return { visible, phase, tone: TONES[phase] ?? ('idle' as StatusTone), word };
}

/**
 * The My Capture section's body and footer. One phase at a time
 * (capture-state.ts), one primary action per phase. Turning it on is the
 * engine's own device sign-in; it never pairs the computer agent.
 */
export function CaptureSection({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const t = useTranslations('capture.dialog');
  const status = useDesktopCaptureStatus({ poll: true });
  const { project } = useCaptureProject(projectId);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const actions = useDesktopCaptureActions(projectId, { onWaitingOnPage: () => setWaitingOnPage(true) });
  const view = status.data ?? null;
  const now = status.dataUpdatedAt;
  const phase = capturePhase(view, {
    now,
    projectId,
    projectHasCapture: Boolean(project),
    turningOn: actions.turnOn.isPending,
    failed: actions.turnOn.isError,
  });

  const turnOn = () => {
    if (!view) return;
    actions.turnOn.reset();
    actions.turnOn.mutate(view, {
      onSuccess: () => successToast(t('toast.started')),
      onSettled: () => setWaitingOnPage(false),
    });
  };

  if (status.isPending) {
    return (
      <ModalBody>
        <Loading className="size-4 shrink-0" />
      </ModalBody>
    );
  }
  if (!view || phase === 'unavailable' || phase === 'projectOff') {
    return (
      <ModalBody>
        <p className="text-muted-foreground text-sm text-pretty">{phase === 'projectOff' ? t('projectOff') : view?.error || t('unavailable')}</p>
      </ModalBody>
    );
  }

  const projectName = project?.name ?? '';
  const on = phase === 'needsPermission' || phase === 'paused' || phase === 'starting' || phase === 'recording';
  const recording = activeLayers(view);

  return (
    <>
      <ModalBody className="min-h-0 space-y-5 overflow-y-auto">
        {phase === 'signInRequired' ? (
          <InfoBanner tone="warning" icon={WarningIcon} title={t('signInRequired.title')}>
            {t('signInRequired.hint')}
          </InfoBanner>
        ) : null}
        {phase === 'error' ? (
          <InfoBanner tone="destructive" icon={WarningIcon} title={t('error.title')}>
            {actions.turnOn.error?.message || view.error || t('error.fallback')}
          </InfoBanner>
        ) : null}

        {/* One line that says what happens now, and the one next step. */}
        {phase === 'turningOn' ? (
          <p className="flex items-center gap-2 text-sm" role="status">
            <Loading className="size-4 shrink-0" />
            {waitingOnPage ? t('turningOn.waitingOnPage') : t('turningOn.progress', { project: projectName })}
          </p>
        ) : phase === 'paused' && view.policy?.paused ? (
          <p className="text-muted-foreground text-sm text-pretty">{t('pausedByProjectHint')}</p>
        ) : on && recording.length === 0 ? (
          <p className="text-muted-foreground text-sm text-pretty">{t('noLayers')}</p>
        ) : !on ? (
          <p className="text-muted-foreground text-sm text-pretty">
            {phase === 'off' && view.signedIn && view.projectId !== projectId ? t('otherProject') : t('intro', { project: projectName })}
          </p>
        ) : null}

        {/* Stays once shown, so each row turns "Allowed" in place as macOS answers. */}
        {on ? (
          <CapturePermissions
            view={view}
            requesting={actions.grants.isPending}
            onAllow={() => actions.grants.mutate({ audio: Boolean(view.layers?.audio), actions: Boolean(view.layers?.actions) })}
          />
        ) : null}

        <ComputerSection title={t('layersTitle')}>
          {CAPTURE_LAYERS.map((layer) => {
            const blocked = view.policy?.layers[layer] === false;
            return (
              <ComputerRow
                key={layer}
                icon={LAYER_ICONS[layer]}
                title={t(`layers.${layer}`)}
                description={blocked ? t('layerOffByPolicy') : t(`layers.${layer}Description`)}
                muted={blocked}
                trailing={
                  <Switch
                    checked={!blocked && Boolean(view.layers?.[layer])}
                    disabled={blocked || actions.set.isPending || phase === 'turningOn'}
                    onCheckedChange={(value) => actions.set.mutate({ [layer]: value })}
                    aria-label={t(`layers.${layer}`)}
                  />
                }
              />
            );
          })}
        </ComputerSection>

        {view.policy?.notice && (on || phase === 'signInRequired') ? (
          <section className="space-y-1">
            <p className="text-muted-foreground text-xs">{t('notice', { project: projectName })}</p>
            <p className="text-sm text-pretty">{view.policy.notice}</p>
          </section>
        ) : null}
      </ModalBody>

      <ModalFooter className="border-t py-3 sm:justify-between">
        <div className="flex items-center gap-1">
          {view.signedIn || view.signInRequired ? (
            <MoreMenu
              canStop={on}
              onStop={() => actions.set.mutate({ on: false }, { onSuccess: () => successToast(t('toast.stopped')) })}
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
          <Button variant="outline" asChild>
            <Link href={`/projects/${projectId}/capture`} onClick={onClose}>
              {t('actions.openTimeline')}
            </Link>
          </Button>
          <PrimaryAction
            phase={phase}
            pausedByProject={Boolean(view.policy?.paused)}
            busy={actions.pause.isPending || actions.resume.isPending}
            onStart={turnOn}
            onPause={() => actions.pause.mutate(undefined, { onSuccess: () => successToast(t('toast.paused')) })}
            onResume={() => actions.resume.mutate(undefined, { onSuccess: () => successToast(t('toast.resumed')) })}
          />
        </div>
      </ModalFooter>

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
          })
        }
      />
    </>
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
