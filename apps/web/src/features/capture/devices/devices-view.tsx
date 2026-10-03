'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useCaptureDevices, useRevokeCaptureDevice, useSyncCaptureDevice } from '@kortix/sdk/react';
import {
  ArrowsClockwiseIcon,
  CircleIcon,
  DotsThreeIcon,
  PlusIcon,
  ProhibitIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '../capture-time';
import { DesktopCaptureModal, useDesktopCaptureStatus } from '../desktop-capture-modal';
import { useCaptureMembers, useCaptureViewer } from '../use-capture-viewer';
import { ConnectDeviceModal } from './connect-device-modal';
import { deviceStatus, type DeviceStatusView } from './device-status';

const TONE_BADGE = { green: 'success', orange: 'warning', none: 'muted' } as const;

function StatusCell({ view }: { view: DeviceStatusView }) {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  const detail =
    view.key === 'permission' && view.missingPermissions.length > 0
      ? t('detail.permission', {
          permissions: view.missingPermissions
            .map((p) =>
              ['screen_recording', 'accessibility', 'microphone'].includes(p)
                ? t(`permission.${p}`)
                : p,
            )
            .join(', '),
        })
      : view.key === 'paused' && view.pausedUntilMs
        ? t('detail.pausedUntil', {
            time: new Date(view.pausedUntilMs).toLocaleString(locale, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })
        : view.key === 'offline' && view.reportedAtMs
          ? t('detail.lastSeen', { time: relativeTime(view.reportedAtMs, locale) })
          : null;
  return (
    <div className="space-y-1">
      <Badge variant={TONE_BADGE[view.tone]} size="sm" className="gap-1.5 normal-case">
        <CircleIcon weight="fill" className="size-2 shrink-0" aria-hidden />
        {t(`status.${view.key}`)}
      </Badge>
      {detail ? <p className="text-muted-foreground text-xs">{detail}</p> : null}
    </div>
  );
}

function DeviceRow({
  projectId,
  device,
  owner,
  onRevoke,
}: {
  projectId: string;
  device: CaptureDevice;
  owner: string | null;
  onRevoke: (device: CaptureDevice) => void;
}) {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  const view = deviceStatus(device);
  return (
    <TableRow>
      <TableCell className="align-middle">
        <p className="text-foreground text-sm font-medium whitespace-normal">
          {device.name ?? t('unnamed')}
        </p>
        <p className="text-muted-foreground text-xs">
          {[[device.os, device.os_version].filter(Boolean).join(' '), device.app_version]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </TableCell>
      {owner !== null ? <TableCell className="align-middle text-sm">{owner}</TableCell> : null}
      <TableCell className="align-middle">
        <StatusCell view={view} />
      </TableCell>
      <TableCell className="align-middle text-xs whitespace-normal">
        {view.layers.map((layer) => t(`layer.${layer}`)).join(' · ')}
      </TableCell>
      <TableCell className="align-middle text-xs whitespace-normal">
        {view.syncFailed
          ? t('sync.failed')
          : view.pending === null
            ? t('sync.unknown')
            : view.pending > 0
              ? t('sync.pending', { count: view.pending })
              : t('sync.upToDate')}
      </TableCell>
      <TableCell className="align-middle text-xs tabular-nums">
        {view.lastFrameMs ? relativeTime(view.lastFrameMs, locale) : t('never')}
      </TableCell>
      <TableCell className="align-middle">
        <DeviceActions projectId={projectId} device={device} onRevoke={onRevoke} />
      </TableCell>
    </TableRow>
  );
}

function DeviceActions({
  projectId,
  device,
  onRevoke,
}: {
  projectId: string;
  device: CaptureDevice;
  onRevoke: (device: CaptureDevice) => void;
}) {
  const t = useTranslations('capture.devices');
  const sync = useSyncCaptureDevice(projectId);
  const name = device.name ?? t('unnamed');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={t('actionsFor', { name })}>
          {sync.isPending ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <DotsThreeIcon className="size-3.5 shrink-0" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
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
        <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(device)}>
          <ProhibitIcon className="size-3.5 shrink-0" />
          {t('revoke')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DevicesView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.devices');
  const viewer = useCaptureViewer(projectId);
  const [scope, setScope] = useState<'mine' | 'project'>('mine');
  const projectScope = viewer.isManager && scope === 'project';
  const devices = useCaptureDevices(projectId, { scope: projectScope ? 'project' : 'mine' });
  const members = useCaptureMembers(projectId, viewer.isManager);
  const revoke = useRevokeCaptureDevice(projectId);
  const [revoking, setRevoking] = useState<CaptureDevice | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  // Inside the Kortix desktop app with its bundled engine: sign this computer in without a browser trip.
  const desktopCapture = useDesktopCaptureStatus();
  const [thisComputerOpen, setThisComputerOpen] = useState(false);

  const rows = (devices.data?.devices ?? []).filter((device) => !device.revoked_at);
  const ownerOf = (device: CaptureDevice) =>
    device.user_id === members.viewerId
      ? t('you')
      : (members.members.find((member) => member.user_id === device.user_id)?.email ?? t('member'));

  const confirmRevoke = () => {
    if (!revoking) return;
    revoke.mutate(revoking.device_id, {
      onSuccess: () => {
        successToast(t('revoked'));
        setRevoking(null);
      },
      onError: () => errorToast(t('revokeFailed')),
    });
  };

  return (
    <CapabilityPageShell
      title={t('title')}
      description={t('description')}
      action={
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          onClick={() => setConnectOpen(true)}
        >
          <PlusIcon className="size-4" />
          {t('connect')}
        </Button>
      }
      filters={
        viewer.isManager ? (
          <Tabs value={scope} onValueChange={(value) => setScope(value as 'mine' | 'project')}>
            <TabsListCompact aria-label={t('scopeLabel')}>
              <TabsTriggerCompact value="mine">{t('scopeMine')}</TabsTriggerCompact>
              <TabsTriggerCompact value="project">{t('scopeProject')}</TabsTriggerCompact>
            </TabsListCompact>
          </Tabs>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {devices.isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-md" />
            ))}
          </div>
        ) : devices.isError ? (
          <ErrorState
            size="sm"
            title={t('loadFailed')}
            action={
              <Button variant="outline" size="sm" onClick={() => devices.refetch()}>
                {t('tryAgain')}
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState size="sm" title={t('empty')} />
        ) : (
          <Table className="overflow-hidden rounded-md">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('column.device')}</TableHead>
                {projectScope ? <TableHead>{t('column.owner')}</TableHead> : null}
                <TableHead>{t('column.status')}</TableHead>
                <TableHead>{t('column.layers')}</TableHead>
                <TableHead>{t('column.sync')}</TableHead>
                <TableHead>{t('column.lastFrame')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('column.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((device) => (
                <DeviceRow
                  key={device.device_id}
                  projectId={projectId}
                  device={device}
                  owner={projectScope ? ownerOf(device) : null}
                  onRevoke={setRevoking}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-muted-foreground text-xs text-pretty">{t('footnote')}</p>
      </div>

      {desktopCapture.data?.available ? (
        <DesktopCaptureModal
          projectId={projectId}
          open={thisComputerOpen}
          onOpenChange={setThisComputerOpen}
        />
      ) : null}
      <ConnectDeviceModal
        open={connectOpen}
        onOpenChange={setConnectOpen}
        projectName={viewer.projectName}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => (open ? null : setRevoking(null))}
        title={t('revokeTitle')}
        description={t('revokeDescription', { name: revoking?.name ?? t('unnamed') })}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revoke.isPending}
        onConfirm={confirmRevoke}
      />
    </CapabilityPageShell>
  );
}
