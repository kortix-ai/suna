'use client';

import type { CaptureRange } from '@kortix/sdk';
import { useCaptureDevices, useCaptureRanges } from '@kortix/sdk/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CaptureSubpageHeader } from '../capture-shell';
import { clockTime, durationParts, lastDaysWindow, shortDate } from '../capture-time';
import { useCaptureMembers, useCaptureParams, useCaptureViewer } from '../use-capture-viewer';

type Period = '7' | '30';
type Source = 'all' | 'saved' | 'detected';

/** A range's state as a person reads it; a processed range needs no badge. */
export function RangeStatusBadge({ status }: { status: CaptureRange['status'] }) {
  const t = useTranslations('capture.ranges');
  if (status === 'processed') return null;
  const variant = status === 'failed' ? 'destructive' : status === 'open' ? 'success' : 'muted';
  return (
    <Badge variant={variant} size="sm" className="normal-case">
      {t(`status.${status}`)}
    </Badge>
  );
}

/** Ranges — detected activity sessions and saved spans, newest first, each opening its outputs. */
export function RangesView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.ranges');
  const tCapture = useTranslations('capture');
  const locale = useLocale();
  const viewer = useCaptureViewer(projectId);
  const params = useCaptureParams();
  const members = useCaptureMembers(projectId, viewer.isManager);
  const userId =
    viewer.isManager && params.user && params.user !== members.viewerId ? params.user : undefined;
  const [period, setPeriod] = useState<Period>('7');
  const [source, setSource] = useState<Source>('all');
  const window = useMemo(() => lastDaysWindow(Number(period)), [period]);
  const ranges = useCaptureRanges(projectId, { ...window, userId });
  const devices = useCaptureDevices(projectId, { userId });
  const deviceName = (id: string | null) =>
    id
      ? (devices.data?.devices.find((device) => device.device_id === id)?.name ?? null)
      : t('allDevices');

  const rows = (ranges.data?.ranges ?? [])
    .filter((range) => source === 'all' || range.source === source)
    .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  const subject = userId ? members.members.find((member) => member.user_id === userId) : null;

  return (
    <>
      <CaptureSubpageHeader projectId={projectId} title={t('title')} />
      <CapabilityPageShell
        title={t('title')}
        description={t('description')}
        filters={
          <>
            <Tabs value={source} onValueChange={(value) => setSource(value as Source)}>
              <TabsListCompact aria-label={t('sourceLabel')}>
                <TabsTriggerCompact value="all">{t('source.all')}</TabsTriggerCompact>
                <TabsTriggerCompact value="saved">{t('source.saved')}</TabsTriggerCompact>
                <TabsTriggerCompact value="detected">{t('source.detected')}</TabsTriggerCompact>
              </TabsListCompact>
            </Tabs>
            <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
              <TabsListCompact aria-label={t('periodLabel')}>
                <TabsTriggerCompact value="7">{t('period.week')}</TabsTriggerCompact>
                <TabsTriggerCompact value="30">{t('period.month')}</TabsTriggerCompact>
              </TabsListCompact>
            </Tabs>
          </>
        }
      >
        <div className="space-y-4">
          {userId ? (
            <InfoBanner
              tone="neutral"
              title={tCapture('timeline.viewingMember', {
                member: subject?.email ?? tCapture('timeline.aMember'),
              })}
            >
              {tCapture('timeline.viewingMemberAudit')}
            </InfoBanner>
          ) : null}
          {ranges.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-md" />
              ))}
            </div>
          ) : ranges.isError ? (
            <ErrorState
              size="sm"
              title={t('loadFailed')}
              action={
                <Button variant="outline" size="sm" onClick={() => ranges.refetch()}>
                  {t('tryAgain')}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState size="sm" title={t('empty')} description={t('emptyHint')} />
          ) : (
            <ul className="space-y-2">
              {rows.map((range) => {
                const start = Date.parse(range.start_at);
                const end = Date.parse(range.end_at);
                const { hours, minutes } = durationParts((end - start) / 1000);
                const span = t('span', {
                  from: clockTime(start, locale),
                  to: clockTime(end, locale),
                });
                return (
                  <li key={range.range_id}>
                    <Link
                      href={`/projects/${projectId}/capture/ranges/${range.range_id}${userId ? `?user=${userId}` : ''}`}
                      className="bg-background hover:bg-hover flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
                    >
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="text-foreground block truncate text-sm font-medium">
                          {range.title ?? span}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs tabular-nums">
                          {[
                            shortDate(start, locale),
                            range.title ? span : null,
                            hours > 0
                              ? tCapture('duration.hoursMinutes', { hours, minutes })
                              : tCapture('duration.minutes', { minutes }),
                            deviceName(range.device_id),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <Badge variant="outline" size="sm" className="normal-case">
                        {t(`source.${range.source}`)}
                      </Badge>
                      <RangeStatusBadge status={range.status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CapabilityPageShell>
    </>
  );
}
