'use client';

import { approveCaptureDeviceGrant } from '@kortix/sdk';
import { MicrophoneIcon, MonitorIcon, CursorClickIcon, type Icon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopCaptureOpenTimeline,
  desktopCaptureRequestGrants,
  desktopCaptureSet,
  desktopCaptureSignInCancel,
  desktopCaptureSignInFinish,
  desktopCaptureSignInStart,
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

/** The project, when the person can see it and it has the `capture` feature flag on. */
function useCaptureProject(projectId: string | null | undefined) {
  const { sections } = useProjectSelectorData();
  return useMemo(
    () =>
      sections
        .flatMap((section) => section.projects)
        .find((project) => project.project_id === projectId && project.experimental?.capture) ?? null,
    [sections, projectId],
  );
}

/** This desktop can record this computer into `projectId`: the Capture section shows in Your computer. */
export function useCaptureHere(projectId: string): boolean {
  const status = useDesktopCaptureStatus();
  const project = useCaptureProject(projectId);
  return Boolean(status.data?.available && project);
}

type Grant = 'screen' | 'accessibility' | 'microphone';
const GRANTS: readonly { key: Grant; icon: Icon }[] = [
  { key: 'screen', icon: MonitorIcon },
  { key: 'accessibility', icon: CursorClickIcon },
  { key: 'microphone', icon: MicrophoneIcon },
];

/**
 * Capture, inside "Your computer" (desktop app only): when the current
 * project has Capture on, one switch records this computer into it. Turning
 * it on needs no download, browser or code: the desktop app starts the
 * engine's device sign-in and this person approves it with their own session
 * (with this computer's machine id, so the device is this computer
 * everywhere). Then the layers the project policy allows, its notice, and the
 * macOS permissions in the same "Finish setting up" style as Computer Use.
 */
export function ComputerCaptureSection({ projectId }: { projectId: string }) {
  const t = useTranslations('computers.capture');
  const tSetup = useTranslations('computers');
  const queryClient = useQueryClient();
  const status = useDesktopCaptureStatus({ poll: true });
  const project = useCaptureProject(projectId);
  const [waitingOnPage, setWaitingOnPage] = useState(false);
  const [asked, setAsked] = useState(false);

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

  const grants = useMutation({
    retry: false,
    mutationFn: () => desktopCaptureRequestGrants({ audio: Boolean(view?.layers?.audio) }),
    onMutate: () => setAsked(true),
    onSuccess: setStatus,
    onError: (error: Error) => errorToast(error.message || t('changeFailed')),
  });

  const view = status.data;
  if (!view?.available || !project) return null;

  const here = Boolean(view.signedIn && view.projectId === projectId);
  const recording = Boolean(here && view.on);
  const otherProject = view.signedIn && view.projectId && view.projectId !== projectId;
  const busy = change.isPending || signIn.isPending;
  const toggle = (on: boolean) => {
    if (!on) return change.mutate({ on: false });
    if (here) return change.mutate({ on: true });
    signIn.mutate(view.machineId);
  };

  const needed: Grant[] = recording && view.permissions
    ? GRANTS.map(({ key }) => key).filter((key) => (key !== 'microphone' || view.layers?.audio) && !view.permissions?.[key])
    : [];

  return (
    <section className="space-y-2">
      <Label>{t('title')}</Label>
      <SettingsRowGroup>
        <SettingsRow
          label={t('record', { project: project.name })}
          description={signIn.isPending ? t('signingIn') : <CaptureStateLine view={view} here={here} />}
        >
          {busy ? <Loading className="size-4 shrink-0" /> : null}
          <Switch checked={recording} disabled={busy} onCheckedChange={toggle} aria-label={t('record', { project: project.name })} />
        </SettingsRow>
        {recording
          ? LAYERS.map((layer) => {
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
            })
          : null}
      </SettingsRowGroup>

      {otherProject && !recording ? <p className="text-muted-foreground text-xs text-pretty">{t('otherProject')}</p> : null}
      {waitingOnPage ? <p className="text-muted-foreground text-xs">{t('waitingOnPage')}</p> : null}
      {view.signInRequired && view.projectId === projectId ? <InfoBanner tone="warning" title={t('signInRequired')} /> : null}
      {recording && view.policy?.notice ? <InfoBanner title={t('policyNotice')}>{view.policy.notice}</InfoBanner> : null}

      {needed.length > 0 ? (
        <section className="space-y-3 rounded-md border p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{tSetup('setup.title')}</p>
            <p className="text-muted-foreground text-xs text-pretty">{t('setupHint')}</p>
          </div>
          <ul className="divide-border divide-y">
            {GRANTS.filter(({ key }) => needed.includes(key)).map(({ key, icon: GrantIcon }) => (
              <li key={key} className="flex items-center gap-3 py-2.5">
                <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
                  <GrantIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm">{t(`grants.${key}`)}</p>
                  <p className="text-muted-foreground truncate text-xs">{t(`grants.${key}Description`)}</p>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs">{asked ? tSetup('setup.waiting') : tSetup('setup.needed')}</span>
              </li>
            ))}
          </ul>
          <div className="space-y-2">
            <Button className="w-full" disabled={grants.isPending} onClick={() => grants.mutate()}>
              {grants.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tSetup('setup.allowAll')}
            </Button>
            {asked ? <p className="text-muted-foreground text-xs text-pretty">{tSetup('setup.settingsHint')}</p> : null}
          </div>
        </section>
      ) : null}

      {recording ? (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2"
          onClick={() => void desktopCaptureOpenTimeline().catch((error: Error) => errorToast(error.message))}
        >
          {t('openTimeline')}
        </Button>
      ) : null}
    </section>
  );
}

const STATES = ['recording', 'paused', 'permission_missing', 'not_recording', 'starting', 'crashed'];

/** One line: what Capture is doing on this computer for this project. */
function CaptureStateLine({ view, here }: { view: DesktopCaptureStatus; here: boolean }) {
  const t = useTranslations('computers.capture');
  if (!here || !view.on) return <>{t('offHint')}</>;
  const state = view.state && STATES.includes(view.state) ? view.state : 'not_recording';
  const layers = LAYERS.filter((layer) => view.layers?.[layer] && view.policy?.layers[layer] !== false).map((layer) => t(`layers.${layer}`));
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          'inline-block size-2 shrink-0 rounded-full',
          state === 'recording' ? 'bg-kortix-green' : state === 'permission_missing' || state === 'crashed' ? 'bg-kortix-orange' : 'bg-muted-foreground',
        )}
      />
      <span>
        {t(`state.${state}`)}
        {state === 'recording' && layers.length ? ` · ${layers.join(', ')}` : ''}
      </span>
    </span>
  );
}
