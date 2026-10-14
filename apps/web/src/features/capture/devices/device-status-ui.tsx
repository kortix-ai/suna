'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useRevokeCaptureDevice } from '@kortix/sdk/react';
import { DotsThreeIcon, LinkIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { errorToast, successToast } from '@/components/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { StatusDot as DsStatusDot } from '@/components/ui/status';
import { relativeTime } from '@/lib/relative-time';

import { clockTime } from '../capture-time';
import type { DeviceStatusView, HealthLine } from './device-status';
import { LinkDeviceModal } from './rollout';

/** The status dot: green records, orange needs a person, a ring is offline, grey is idle. */
export function StatusDot({
  view,
  className,
}: {
  view: DeviceStatusView | null;
  className?: string;
}) {
  return (
    <DsStatusDot
      tone={
        view?.tone === 'green'
          ? 'success'
          : view?.tone === 'orange'
            ? 'warning'
            : view?.tone === 'red'
              ? 'destructive'
              : 'neutral'
      }
      className={cn(
        view?.key === 'offline' &&
          view.tone === 'none' &&
          'border-muted-foreground border bg-transparent',
        className,
      )}
    />
  );
}

/** The detail after a status: missing permissions, when it was last seen, until when it pauses. */
export function useStatusNote() {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  return (view: DeviceStatusView): string => {
    if (view.key === 'permission' && view.missingPermissions.length > 0) {
      return view.missingPermissions
        .map((p) =>
          ['screen_recording', 'accessibility', 'microphone'].includes(p)
            ? t(`permission.${p}`)
            : p,
        )
        .join(', ');
    }
    if (view.key === 'offline' && view.reportedAtMs) return relativeTime(view.reportedAtMs, locale);
    if (view.key === 'paused' && view.pausedUntilMs) {
      return t('pausedUntil', { time: clockTime(view.pausedUntilMs, locale) });
    }
    return '';
  };
}

/**
 * The one status line of a device, wherever it shows: the dot, the word in
 * ink, and the detail (missing permissions, last seen, paused until) muted
 * after it. The word carries the meaning; the dot repeats it.
 */
export function StatusLabel({ view, className }: { view: DeviceStatusView; className?: string }) {
  const t = useTranslations('capture.devices');
  const note = useStatusNote()(view);
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <StatusDot view={view} />
      <span className="text-foreground shrink-0">{t(`status.${view.key}`)}</span>
      {note ? <span className="text-muted-foreground min-w-0 truncate">· {note}</span> : null}
    </span>
  );
}

/**
 * Why the fleet health rules flag a computer, in plain words ("Last frame 12 min
 * ago", "Update to 0.2.0"). At most two reasons; the most urgent first.
 */
export function HealthNote({ lines, className }: { lines: readonly HealthLine[]; className?: string }) {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  if (lines.length === 0) return null;
  const text = lines.slice(0, 2).map((line) =>
    t(`health.${line.code}`, {
      time: line.timeMs ? relativeTime(line.timeMs, locale) : t('never'),
      count: line.count ?? 0,
      version: line.version ?? '',
      current: line.current ?? '',
    }),
  );
  return <span className={cn('text-muted-foreground block truncate text-xs', className)}>{text.join(' · ')}</span>;
}

/** "Recording", "Needs permission · Accessibility", "Offline · 3 min ago". */
export function useStatusText() {
  const t = useTranslations('capture.devices');
  const note = useStatusNote();
  return (view: DeviceStatusView) =>
    [t(`status.${view.key}`), note(view)].filter(Boolean).join(' · ');
}

/** Revoke one device (asks first): your own, or any with `capture.manage`; the API refuses others. */
export function DeviceActionsMenu({
  accountId,
  device,
  name,
  canLink = false,
  onRevoked,
}: {
  accountId: string;
  device: CaptureDevice;
  name: string;
  /** `capture.manage`: link the device to a person, or unlink it. */
  canLink?: boolean;
  onRevoked?: () => void;
}) {
  const t = useTranslations('capture.devices');
  const revoke = useRevokeCaptureDevice(accountId);
  const [confirm, setConfirm] = useState(false);
  const [linking, setLinking] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-base" variant="ghost" aria-label={t('actionsFor', { name })}>
            <DotsThreeIcon className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {canLink ? (
            <DropdownMenuItem onSelect={() => setLinking(true)}>
              <LinkIcon className="size-3.5 shrink-0" />
              {device.user_id ? t('relink') : t('link')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <ProhibitIcon className="size-3.5 shrink-0" />
            {t('revoke')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canLink ? (
        <LinkDeviceModal
          accountId={accountId}
          device={linking ? device : null}
          name={name}
          onClose={() => setLinking(false)}
        />
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('revokeTitle')}
        description={t('revokeDescription', { name })}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(device.device_id, {
            onSuccess: () => {
              successToast(t('revoked'));
              setConfirm(false);
              onRevoked?.();
            },
            onError: () => errorToast(t('revokeFailed')),
          })
        }
      />
    </>
  );
}
