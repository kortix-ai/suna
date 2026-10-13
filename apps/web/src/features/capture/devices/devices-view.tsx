'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useCaptureDevices } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  BuildingsIcon,
  CodeIcon,
  DesktopIcon,
  DownloadSimpleIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

import { relativeTime } from '@/lib/relative-time';
import { CaptureApiModal } from '../api/capture-api-modal';
import { CapturePage } from '../area/capture-area-shell';
import {
  captureHref,
  deviceName,
  deviceOs,
  useCaptureArea,
  useCaptureDirectory,
} from '../area/use-capture-area';
import { deviceStatus, type DeviceStatusKey } from './device-status';
import { DeviceActionsMenu, StatusLabel } from './device-status-ui';
import { RolloutModal, WaitingComputers } from './rollout';

/** Kortix Capture's installers, one per OS (/download/capture/<os> → the newest capture-v* Release). */
const CAPTURE_DOWNLOADS = [
  { os: 'windows', file: '.msi' },
  { os: 'macos', file: '.dmg' },
  { os: 'linux', file: '.deb' },
] as const;

type Scope = 'account' | 'mine';
type Filter = 'all' | 'recording' | 'paused' | 'permission' | 'offline';
const FILTERS: readonly Filter[] = ['all', 'recording', 'paused', 'permission', 'offline'];

/** Which filter a status falls under; `notRecording` and `unknown` count as offline. */
const filterOf = (key: DeviceStatusKey): Exclude<Filter, 'all'> =>
  key === 'locked' || key === 'excluded'
    ? 'paused'
    : key === 'recording' || key === 'paused' || key === 'permission'
      ? key
      : 'offline';

/**
 * Devices: every computer that records into the organization. With
 * `capture.read_all` you switch between all devices and your own; everyone
 * else sees their own.
 * A row opens that device's timeline.
 */
export function DevicesView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.devices');
  const area = useCaptureArea(accountId);
  const [scopePick, setScope] = useState<Scope>('account');
  const scope: Scope = area.readsEveryone ? scopePick : 'mine';
  const [filter, setFilter] = useState<Filter>('all');
  const query = useCaptureDevices(accountId, { scope });
  const devices = useMemo(
    () => (query.data?.devices ?? []).filter((device) => !device.revoked_at),
    [query.data],
  );
  const counts = useMemo(() => {
    const out: Record<Filter, number> = {
      all: 0,
      recording: 0,
      paused: 0,
      permission: 0,
      offline: 0,
    };
    for (const device of devices) {
      out.all += 1;
      out[filterOf(deviceStatus(device).key)] += 1;
    }
    return out;
  }, [devices]);
  const rows = devices.filter(
    (device) => filter === 'all' || filterOf(deviceStatus(device).key) === filter,
  );
  const [apiOpen, setApiOpen] = useState(false);
  const [rolloutOpen, setRolloutOpen] = useState(false);

  return (
    <CapturePage
      title={t('title')}
      description={
        area.readsEveryone ? t('descriptionAll', { name: area.accountName }) : t('descriptionMine')
      }
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1.5"
            onClick={() => setApiOpen(true)}
          >
            <CodeIcon className="size-3.5 shrink-0" />
            {t('apiLink')}
          </Button>
          {/* IT installs Capture on many computers at once with an enrollment token. */}
          {area.canManage ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setRolloutOpen(true)}
            >
              <BuildingsIcon className="size-3.5 shrink-0" />
              {t('rollout')}
            </Button>
          ) : null}
          {/* Kortix Capture is its own app: a person installs it and signs in, or IT rolls it out. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <DownloadSimpleIcon className="size-3.5 shrink-0" />
                {t('getCapture')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {CAPTURE_DOWNLOADS.map(({ os, file }) => (
                <DropdownMenuItem key={os} asChild>
                  <a href={`/download/capture/${os}`}>
                    {t(`download.${os}`)}
                    <span className="text-muted-foreground ml-auto text-xs">{file}</span>
                  </a>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href="/docs/capture#install-kortix-capture" target="_blank" rel="noreferrer">
                  {t('download.guide')}
                  <ArrowSquareOutIcon className="text-muted-foreground ml-auto size-3.5 shrink-0" />
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      {/* One toolbar row in a fixed place: who (everyone or you), then status. */}
      {area.readsEveryone || devices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {area.readsEveryone ? (
            <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
              <TabsList aria-label={t('viewLabel')}>
                <TabsTrigger value="account">{t('viewAll')}</TabsTrigger>
                <TabsTrigger value="mine">{t('viewMine')}</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          {devices.length > 0 ? (
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
        </div>
      ) : null}

      {area.canManage ? <WaitingComputers accountId={accountId} /> : null}

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
        // The header carries the one action; the empty state is the line.
        <div className="py-12">
          <EmptyState
            size="sm"
            title={
              scope === 'account'
                ? t('empty.allTitle', { name: area.accountName })
                : t('empty.mineTitle')
            }
            description={t('empty.body')}
          />
        </div>
      ) : (
        <section aria-label={t('listLabel')} className="flex flex-col gap-3">
          <DeviceTable
            accountId={accountId}
            rows={rows}
            byMember={scope === 'account'}
            withIdleMembers={filter === 'all'}
            canManage={area.canManage}
          />
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noMatch')}</p>
          ) : null}
        </section>
      )}
      <CaptureApiModal
        open={apiOpen}
        onOpenChange={setApiOpen}
        accountId={accountId}
        own={!area.readsEveryone}
      />
      {area.canManage ? (
        <RolloutModal open={rolloutOpen} onOpenChange={setRolloutOpen} accountId={accountId} />
      ) : null}
    </CapturePage>
  );
}

