'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { SettingsRow } from '@/components/ui/settings-row';
import { errorToast } from '@/components/ui/toast';
import { Download } from '@/features/icon/icons/download';
import { useTranslations } from '@/i18n/use-translations';
import {
  desktopCapturePause,
  desktopCaptureRequestPermission,
  desktopCaptureResume,
  desktopCaptureStatus,
  desktopDownloadUrl,
  isDesktop,
  startDownload,
  type DesktopCaptureState,
} from '@/lib/desktop';

const STATE_KEY: Record<DesktopCaptureState, string> = {
  recording: 'stateRecording',
  paused: 'statePaused',
  off: 'stateOff',
  needs_permission: 'stateNeedsPermission',
  blocked: 'stateBlocked',
  error: 'stateError',
};

/** This computer's live recorder, inside the desktop app. A browser gets the install row. */
export function ThisComputer() {
  const t = useTranslations('capture');
  const qc = useQueryClient();
  const desktop = isDesktop();
  const status = useQuery({
    queryKey: ['capture', 'desktop-status'],
    queryFn: desktopCaptureStatus,
    enabled: desktop,
    refetchInterval: 5_000,
  });
  const refresh = (data: unknown) => qc.setQueryData(['capture', 'desktop-status'], data);
  const pause = useMutation({
    mutationFn: () => desktopCapturePause({ minutes: 60 }),
    onSuccess: refresh,
    onError: (e: Error) => errorToast(e.message),
  });
  const resume = useMutation({
    mutationFn: desktopCaptureResume,
    onSuccess: refresh,
    onError: (e: Error) => errorToast(e.message),
  });
  const grant = useMutation({
    mutationFn: desktopCaptureRequestPermission,
    onError: (e: Error) => errorToast(e.message),
  });

  if (!desktop) {
    return (
      <SettingsRow label={t('installTitle')} description={t('installDescription')}>
        <Button size="sm" variant="secondary" onClick={() => startDownload(desktopDownloadUrl())}>
          <Download className="shrink-0" />
          {t('installCta')}
        </Button>
      </SettingsRow>
    );
  }

  const s = status.data;
  const state = s?.state;
  return (
    <SettingsRow
      label={t('thisComputer')}
      description={
        state
          ? `${t(STATE_KEY[state] as never)}${s?.reason ? ` · ${s.reason}` : ''}`
          : t('stateUnknown')
      }
    >
      {state === 'needs_permission' || s?.permissions?.screen === false ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t('grantPermission')}
        </Button>
      ) : null}
      {state === 'paused' ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={resume.isPending}
          onClick={() => resume.mutate()}
        >
          {t('resume')}
        </Button>
      ) : state === 'recording' ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pause.isPending}
          onClick={() => pause.mutate()}
        >
          {t('pauseHour')}
        </Button>
      ) : null}
    </SettingsRow>
  );
}
