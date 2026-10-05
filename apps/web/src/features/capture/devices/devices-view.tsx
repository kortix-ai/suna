'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useCaptureDevices } from '@kortix/sdk/react';
import { DesktopIcon, LaptopIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
} from '@/components/ui/tabs';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop } from '@/lib/desktop';
import { cn } from '@/lib/utils';

import { CapturePage } from '../area/capture-area-shell';
import {
  captureHref,
  deviceName,
  deviceOs,
  useCaptureArea,
  useCapturePeople,
} from '../area/use-capture-area';
import { relativeTime } from '../capture-time';
import { useDesktopCaptureStatus } from '../desktop/use-desktop-capture';
import { deviceStatus, type DeviceStatusKey, type DeviceLayer } from './device-status';
import { DeviceActionsMenu, StatusDot, useStatusNote } from './device-status-ui';

type Scope = 'account' | 'mine';
type Filter = 'all' | 'recording' | 'paused' | 'permission' | 'offline';
const FILTERS: readonly Filter[] = ['all', 'recording', 'paused', 'permission', 'offline'];
const LAYERS: readonly DeviceLayer[] = ['screen', 'actions', 'audio'];

/** Which filter a status falls under; `notRecording` and `unknown` count as offline. */
const filterOf = (key: DeviceStatusKey): Exclude<Filter, 'all'> =>
  key === 'recording' || key === 'paused' || key === 'permission' ? key : 'offline';

/**
 * Devices: every computer that records into the organization. Admins and
 * viewers switch between all devices and their own; members see their own.
 * A row opens that device's timeline.
 */
