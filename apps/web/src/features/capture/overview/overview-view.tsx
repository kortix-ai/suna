'use client';

import type { CaptureWorkflowSummary } from '@kortix/sdk';
import { useCaptureOverview } from '@kortix/sdk/react';
import {
  CheckIcon,
  DesktopIcon,
  DownloadSimpleIcon,
  PlugsConnectedIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CaptureAgentModal } from '../agent/capture-agent-modal';
import { CapturePage } from '../area/capture-area-shell';
import { captureHref, useCaptureArea, useCaptureRange } from '../area/use-capture-area';
import { ExportModal } from '../intelligence/export-modal';
import {
  LearningState,
  ShareBar,
  WorkflowStatusBadge,
  useHours,
  usePercent,
  useRunDuration,
} from '../intelligence/workflow-ui';

/**
 * Overview (`/capture/[accountId]`), Capture admins and viewers: what the
 * organization recorded in the header's date range, the workflows worth
 * automating, what is new, and how automatable time grows. A member has no
 * overview: the page sends them to their own devices.
 */
export function OverviewView({ accountId }: { accountId: string }) {
  const area = useCaptureArea(accountId);
  const router = useRouter();
  const member = area.role === 'member';
  useEffect(() => {
    if (member) router.replace(captureHref(accountId, 'devices'));
  }, [member, accountId, router]);
  if (member || !area.role) return null;
  return <Overview accountId={accountId} />;
}

