'use client';

import type { CaptureDevice, ProjectAccessMember } from '@kortix/sdk';
import { useRevokeCaptureDevice, useSyncCaptureDevice } from '@kortix/sdk/react';
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  LaptopIcon,
  ProhibitIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl } from '@/lib/desktop';
import { cn } from '@/lib/utils';

import { relativeTime } from '../capture-time';
import { deviceStatus, type DeviceStatusView } from '../devices/device-status';
import { useCaptureAccountId } from '../use-capture-viewer';

/** The status dot: green records, orange needs a person, no hue is idle. */
export function StatusDot({
  view,
  className,
}: {
  view: DeviceStatusView | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        view?.tone === 'green'
          ? 'bg-kortix-green'
          : view?.tone === 'orange'
            ? 'bg-kortix-orange'
            : 'bg-muted-foreground',
        className,
      )}
    />
  );
}

/** "Recording", "Needs permission · Screen Recording", "Offline · 3 min ago". */
export function useStatusText() {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  return (view: DeviceStatusView) => {
    const label = t(`status.${view.key}`);
    if (view.key === 'permission' && view.missingPermissions.length > 0) {
      const names = view.missingPermissions.map((p) =>
        ['screen_recording', 'accessibility', 'microphone'].includes(p) ? t(`permission.${p}`) : p,
      );
      return `${label} · ${names.join(', ')}`;
    }
    if (view.key === 'offline' && view.reportedAtMs)
      return `${label} · ${relativeTime(view.reportedAtMs, locale)}`;
    if (view.key === 'paused' && view.pausedUntilMs) {
      return `${label} · ${new Date(view.pausedUntilMs).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
    }
    return label;
  };
}

function DeviceRowMenu({
  projectId,
  device,
  name,
  onRevoke,
}: {
  projectId: string;
  device: CaptureDevice;
  name: string;
  onRevoke: () => void;
}) {
  const accountId = useCaptureAccountId(projectId);
  const t = useTranslations('capture.devices');
  const sync = useSyncCaptureDevice(accountId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={t('actionsFor', { name })}>
          <DotsThreeIcon className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={() =>
            sync.mutate(device.device_id, {
              onSuccess: (result) => successToast(t('synced', { count: result.enqueued })),
              onError: () => errorToast(t('syncFailed')),
            })
          }
        >
          <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
          {t('syncNow')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
          <ProhibitIcon className="size-3.5 shrink-0" />
          {t('revoke')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Whose timeline, which computer. The trigger always shows the device's live
 * status. Managers pick a person first; each device row carries Sync now and
 * Revoke device; the footer connects another computer.
 */
export function DevicePicker({
  projectId,
  devices,
  device,
  nameOf,
  onPick,
  isManager,
  members,
  viewerId,
  userId,
  onPickUser,
  canRecordHere,
  onRecordHere,
}: {
  projectId: string;
  devices: readonly CaptureDevice[];
  device: CaptureDevice | null;
  nameOf: (device: CaptureDevice) => string;
  onPick: (deviceId: string) => void;
  isManager: boolean;
  members: readonly ProjectAccessMember[];
  viewerId: string | null;
  userId: string | undefined;
  onPickUser: (userId: string | null) => void;
  canRecordHere: boolean;
  onRecordHere: () => void;
}) {
  const accountId = useCaptureAccountId(projectId);
  const t = useTranslations('capture.timeline');
  const tDevices = useTranslations('capture.devices');
  const statusText = useStatusText();
  const revoke = useRevokeCaptureDevice(accountId);
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState<CaptureDevice | null>(null);
  const view = device ? deviceStatus(device) : null;
  const person = userId
    ? (members.find((m) => m.user_id === userId)?.email ?? tDevices('member'))
    : null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="max-w-full min-w-0 gap-2"
            aria-label={t('picker.label')}
          >
            <StatusDot view={view} />
            <span className="min-w-0 truncate">
              {person ? `${person} · ` : ''}
              {device ? nameOf(device) : t('picker.noDevice')}
            </span>
            <CaretDownIcon className="text-muted-foreground size-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-1">
          {isManager ? (
            <div className="px-2 pt-1.5 pb-2">
              <Select
                value={userId ?? 'me'}
                onValueChange={(value) => onPickUser(value === 'me' ? null : value)}
              >
                <SelectTrigger aria-label={t('person')} className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">{t('you')}</SelectItem>
                  {members
                    .filter((member) => member.user_id !== viewerId)
                    .map((member) => (
                      <SelectItem key={member.user_id} value={member.user_id}>
                        {member.email ?? member.user_id}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <ul aria-label={t('picker.devices')} className="max-h-72 overflow-y-auto">
            {devices.length === 0 ? (
              <li className="text-muted-foreground px-2 py-3 text-xs">
                {userId ? t('picker.noneMember') : t('picker.none')}
              </li>
            ) : (
              devices.map((d) => {
                const v = deviceStatus(d);
                const name = nameOf(d);
                const selected = d.device_id === device?.device_id;
                return (
                  <li key={d.device_id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        onPick(d.device_id);
                        setOpen(false);
                      }}
                      aria-current={selected || undefined}
                      className={cn(
                        'hover:bg-hover flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors',
                        selected && 'bg-active',
                      )}
                    >
                      <StatusDot view={v} />
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm">{name}</span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {statusText(v)}
                        </span>
                      </span>
                      {selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                    </button>
                    <DeviceRowMenu
                      projectId={projectId}
                      device={d}
                      name={name}
                      onRevoke={() => setRevoking(d)}
                    />
                  </li>
                );
              })
            )}
          </ul>
          {!userId ? (
            <div className="mt-1 space-y-1 border-t px-1 pt-1.5 pb-1">
              {canRecordHere ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={onRecordHere}
                >
                  <LaptopIcon className="size-3.5 shrink-0" />
                  {tDevices('recordThisComputer')}
                </Button>
              ) : null}
              {!canRecordHere ? (
                <Button asChild variant="ghost" size="sm" className="w-full justify-start gap-2">
                  <Link
                    href={desktopDownloadUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    prefetch={false}
                  >
                    <DownloadSimpleIcon className="size-3.5 shrink-0" />
                    {t('picker.getDesktop')}
                  </Link>
                </Button>
              ) : null}
              <p className="text-muted-foreground px-2 pt-1 text-xs text-pretty">
                {t('auditNotice')}
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground mt-1 border-t px-2 pt-2 pb-1.5 text-xs text-pretty">
              {t('viewingMemberAudit')}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(next) => (next ? null : setRevoking(null))}
        title={tDevices('revokeTitle')}
        description={tDevices('revokeDescription', { name: revoking ? nameOf(revoking) : '' })}
        confirmLabel={tDevices('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.device_id, {
            onSuccess: () => {
              successToast(tDevices('revoked'));
              setRevoking(null);
            },
            onError: () => errorToast(tDevices('revokeFailed')),
          })
        }
      />
    </>
  );
}
