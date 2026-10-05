'use client';

import { useCaptureDays, useCaptureDevices, useCapturePeople } from '@kortix/sdk/react';
import { ChatCircleIcon, DesktopIcon, LaptopIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CapturePage } from '../area/capture-area-shell';
import { captureHref, useCaptureArea, useCaptureRange } from '../area/use-capture-area';
import { durationParts, localTimeZone } from '../capture-time';
import { deviceStatus } from '../devices/device-status';

/**
 * Overview (`/capture/[accountId]`): what the organization recorded in the
 * header's date range, and where to go next. Admins and viewers see everyone;
 * a member sees their own computers.
 */
export function OverviewView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.overview');
  const tCapture = useTranslations('capture');
  const locale = useLocale();
  const area = useCaptureArea(accountId);
  const range = useCaptureRange();
  const everyone = area.readsEveryone;
  const devicesQuery = useCaptureDevices(accountId, { scope: everyone ? 'account' : 'mine' });
  const devices = (devicesQuery.data?.devices ?? []).filter((device) => !device.revoked_at);
  const people = useCapturePeople(accountId, everyone ? range.window : null);
  const ownDays = useCaptureDays(accountId, { tz: localTimeZone() });

  const from = Date.parse(range.window.from);
  const to = Date.parse(range.window.to);
  const seconds = everyone
    ? (people.data?.people ?? []).reduce((sum, person) => sum + person.active_seconds, 0)
    : (ownDays.data?.days ?? [])
        .filter((day) => Date.parse(day.end_at) >= from && Date.parse(day.start_at) < to)
        .reduce((sum, day) => sum + day.screen_seconds, 0);
  const statuses = devices.map(deviceStatus);
  const online = statuses.filter((s) => s.key !== 'offline' && s.key !== 'unknown').length;
  const needPermission = statuses.filter((s) => s.key === 'permission').length;
  const recordingPeople = new Set(
    devices.filter((_, i) => statuses[i]!.key === 'recording').map((device) => device.user_id),
  ).size;
  const peopleWithDevices = new Set(devices.map((device) => device.user_id)).size;
  const hours = (value: number) => {
    const parts = durationParts(value);
    return parts.hours > 0
      ? tCapture('duration.hoursMinutes', parts)
      : tCapture('duration.minutes', parts);
  };
  const span = `${new Date(from).toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${new Date(to - 1).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;
  const loading = devicesQuery.isLoading || (everyone ? people.isLoading : ownDays.isLoading);

  return (
    <CapturePage
      title={t('title')}
      description={
        everyone
          ? t('descriptionAll', { people: peopleWithDevices, devices: devices.length, name: area.accountName, span })
          : t('descriptionMine', { devices: devices.length, span })
      }
    >
      <section aria-label={t('totals')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label={t('hoursRecorded')} loading={loading} value={hours(seconds)} />
        {everyone ? (
          <Tile
            label={t('peopleRecording')}
            loading={loading}
            value={
              <>
                {recordingPeople}
                <span className="text-muted-foreground text-base font-medium"> {t('of', { total: peopleWithDevices })}</span>
              </>
            }
            note={t('peopleNote', { count: peopleWithDevices - recordingPeople })}
          />
        ) : null}
        <Tile
          label={t('devicesOnline')}
          loading={loading}
          value={
            <>
              {online}
              <span className="text-muted-foreground text-base font-medium"> {t('of', { total: devices.length })}</span>
            </>
          }
          note={
            needPermission > 0 ? (
              <Link href={captureHref(accountId, 'devices')} className="text-kortix-blue hover:underline">
                {t('needPermission', { count: needPermission })}
              </Link>
            ) : (
              t('allPermissions')
            )
          }
        />
      </section>

      <section aria-labelledby="capture-quick-links" className="bg-background flex flex-col rounded-md border lg:max-w-md">
        <h2 id="capture-quick-links" className="text-foreground px-4 pt-4 pb-3 text-sm font-medium">
          {t('quickLinks')}
        </h2>
        <QuickLink
          href={captureHref(accountId, 'ask')}
          icon={<ChatCircleIcon className="size-4 shrink-0" />}
          title={t('linkAsk')}
          hint={t('linkAskHint')}
        />
        <QuickLink
          href={captureHref(accountId, 'devices')}
          icon={<DesktopIcon className="size-4 shrink-0" />}
          title={needPermission > 0 ? t('needPermission', { count: needPermission }) : t('linkDevices')}
          hint={needPermission > 0 ? t('needPermissionHint') : t('linkDevicesHint')}
        />
        <QuickLink
          href={captureHref(accountId, 'this-computer')}
          icon={<LaptopIcon className="size-4 shrink-0" />}
          title={t('linkThisComputer')}
          hint={t('linkThisComputerHint')}
        />
      </section>
    </CapturePage>
  );
}

function Tile({
  label,
  value,
  note,
  loading,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  loading: boolean;
}) {
  return (
    <div className="bg-background flex flex-col gap-1.5 rounded-md border px-4 py-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      {loading ? (
        <Skeleton className="h-8 w-24 rounded-md" />
      ) : (
        <span className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      )}
      {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
    </div>
  );
}

function QuickLink({ href, icon, title, hint }: { href: string; icon: ReactNode; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="hover:bg-hover flex items-center gap-3 border-t px-4 py-3 transition-colors last:rounded-b-md"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </span>
    </Link>
  );
}