function Overview({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.overview');
  const locale = useLocale();
  const area = useCaptureArea(accountId);
  const range = useCaptureRange();
  const overview = useCaptureOverview(accountId, range.window);
  const hours = useHours();
  const percent = usePercent();
  const [exportOpen, setExportOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const data = overview.data;
  const span = `${new Date(range.window.from).toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${new Date(Date.parse(range.window.to) - 1).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;
  const change =
    data && data.hours_recorded_previous > 0
      ? (data.hours_recorded - data.hours_recorded_previous) / data.hours_recorded_previous
      : null;
  const top = data?.top_opportunities ?? [];
  const topSum = top.reduce((sum, w) => sum + w.automation_hours_per_week, 0);

  return (
    <CapturePage
      title={t('title')}
      description={
        data
          ? t('description', {
              people: data.people.total,
              devices: data.devices.total,
              name: area.accountName,
              span,
            })
          : null
      }
    >
      {overview.isError ? (
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => overview.refetch()}>
              {t('tryAgain')}
            </Button>
          }
        />
      ) : (
        <>
          <section aria-label={t('totals')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile
              label={t('hoursRecorded')}
              value={data ? t('hoursValue', { hours: hours(data.hours_recorded) }) : null}
              note={
                !data
                  ? null
                  : change === null
                    ? t('noPrevious')
                    : t('changeOnPrevious', {
                        change: `${change >= 0 ? '+' : ''}${percent(change)}`,
                        days: range.days,
                      })
              }
            />
            <Tile
              label={t('peopleRecording')}
              value={
                data ? <Fraction value={data.people.recording} total={data.people.total} /> : null
              }
              note={
                data ? t('peopleNote', { count: data.people.total - data.people.recording }) : null
              }
            />
            <Tile
              label={t('devicesOnline')}
              value={
                data ? <Fraction value={data.devices.online} total={data.devices.total} /> : null
              }
              note={
                !data ? null : data.devices.needs_permission > 0 ? (
                  <Link
                    href={captureHref(accountId, 'devices')}
                    className="text-foreground underline-offset-4 hover:underline"
                  >
                    {t('needPermission', { count: data.devices.needs_permission })}
                  </Link>
                ) : (
                  t('allPermissions')
                )
              }
            />
            <Tile
              label={t('automatable')}
              value={data ? t('perWeek', { hours: hours(data.automation_hours_per_week) }) : null}
              note={data ? t('acrossWorkflows', { count: data.workflows.total }) : null}
            />
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section
              aria-labelledby="capture-top"
              className="bg-background flex min-w-0 flex-col rounded-md border"
            >
              <PanelHeader
                id="capture-top"
                title={t('topTitle')}
                hint={t('topHint')}
                link={<Link href={captureHref(accountId, 'workflows')}>{t('allWorkflows')}</Link>}
              />
              {!data ? (
                <RowsSkeleton />
              ) : top.length === 0 ? (
                <div className="border-t px-4 py-10">
                  <LearningState hoursRecorded={data.hours_recorded} />
                </div>
              ) : (
                <>
                  <OpportunityTable accountId={accountId} rows={top} />
                  <p className="text-muted-foreground border-t px-4 py-3 text-xs">
                    {t('topFooter', {
                      count: top.length,
                      hours: hours(topSum),
                      more: Math.max(0, data.workflows.total - top.length),
                    })}
                  </p>
                </>
              )}
            </section>

            <section
              aria-labelledby="capture-new"
              className="bg-background flex min-w-0 flex-col rounded-md border"
            >
              <PanelHeader
                id="capture-new"
                title={t('newTitle')}
                link={
                  data && data.new_this_week.length > 0 ? (
                    <Link href={`${captureHref(accountId, 'workflows')}?sort=newest`}>
                      {t('viewAll', { count: data.new_this_week.length })}
                    </Link>
                  ) : null
                }
              />
              {!data ? (
                <RowsSkeleton />
              ) : data.new_this_week.length === 0 ? (
                <p className="text-muted-foreground border-t px-4 py-6 text-center text-xs">
                  {t('newEmpty')}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {data.new_this_week.map((w) => (
                    <li key={w.workflow_id} className="border-t">
                      <Link
                        href={captureHref(accountId, 'workflows', `/${w.workflow_id}`)}
                        className="hover:bg-hover flex flex-col gap-0.5 px-4 py-3 transition-colors"
                      >
                        <span className="flex justify-between gap-3">
                          <span className="text-foreground text-sm font-medium">{w.name}</span>
                          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                            {t('perWeekShort', { hours: hours(w.automation_hours_per_week) })}
                          </span>
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {t('newMeta', {
                            day: w.first_seen_at
                              ? new Date(w.first_seen_at).toLocaleDateString(locale, {
                                  weekday: 'short',
                                })
                              : '–',
                            people: w.people_count,
                            runs: w.runs_total,
                          })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section
              aria-labelledby="capture-trend"
              className="bg-background flex min-w-0 flex-col gap-4 rounded-md border px-4 py-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <h2 id="capture-trend" className="text-foreground text-sm font-medium">
                    {t('trendTitle')}
                  </h2>
                  <p className="text-muted-foreground text-xs">{t('trendHint')}</p>
                </div>
                {data ? (
                  <span className="text-foreground text-xs font-medium tabular-nums">
                    {t('trendNow', { hours: hours(data.automation_hours_per_week) })}
                  </span>
                ) : null}
              </div>
              {data ? <Trend points={data.trend} /> : <Skeleton className="h-44 rounded-md" />}
            </section>

            <section
              aria-labelledby="capture-links"
              className="bg-background flex min-w-0 flex-col rounded-md border"
            >
              <h2 id="capture-links" className="text-foreground px-4 pt-4 pb-3 text-sm font-medium">
                {t('quickLinks')}
              </h2>
              {data && data.workflows.detected > 0 ? (
                <QuickLink
                  href={`${captureHref(accountId, 'workflows')}?status=detected`}
                  icon={<CheckIcon className="size-4 shrink-0" />}
                  title={t('linkReview', { count: data.workflows.detected })}
                  hint={t('linkReviewHint')}
                />
              ) : null}
              <QuickLink
                href={captureHref(accountId, 'devices')}
                icon={<DesktopIcon className="size-4 shrink-0" />}
                title={
                  data && data.devices.needs_permission > 0
                    ? t('needPermission', { count: data.devices.needs_permission })
                    : t('linkDevices')
                }
                hint={
                  data && data.devices.needs_permission > 0
                    ? t('needPermissionHint')
                    : t('linkDevicesHint')
                }
              />
              <button
                type="button"
                onClick={() => setAgentOpen(true)}
                className="hover:bg-hover flex items-center gap-3 border-t px-4 py-3 text-left transition-colors last:rounded-b-md"
              >
                <span className="text-muted-foreground">
                  <PlugsConnectedIcon className="size-4 shrink-0" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground text-sm font-medium">{t('linkAgent')}</span>
                  <span className="text-muted-foreground text-xs">{t('linkAgentHint')}</span>
                </span>
              </button>
              {area.isAdmin ? (
                <button
                  type="button"
                  onClick={() => setExportOpen(true)}
                  className="hover:bg-hover flex items-center gap-3 rounded-b-md border-t px-4 py-3 text-left transition-colors"
                >
                  <span className="text-muted-foreground">
                    <DownloadSimpleIcon className="size-4 shrink-0" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground text-sm font-medium">{t('linkExport')}</span>
                    <span className="text-muted-foreground text-xs">{t('linkExportHint')}</span>
                  </span>
                </button>
              ) : null}
            </section>
          </div>
        </>
      )}
      <CaptureAgentModal
        open={agentOpen}
        onOpenChange={setAgentOpen}
        accountName={area.accountName}
        own={false}
      />
      {area.isAdmin ? (
        <ExportModal
          accountId={accountId}
          open={exportOpen}
          onOpenChange={setExportOpen}
          window={range.window}
        />
      ) : null}
    </CapturePage>
  );
}

function Fraction({ value, total }: { value: number; total: number }) {
  const t = useTranslations('capture.overview');
  return (
    <>
      {value}
      <span className="text-muted-foreground text-base font-medium"> {t('of', { total })}</span>
    </>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode | null;
  note: ReactNode | null;
}) {
  return (
    <div className="bg-background flex flex-col gap-1.5 rounded-md border px-4 py-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      {value === null ? (
        <Skeleton className="h-8 w-24 rounded-md" />
      ) : (
        <span className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </span>
      )}
      <span className="text-muted-foreground min-h-5 text-xs">{note}</span>
    </div>
  );
}

function PanelHeader({
  id,
  title,
  hint,
  link,
}: {
  id: string;
  title: string;
  hint?: string;
  link?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
      <div className="space-y-0.5">
        <h2 id={id} className="text-foreground text-sm font-medium">
          {title}
        </h2>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      {link ? (
        <span className="text-foreground shrink-0 text-xs font-medium underline-offset-4 hover:underline">
          {link}
        </span>
      ) : null}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-2 border-t px-4 py-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-9 rounded-md" />
      ))}
    </div>
  );
}

function OpportunityTable({
  accountId,
  rows,
}: {
  accountId: string;
  rows: readonly CaptureWorkflowSummary[];
}) {
  const t = useTranslations('capture.overview');
  const tw = useTranslations('capture.workflows');
  const duration = useRunDuration();
  const hours = useHours();
  const max = Math.max(...rows.map((r) => r.automation_hours_per_week));
  const grid =
    'grid grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_4.5rem_minmax(7rem,11rem)_7.5rem] items-center gap-3';
  return (
    <div className="overflow-x-auto border-t">
      <div className="min-w-2xl">
        <div className={`${grid} text-muted-foreground border-b px-4 py-2 text-xs`}>
          <span>#</span>
          <span>{tw('col.workflow')}</span>
          <span className="text-right">{tw('col.runs')}</span>
          <span className="text-right">{tw('col.typical')}</span>
          <span>{t('hoursPerWeek')}</span>
          <span>{tw('col.status')}</span>
        </div>
        <ol>
          {rows.map((w, i) => (
            <li key={w.workflow_id} className="border-b last:border-b-0">
              <Link
                href={captureHref(accountId, 'workflows', `/${w.workflow_id}`)}
                className={`${grid} hover:bg-hover px-4 py-3 transition-colors`}
              >
                <span className="text-muted-foreground text-xs tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate text-sm font-medium">{w.name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {tw('appsPeople', { apps: w.apps.join(', '), count: w.people_count })}
                  </span>
                </span>
                <span className="text-right text-sm tabular-nums">
                  {Math.round(w.runs_per_week)}
                </span>
                <span className="text-right text-sm tabular-nums">
                  {duration(w.duration_p50_s)}
                </span>
                <span className="flex items-center gap-2">
                  <ShareBar value={w.automation_hours_per_week} max={max} />
                  <span className="w-8 text-right text-sm font-medium tabular-nums">
                    {hours(w.automation_hours_per_week)}
                  </span>
                </span>
                <span>
                  <WorkflowStatusBadge status={w.status} />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Trend({
  points,
}: {
  points: readonly { week_start: string; automation_hours_per_week: number }[];
}) {
  const t = useTranslations('capture.overview');
  const locale = useLocale();
  const hours = useHours();
  const max = Math.max(0, ...points.map((p) => p.automation_hours_per_week));
  const first = points[0];
  const last = points[points.length - 1];
  if (max === 0) {
    return <p className="text-muted-foreground py-10 text-center text-xs">{t('trendEmpty')}</p>;
  }
  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label={t('trendLabel', {
          from: first ? hours(first.automation_hours_per_week) : '0',
          to: last ? hours(last.automation_hours_per_week) : '0',
        })}
        className="flex h-44 items-end gap-2 border-b"
      >
        {points.map((p, i) => (
          <div key={p.week_start} className="flex h-full flex-1 flex-col justify-end gap-1">
            <span className="text-muted-foreground text-center text-xs tabular-nums max-md:hidden">
              {hours(p.automation_hours_per_week)}
            </span>
            <span
              className={
                i === points.length - 1
                  ? 'bg-foreground rounded-t-sm'
                  : 'bg-muted-foreground/30 rounded-t-sm'
              }
              style={{ height: `${Math.round((p.automation_hours_per_week / max) * 82)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {points.map((p, i) => (
          <span
            key={p.week_start}
            className="text-muted-foreground flex-1 text-center text-xs whitespace-nowrap max-md:hidden"
          >
            {i === points.length - 1
              ? t('thisWeek')
              : new Date(p.week_start).toLocaleDateString(locale, {
                  day: 'numeric',
                  month: 'short',
                })}
          </span>
        ))}
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="hover:bg-hover flex items-center gap-3 border-t px-4 py-3 transition-colors"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-foreground text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </span>
    </Link>
  );
}
