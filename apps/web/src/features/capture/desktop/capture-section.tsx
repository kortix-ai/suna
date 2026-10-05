'use client';

import {
  CursorClickIcon,
  DotsThreeIcon,
  MicrophoneIcon,
  MonitorIcon,
  RecordIcon,
  WarningIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

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
import { ModalBody, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  desktopCaptureOpenLogs,
  desktopCaptureSignInCancel,
  type DesktopCaptureLayer,
  type DesktopCaptureStatus,
} from '@/lib/desktop';

import { CapturePermissions } from './capture-permissions';
import { CaptureRow, CaptureRowSection, StatusDot, type StatusTone } from './capture-rows';
import { CAPTURE_LAYERS, activeLayers, capturePhase, type CapturePhase } from './capture-state';
import { useCaptureOrganization, useDesktopCaptureActions, useDesktopCaptureStatus } from './use-desktop-capture';

const LAYER_ICONS: Record<DesktopCaptureLayer, Icon> = {
  screen: MonitorIcon,
  actions: CursorClickIcon,
  audio: MicrophoneIcon,
};

const TONES: Partial<Record<CapturePhase, StatusTone>> = {
  recording: 'good',
  needsPermission: 'attention',
  signInRequired: 'attention',
  paused: 'attention',
  error: 'bad',
};

/**
 * Kortix Capture's "This computer", in the desktop app: records this computer
 * for the person's organization. Its own surface, opened from the app menu
 * and Capture's tray, never from a project or the computer agent's UI. One
 * phase at a time (capture-state.ts), one primary action per phase. Renders
 * the header, body and footer of a `Modal`.
 */
export function CaptureThisComputer({ onClose }: { onClose: () => void }) {
  const t = useTranslations('capture.dialog');
  const locale = useLocale();
  const status = useDesktopCaptureStatus({ poll: true });
  const view = status.data ?? null;
  const org = useCaptureOrganization(view?.projectId);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const actions = useDesktopCaptureActions(org.projectId ?? '', {
    onWaitingOnPage: () => setWaitingOnPage(true),
  });
  // The last status read (every 2 s) is "now", so render stays pure.
  const now = status.dataUpdatedAt;
  const phase = capturePhase(view, {
    now,
    projectId: org.projectId ?? '',
    orgHasCapture: org.enabled,
    turningOn: actions.turnOn.isPending,
    failed: actions.turnOn.isError,
  });

  if (status.isPending || org.loading) {
    return (
      <>
        <Header title={t('title')} />
        <ModalBody>
          <Loading className="size-4 shrink-0" />
        </ModalBody>
      </>
    );
  }

  const pausedUntil =
    view?.pausedUntilMs && view.pausedUntilMs > now
      ? new Date(view.pausedUntilMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : null;
  const word =
    phase !== 'paused'
      ? t(`status.${phase}`)
      : view?.policy?.paused
        ? t('status.pausedByOrg')
        : pausedUntil
          ? t('status.pausedUntil', { time: pausedUntil })
          : t('status.paused');
  const header = (
    <Header
      title={t('title')}
      status={
        <>
          {org.name ? (
            <>
              <span className="truncate">{org.name}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusDot tone={TONES[phase] ?? 'idle'} />
            <span className="text-foreground">{word}</span>
          </span>
        </>
      }
    />
  );

  if (!view || phase === 'unavailable' || phase === 'orgOff') {
    return (
      <>
        {header}
        <ModalBody>
          <p className="text-muted-foreground text-sm text-pretty">
            {phase === 'orgOff' ? t('orgOff', { org: org.name }) : view?.error || t('unavailable')}
          </p>
        </ModalBody>
      </>
    );
  }

  const turnOn = () => {
    actions.turnOn.reset();
    actions.turnOn.mutate(view, {
      onSuccess: () => successToast(t('toast.started')),
      onSettled: () => setWaitingOnPage(false),
    });
  };
  const on = phase === 'needsPermission' || phase === 'paused' || phase === 'starting' || phase === 'recording';
  const recording = activeLayers(view);

  return (
    <>
      {header}
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
            {waitingOnPage ? t('turningOn.waitingOnPage') : t('turningOn.progress', { org: org.name })}
          </p>
        ) : phase === 'paused' && view.policy?.paused ? (
          <p className="text-muted-foreground text-sm text-pretty">{t('pausedByOrgHint', { org: org.name })}</p>
        ) : on && recording.length === 0 ? (
          <p className="text-muted-foreground text-sm text-pretty">{t('noLayers')}</p>
        ) : !on ? (
          <p className="text-muted-foreground text-sm text-pretty">
            {phase === 'off' && view.signedIn && view.projectId !== org.projectId
              ? t('otherOrg', { org: org.name })
              : t('intro', { org: org.name })}
          </p>
        ) : null}

        {/* Stays once shown, so each row turns "Allowed" in place as macOS answers. */}
        {on ? (
          <CapturePermissions
            view={view}
            requesting={actions.grants.isPending}
            onAllow={() =>
              actions.grants.mutate({ audio: Boolean(view.layers?.audio), actions: Boolean(view.layers?.actions) })
            }
          />
        ) : null}

        <CaptureRowSection title={t('layersTitle')}>
          {CAPTURE_LAYERS.map((layer) => {
            const blocked = view.policy?.layers[layer] === false;
            return (
              <CaptureRow
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
        </CaptureRowSection>

        {view.policy?.notice && (on || phase === 'signInRequired') ? (
          <section className="space-y-1">
            <p className="text-muted-foreground text-xs">{t('notice', { org: org.name })}</p>
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
          {org.projectId ? (
            // ponytail: the timeline is project-scoped until the web lane's top-level /capture area lands.
            <Button variant="outline" asChild>
              <Link href={`/projects/${org.projectId}/capture`} onClick={onClose}>
                {t('actions.openTimeline')}
              </Link>
            </Button>
          ) : null}
          <PrimaryAction
            phase={phase}
            pausedByOrg={Boolean(view.policy?.paused)}
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

function Header({ title, status }: { title: string; status?: ReactNode }) {
  return (
    <ModalHeader className="flex-row items-center gap-3 pr-12">
      <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
        <RecordIcon className="size-5" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <ModalTitle className="truncate">{title}</ModalTitle>
        {status ? (
          <ModalDescription className="flex min-w-0 items-center gap-1.5 text-xs">{status}</ModalDescription>
        ) : null}
      </div>
    </ModalHeader>
  );
}

/** One primary action per phase. */
function PrimaryAction({
  phase,
  pausedByOrg,
  busy,
  onStart,
  onPause,
  onResume,
}: {
  phase: CapturePhase;
  pausedByOrg: boolean;
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
      return pausedByOrg ? null : (
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
        <DropdownMenuItem
          onSelect={() => void desktopCaptureOpenLogs().catch((error: Error) => errorToast(error.message))}
        >
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