export function DevicesView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.devices');
  const area = useCaptureArea(accountId);
  const [scopePick, setScope] = useState<Scope>('account');
  const scope: Scope = area.readsEveryone ? scopePick : 'mine';
  const [filter, setFilter] = useState<Filter>('all');
  const query = useCaptureDevices(accountId, { scope });
  const desktop = useDesktopCaptureStatus();
  const thisDeviceId = desktop.data?.deviceId ?? null;
  const devices = useMemo(
    () => (query.data?.devices ?? []).filter((device) => !device.revoked_at),
    [query.data],
  );
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: 0, recording: 0, paused: 0, permission: 0, offline: 0 };
    for (const device of devices) {
      out.all += 1;
      out[filterOf(deviceStatus(device).key)] += 1;
    }
    return out;
  }, [devices]);
  const rows = devices.filter(
    (device) => filter === 'all' || filterOf(deviceStatus(device).key) === filter,
  );
  const onDesktop = isDesktop();

  return (
    <CapturePage
      title={t('title')}
      description={
        scope === 'account'
          ? t('descriptionAll', { name: area.accountName })
          : t('descriptionMine')
      }
      actions={
        <>
          {area.readsEveryone ? (
            <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
              <TabsList aria-label={t('viewLabel')}>
                <TabsTrigger value="account">{t('viewAll')}</TabsTrigger>
                <TabsTrigger value="mine">{t('viewMine')}</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href={captureHref(accountId, 'this-computer')}>
              <LaptopIcon className="size-3.5 shrink-0" />
              {t('thisComputer')}
            </Link>
          </Button>
          <Button asChild size="sm" className="gap-1.5">
            {onDesktop ? (
              <Link href={captureHref(accountId, 'this-computer')}>
                <PlusIcon className="size-3.5 shrink-0" />
                {t('addDevice')}
              </Link>
            ) : (
              <a href={desktopDownloadUrl()} target="_blank" rel="noreferrer">
                <PlusIcon className="size-3.5 shrink-0" />
                {t('addDevice')}
              </a>
            )}
          </Button>
        </>
      }
    >
      {scope === 'account' && devices.length > 0 ? (
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsListCompact aria-label={t('filterLabel')}>
            {FILTERS.map((value) => (
              <TabsTriggerCompact key={value} value={value} className="gap-1.5">
                {t(`filter.${value}`)}
                <span className="text-muted-foreground tabular-nums">{counts[value]}</span>
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2" aria-busy>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-md" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              {t('tryAgain')}
            </Button>
          }
        />
      ) : devices.length === 0 ? (
        <div className="bg-background rounded-md border px-4 py-12">
          <EmptyState
            size="sm"
            title={scope === 'account' ? t('empty.allTitle', { name: area.accountName }) : t('empty.mineTitle')}
            description={t('empty.body')}
            action={
              onDesktop ? (
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <Link href={captureHref(accountId, 'this-computer')}>{t('recordThisComputer')}</Link>
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <a href={desktopDownloadUrl()} target="_blank" rel="noreferrer">
                    {t('getDesktop')}
                  </a>
                </Button>
              )
            }
          />
        </div>
      ) : (
        <section aria-label={t('listLabel')} className="bg-background overflow-hidden rounded-md border">
          <div className="overflow-x-auto">
            <DeviceTable
              accountId={accountId}
              rows={rows}
              showPerson={scope === 'account'}
              canManage={area.isAdmin}
              thisDeviceId={thisDeviceId}
            />
          </div>
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noMatch')}</p>
          ) : null}
          <div className="text-muted-foreground flex flex-wrap justify-between gap-3 border-t px-4 py-3 text-xs">
            <span className="tabular-nums">{t('showing', { shown: rows.length, total: devices.length })}</span>
            <span>{t('layersNote')}</span>
          </div>
        </section>
      )}
    </CapturePage>
  );
}

function DeviceTable({
  accountId,
  rows,
  showPerson,
  canManage,
  thisDeviceId,
}: {
  accountId: string;
  rows: readonly CaptureDevice[];
  showPerson: boolean;
  canManage: boolean;
  thisDeviceId: string | null;
}) {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  const statusNote = useStatusNote();
  const people = useCapturePeople(accountId, showPerson);
  return (
    <Table className="min-w-4xl">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">{t('col.device')}</TableHead>
          {showPerson ? <TableHead>{t('col.person')}</TableHead> : null}
          <TableHead>{t('col.os')}</TableHead>
          <TableHead>{t('col.status')}</TableHead>
          <TableHead>{t('col.lastFrame')}</TableHead>
          <TableHead>{t('col.layers')}</TableHead>
          <TableHead className="pr-4">
            <span className="sr-only">{t('col.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((device) => {
          const view = deviceStatus(device);
          const name = deviceName(device, t('unnamed'));
          const person = people.personOf(device.user_id);
          const href = captureHref(accountId, 'devices', `/${device.device_id}`);
          const note = statusNote(view);
          return (
            <TableRow key={device.device_id} className="group relative">
              <TableCell className="pl-4">
                <Link
                  href={href}
                  className="text-foreground flex items-center gap-2.5 font-medium after:absolute after:inset-0 after:content-['']"
                >
                  <DesktopIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate">{name}</span>
                  {device.device_id === thisDeviceId ? (
                    <Badge variant="outline" size="xs">
                      {t('thisComputerBadge')}
                    </Badge>
                  ) : null}
                </Link>
              </TableCell>
              {showPerson ? (
                <TableCell>
                  <span className="flex min-w-0 items-center gap-2">
                    <UserAvatar email={person.email ?? ''} size="xs" />
                    <span className="truncate">
                      {person.isYou ? t('you') : (person.email ?? t('member'))}
                    </span>
                  </span>
                </TableCell>
              ) : null}
              <TableCell className="text-muted-foreground">{deviceOs(device)}</TableCell>
              <TableCell>
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <StatusDot view={view} />
                    {t(`status.${view.key}`)}
                  </span>
                  {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs tabular-nums">
                {view.lastFrameMs ? relativeTime(view.lastFrameMs, locale) : t('never')}
              </TableCell>
              <TableCell>
                <span className="flex gap-2.5 text-xs font-medium">
                  {LAYERS.map((layer) => {
                    const on = view.layers.includes(layer);
                    return (
                      <span
                        key={layer}
                        className={cn(!on && 'text-muted-foreground line-through')}
                        aria-label={on ? t(`layer.${layer}`) : t('layerOff', { layer: t(`layer.${layer}`) })}
                      >
                        {t(`layer.${layer}`)}
                      </span>
                    );
                  })}
                </span>
              </TableCell>
              <TableCell className="pr-4 text-right">
                <span className="relative z-10 inline-flex items-center gap-1">
                  {canManage ? (
                    <DeviceActionsMenu accountId={accountId} device={device} name={name} />
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
