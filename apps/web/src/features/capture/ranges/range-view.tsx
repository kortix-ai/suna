'use client';

import {
  useCaptureDevices,
  useCaptureRange,
  useCaptureTimeline,
  useProcessCaptureRange,
} from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ClockCounterClockwiseIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { CaptureSubpageHeader } from '../capture-shell';
import { appColor, clockTime, durationParts, localDayOf, shortDate } from '../capture-time';
import {
  outputOf,
  outputState,
  rangeSteps,
  rangeSummary,
  rangeTranscript,
  type OutputState,
} from '../range-outputs';
import { useCaptureAccountId, useCaptureMembers, useCaptureViewer } from '../use-capture-viewer';
import { RangeStatusBadge } from './ranges-view';

function OutputPending({
  state,
  error,
  onRetry,
  retrying,
}: {
  state: OutputState;
  error: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  const t = useTranslations('capture.range');
  if (state === 'failed') {
    return (
      <ErrorState
        size="sm"
        title={t('failed')}
        description={error ?? undefined}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying}
          >
            {t('processAgain')}
          </Button>
        }
      />
    );
  }
  return (
    <p className="text-muted-foreground px-3 py-8 text-center text-xs text-pretty">
      {state === 'running' ? t('processing') : t('queued')}
    </p>
  );
}