/**
 * One group per member, you first, then by email. With `withIdleMembers`
 * every member of the organization gets a group, so a member who never set up
 * a computer is visible too.
 */
function groupByMember(
  rows: readonly CaptureDevice[],
  memberIds: readonly string[],
  viewerId: string | null,
  emailOf: (userId: string) => string,
) {
  const groups = new Map<string | null, CaptureDevice[]>(memberIds.map((id) => [id, []]));
  for (const device of rows)
    groups.set(device.user_id, [...(groups.get(device.user_id) ?? []), device]);
  // You first, then by email; devices linked to no one last.
  return [...groups.entries()].sort(([a], [b]) =>
    a === null
      ? 1
      : b === null
        ? -1
        : a === viewerId
          ? -1
          : b === viewerId
            ? 1
            : emailOf(a).localeCompare(emailOf(b)),
  );
}

function DeviceTable({
  accountId,
  rows,
  byMember,
  withIdleMembers,
  canManage,
}: {
  accountId: string;
  rows: readonly CaptureDevice[];
  byMember: boolean;
  withIdleMembers: boolean;
  canManage: boolean;
}) {
  const t = useTranslations('capture.devices');
  const people = useCaptureDirectory(accountId, byMember);
  const groups = byMember
    ? groupByMember(
        rows,
        withIdleMembers ? people.members.map((member) => member.user_id) : [],
        people.viewerId,
        (userId) => people.personOf(userId).email ?? '',
      )
    : [[people.viewerId ?? '', [...rows]] as const];
  const columns = 6;
  return (
    <Table className="min-w-4xl">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">{t('col.device')}</TableHead>
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
        {groups.map(([userId, devices]) => {
          const person = people.personOf(userId);
          const label = person.isYou
            ? t('you')
            : person.userId === null
              ? t('unlinked')
              : (person.email ?? t('member'));
          const recording = devices.filter(
            (device) => deviceStatus(device).key === 'recording',
          ).length;
          return (
            <Fragment key={userId ?? 'unlinked'}>
              {byMember ? (
                <TableRow className="bg-card hover:bg-card">
                  <TableCell colSpan={columns} className="pl-4">
                    <span className="flex min-w-0 items-center gap-2">
                      <UserAvatar email={person.email ?? ''} size="xs" />
                      <span className="text-foreground truncate font-medium">{label}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {devices.length === 0
                          ? t('memberNone')
                          : t('memberSummary', { count: devices.length, recording })}
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
              {devices.map((device) => (
                <DeviceRow
                  key={device.device_id}
                  accountId={accountId}
                  device={device}
                  canAct={canManage || device.user_id === people.viewerId}
                  canLink={canManage}
                />
              ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DeviceRow({
  accountId,
  device,
  canAct,
  canLink,
}: {
  accountId: string;
  device: CaptureDevice;
  canAct: boolean;
  /** `capture.manage`: link the device to a person, or unlink it. */
  canLink: boolean;
}) {
  const t = useTranslations('capture.devices');
  const locale = useLocale();
  const view = deviceStatus(device);
  const name = deviceName(device, t('unnamed'));
  return (
    <TableRow className="group relative">
      <TableCell className="pl-4">
        <Link
          href={captureHref(accountId, 'devices', `/${device.device_id}`)}
          className="text-foreground flex items-center gap-2.5 font-medium after:absolute after:inset-0 after:content-['']"
        >
          <DesktopIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{name}</span>
          {device.enrollment_token_id ? (
            <Badge variant="outline" size="xs">
              {t('managedBadge')}
            </Badge>
          ) : null}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{deviceOs(device)}</TableCell>
      <TableCell className="max-w-64">
        <StatusLabel view={view} />
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {view.lastFrameMs ? relativeTime(view.lastFrameMs, locale) : t('never')}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {view.layers.map((layer) => t(`layer.${layer}`)).join(', ')}
        {view.frames ? (
          <span className="block tabular-nums">
            {t('frames', {
              seconds: view.frames.intervalMs / 1000,
              resolution: view.frames.maxHeight >= 2160 ? '4K' : `${view.frames.maxHeight}p`,
            })}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <span className="relative z-10 inline-flex items-center gap-1">
          {canAct ? (
            <DeviceActionsMenu
              accountId={accountId}
              device={device}
              name={name}
              canLink={canLink}
            />
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}
