'use client';

import { useCapturePeople } from '@kortix/sdk/react';
import { EyeIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useTranslations } from '@/i18n/use-translations';

import { CaptureSubpageHeader, ManagersOnly } from '../capture-shell';
import { durationParts, lastDaysWindow } from '../capture-time';
import { useCaptureAccountId, useCaptureMembers } from '../use-capture-viewer';

type Period = '1' | '7' | '30';

function PeopleTable({ projectId }: { projectId: string }) {
  const accountId = useCaptureAccountId(projectId);
  const t = useTranslations('capture.people');
  const tCapture = useTranslations('capture');
  const [period, setPeriod] = useState<Period>('7');
  const window = useMemo(() => lastDaysWindow(Number(period)), [period]);
  const people = useCapturePeople(accountId, window);
  const members = useCaptureMembers(projectId, true);

  const rows = useMemo(() => {
    const summaries = new Map(
      (people.data?.people ?? []).map((person) => [person.user_id, person]),
    );
    const known = members.members.map((member) => ({
      userId: member.user_id,
      email: member.email,
      role: member.effective_project_role,
      summary: summaries.get(member.user_id) ?? null,
    }));
    // Someone with capture data who is no longer a member still shows, by id.
    const extra = [...summaries.values()]
      .filter((person) => !members.members.some((member) => member.user_id === person.user_id))
      .map((person) => ({ userId: person.user_id, email: null, role: null, summary: person }));
    return [...known, ...extra].sort(
      (a, b) => (b.summary?.active_seconds ?? 0) - (a.summary?.active_seconds ?? 0),
    );
  }, [people.data, members.members]);
  const max = Math.max(1, ...rows.map((row) => row.summary?.active_seconds ?? 0));
  const format = (seconds: number) => {
    const parts = durationParts(seconds);
    return parts.hours > 0
      ? tCapture('duration.hoursMinutes', parts)
      : tCapture('duration.minutes', parts);
  };

  return (
    <>
      <CaptureSubpageHeader projectId={projectId} title={t('title')} />
      <CapabilityPageShell
        title={t('title')}
        description={t('description')}
        filters={
          <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
            <TabsListCompact aria-label={t('periodLabel')}>
              <TabsTriggerCompact value="1">{t('period.today')}</TabsTriggerCompact>
              <TabsTriggerCompact value="7">{t('period.week')}</TabsTriggerCompact>
              <TabsTriggerCompact value="30">{t('period.month')}</TabsTriggerCompact>
            </TabsListCompact>
          </Tabs>
        }
      >
        <div className="space-y-4">
          <InfoBanner tone="neutral" icon={<EyeIcon />} title={t('auditTitle')}>
            {t('auditBody')}
          </InfoBanner>
          {people.isLoading || members.isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            </div>
          ) : people.isError ? (
            <ErrorState
              size="sm"
              title={t('loadFailed')}
              action={
                <Button variant="outline" size="sm" onClick={() => people.refetch()}>
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
                  <TableHead>{t('column.member')}</TableHead>
                  <TableHead>{t('column.active')}</TableHead>
                  <TableHead>{t('column.apps')}</TableHead>
                  <TableHead>{t('column.ranges')}</TableHead>
                  <TableHead>{t('column.devices')}</TableHead>
                  <TableHead className="w-32">
                    <span className="sr-only">{t('column.open')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const name = row.email ?? t('formerMember');
                  const active = row.summary?.active_seconds ?? 0;
                  return (
                    <TableRow key={row.userId}>
                      <TableCell className="align-middle">
                        <div className="flex items-center gap-3">
                          <UserAvatar email={row.email ?? ''} size="sm" />
                          <div className="min-w-0">
                            <p className="text-foreground truncate text-sm font-medium">
                              {row.userId === members.viewerId ? t('you', { email: name }) : name}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {row.role ? t(`role.${row.role}`) : t('role.none')}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="align-middle">
                        <p className="text-sm tabular-nums">{format(active)}</p>
                        <div
                          className="bg-muted mt-1.5 h-1.5 w-28 overflow-hidden rounded-sm"
                          aria-hidden
                        >
                          <div
                            className="bg-foreground h-full"
                            style={{ width: `${(active / max) * 100}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-56 align-middle text-xs">
                        {(row.summary?.apps ?? [])
                          .slice(0, 3)
                          .map((app) => app.app ?? t('unknownApp'))
                          .join(' · ') || t('noActivity')}
                      </TableCell>
                      <TableCell className="align-middle text-xs tabular-nums">
                        {row.summary?.ranges ?? 0}
                      </TableCell>
                      <TableCell className="align-middle text-xs tabular-nums">
                        {row.summary?.devices ?? 0}
                      </TableCell>
                      <TableCell className="align-middle">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            href={`/projects/${projectId}/capture${row.userId === members.viewerId ? '' : `?user=${row.userId}`}`}
                            aria-label={t('openTimelineOf', { member: name })}
                          >
                            {t('openTimeline')}
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CapabilityPageShell>
    </>
  );
}

/** People — per member: active time, top apps, ranges and devices. Managers only; every read is audited. */
export function PeopleView({ projectId }: { projectId: string }) {
  return (
    <ManagersOnly projectId={projectId}>
      <PeopleTable projectId={projectId} />
    </ManagersOnly>
  );
}