/** One range: Steps, Transcript and Summary from its pipelines, and time by app from the timeline. */
export function RangeView({ projectId, rangeId }: { projectId: string; rangeId: string }) {
  const accountId = useCaptureAccountId(projectId);
  const t = useTranslations('capture.range');
  const tCapture = useTranslations('capture');
  const locale = useLocale();
  const viewer = useCaptureViewer(projectId);
  const members = useCaptureMembers(projectId, viewer.isManager);
  const range = useCaptureRange(accountId, rangeId);
  const process = useProcessCaptureRange(accountId);
  const data = range.data;
  const otherUser =
    data && viewer.isManager && members.viewerId && data.user_id !== members.viewerId
      ? data.user_id
      : undefined;
  const runs = useCaptureTimeline(
    accountId,
    data
      ? {
          from: data.start_at,
          to: data.end_at,
          userId: otherUser,
          deviceId: data.device_id ?? undefined,
        }
      : null,
  );
  const devices = useCaptureDevices(accountId, { userId: otherUser });

  const byApp = useMemo(() => {
    if (!data) return [];
    const from = Date.parse(data.start_at);
    const to = Date.parse(data.end_at);
    const seconds = new Map<string, number>();
    for (const run of runs.data?.runs ?? []) {
      const start = Math.max(from, Date.parse(run.start_at));
      const end = Math.min(to, Date.parse(run.end_at) + 20_000);
      if (end > start)
        seconds.set(run.app ?? '', (seconds.get(run.app ?? '') ?? 0) + (end - start) / 1000);
    }
    return [...seconds.entries()]
      .map(([app, total]) => ({ app: app || null, seconds: total }))
      .sort((a, b) => b.seconds - a.seconds);
  }, [data, runs.data]);

  const header = <CaptureSubpageHeader projectId={projectId} title={tCapture('ranges.title')} />;
  if (range.isLoading) {
    return (
      <>
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-10">
            <Skeleton className="h-8 w-80 rounded-md" />
            <Skeleton className="h-64 rounded-md" />
          </div>
        </div>
      </>
    );
  }
  if (range.isError || !data) {
    return (
      <>
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-5xl px-4 py-10">
            <ErrorState
              size="sm"
              title={t('notFound')}
              description={t('notFoundHint')}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href={`/projects/${projectId}/capture/ranges`}>{t('backToRanges')}</Link>
                </Button>
              }
            />
          </div>
        </div>
      </>
    );
  }

  const start = Date.parse(data.start_at);
  const end = Date.parse(data.end_at);
  const segmentation = outputOf(data, 'segmentation');
  const transcript = outputOf(data, 'transcript');
  const annotation = outputOf(data, 'annotation');
  const steps = rangeSteps(segmentation);
  const sections = rangeTranscript(transcript);
  const summary = rangeSummary(annotation, transcript);
  const span = tCapture('ranges.span', {
    from: clockTime(start, locale),
    to: clockTime(end, locale),
  });
  const total = durationParts((end - start) / 1000);
  const device = data.device_id
    ? devices.data?.devices.find((d) => d.device_id === data.device_id)?.name
    : null;
  const userQuery = otherUser ? `&user=${otherUser}` : '';
  const momentHref = (ms: number) =>
    `/projects/${projectId}/capture?day=${localDayOf(ms)}&at=${encodeURIComponent(new Date(ms).toISOString())}${data.device_id ? `&device=${data.device_id}` : ''}${userQuery}`;
  const canReprocess = data.status === 'processed' || data.status === 'failed';
  const reprocess = () =>
    process.mutate(rangeId, {
      onSuccess: () => successToast(t('queuedToast')),
      onError: () => errorToast(t('reprocessFailed')),
    });
  const pending = (state: OutputState, error: string | null) => (
    <OutputPending state={state} error={error} onRetry={reprocess} retrying={process.isPending} />
  );
  const totalSeconds = byApp.reduce((sum, item) => sum + item.seconds, 0) || 1;

  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-10 pb-20">
          <div className="flex flex-col items-start gap-3">
            <Button asChild variant="ghost" size="sm" className="-ml-2 gap-1.5">
              <Link
                href={`/projects/${projectId}/capture/ranges${otherUser ? `?user=${otherUser}` : ''}`}
              >
                <ArrowLeftIcon className="size-3.5 shrink-0" />
                {t('backToRanges')}
              </Link>
            </Button>
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1.5">
                <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                  {summary.title ?? data.title ?? span}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {[
                      shortDate(start, locale),
                      span,
                      total.hours > 0
                        ? tCapture('duration.hoursMinutes', total)
                        : tCapture('duration.minutes', total),
                      device,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <Badge variant="outline" size="sm" className="normal-case">
                    {tCapture(`ranges.source.${data.source}`)}
                  </Badge>
                  <RangeStatusBadge status={data.status} />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canReprocess ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="gap-1.5"
                    onClick={reprocess}
                    disabled={process.isPending}
                    aria-busy={process.isPending}
                  >
                    {process.isPending ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : (
                      <ArrowClockwiseIcon className="size-3.5 shrink-0" />
                    )}
                    {t('processAgain')}
                  </Button>
                ) : null}
                <Button asChild size="sm" className="gap-1.5">
                  <Link href={momentHref(start)}>
                    <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                    {t('openInTimeline')}
                  </Link>
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <Tabs defaultValue="steps" className="min-w-0">
              <TabsList type="underline" className="w-full justify-start gap-5">
                <TabsTrigger value="steps" className="w-fit flex-none">
                  {t('tab.steps')}
                </TabsTrigger>
                <TabsTrigger value="transcript" className="w-fit flex-none">
                  {t('tab.transcript')}
                </TabsTrigger>
                <TabsTrigger value="summary" className="w-fit flex-none">
                  {t('tab.summary')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="steps" className="pt-4">
                {outputState(segmentation) !== 'done' ? (
                  pending(outputState(segmentation), segmentation?.error ?? null)
                ) : steps.length === 0 ? (
                  <EmptyState size="sm" title={t('noSteps')} />
                ) : (
                  <ol className="space-y-2">
                    {steps.map((step) => {
                      const at = start + step.startSec * 1000;
                      return (
                        <li
                          key={`${step.startSec}-${step.title}`}
                          className="bg-background flex gap-3 rounded-md border px-4 py-2.5"
                        >
                          <Link
                            href={momentHref(at)}
                            className="text-muted-foreground w-16 shrink-0 pt-0.5 text-xs whitespace-nowrap tabular-nums underline-offset-2 hover:underline"
                          >
                            {clockTime(at, locale)}
                          </Link>
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <p
                              className={
                                step.idle
                                  ? 'text-muted-foreground text-sm'
                                  : 'text-foreground text-sm font-medium'
                              }
                            >
                              {step.title}
                            </p>
                            {step.app || step.detail ? (
                              <p className="text-muted-foreground text-xs text-pretty">
                                {[step.app, step.detail].filter(Boolean).join(' · ')}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </TabsContent>

              <TabsContent value="transcript" className="pt-4">
                {outputState(transcript) !== 'done' ? (
                  pending(outputState(transcript), transcript?.error ?? null)
                ) : sections.length === 0 ? (
                  <EmptyState size="sm" title={t('noTranscript')} />
                ) : (
                  <div className="space-y-4">
                    {sections.map((section) => {
                      const at = start + section.startSec * 1000;
                      return (
                        <section
                          key={`${section.startSec}-${section.heading}`}
                          className="space-y-1"
                        >
                          <p className="text-sm">
                            <Link
                              href={momentHref(at)}
                              className="text-muted-foreground mr-2 text-xs tabular-nums underline-offset-2 hover:underline"
                            >
                              {clockTime(at, locale)}
                            </Link>
                            <span className="text-foreground font-medium">{section.heading}</span>
                          </p>
                          <p className="text-muted-foreground text-sm text-pretty">
                            {section.narrative}
                          </p>
                        </section>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="summary" className="pt-4">
                {outputState(annotation) !== 'done' && outputState(transcript) !== 'done' ? (
                  pending(outputState(annotation), annotation?.error ?? null)
                ) : !summary.summary ? (
                  <EmptyState size="sm" title={t('noSummary')} />
                ) : (
                  <div className="space-y-4">
                    <p className="text-foreground text-sm text-pretty">{summary.summary}</p>
                    {summary.entities.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {summary.entities.map((entity) => (
                          <Badge key={entity} variant="outline" size="sm" className="normal-case">
                            {entity}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </TabsContent>
            </Tabs>

            <aside className="space-y-3" aria-label={t('timeByApp')}>
              <Label>{t('timeByApp')}</Label>
              {runs.isLoading ? (
                <Skeleton className="h-24 rounded-md" />
              ) : byApp.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('noScreen')}</p>
              ) : (
                <>
                  <div className="bg-muted flex h-2 overflow-hidden rounded-sm" aria-hidden>
                    {byApp.map((item) => (
                      <span
                        key={item.app ?? ''}
                        style={{
                          width: `${(item.seconds / totalSeconds) * 100}%`,
                          background: appColor(item.app),
                        }}
                      />
                    ))}
                  </div>
                  <ul className="space-y-1.5">
                    {byApp.slice(0, 8).map((item) => {
                      const parts = durationParts(item.seconds);
                      return (
                        <li key={item.app ?? ''} className="flex items-center gap-2 text-xs">
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: appColor(item.app) }}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {item.app ?? t('unknownApp')}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {parts.hours > 0
                              ? tCapture('duration.hoursMinutes', parts)
                              : tCapture('duration.minutes', parts)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}
