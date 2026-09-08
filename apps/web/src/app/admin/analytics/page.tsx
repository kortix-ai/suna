'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
/**
 * Admin activity analytics — "how active are our users?" at a glance.
 *
 * Backed by GET /v1/admin/analytics/{activity,usage} through
 * `useAdminActivityAnalytics` / `useAdminUsageAnalytics` (@kortix/sdk/react via
 * the @/hooks/admin shim). The page holds no data logic of its own.
 *
 * CHART DESIGN NOTES (dataviz skill):
 * - Every chart is a SINGLE series. The `--chart-1..5` design tokens are a
 *   SEQUENTIAL warm ramp (one hue, light->dark), not a categorical set: two
 *   adjacent steps score ΔE 11.1 on the normal-vision separation check, below
 *   the floor of 15. Rather than invent off-token colors, each chart answers one
 *   question with one series, which removes the categorical problem entirely and
 *   needs no legend — the section title names the series.
 * - The single series colour is `var(--chart-3)` (#e17100). Validated with the
 *   dataviz palette validator against both surfaces: PASS on lightness band,
 *   chroma floor and contrast in dark (#141414); PASS on band and chroma in
 *   light (#f4f4f4) with a contrast WARN at 2.91:1. That WARN obligates relief,
 *   which is supplied here by visible axis labels, a value tooltip on every
 *   mark, and stat tiles that carry the exact numbers as text.
 * - No dual axes anywhere. Compute/LLM/other spend is reported as text in the
 *   burn section's description rather than stacked segments that would need a
 *   second and third categorical hue.
 */

import { useState } from 'react';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  useAdminActivityAnalytics,
  useAdminUsageAnalytics,
} from '@/hooks/admin/use-admin-activity-analytics';
import { ChartBarIcon } from '@phosphor-icons/react';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminPanel, AdminSection } from '../_components/admin-panel';
import { StatGrid, StatGridSkeleton, StatTile } from '../_components/stat-tile';
import {
  deltaTone,
  formatAxisUsd,
  formatCount,
  formatDay,
  formatDelta,
  formatUsd,
} from './analytics-format';

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

// One series per chart, so one entry per config. `ChartContainer` turns each key
// into a `--color-<key>` custom property scoped to that chart.
const sessionsConfig = {
  sessionsCreated: { label: 'Sessions', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const accountsConfig = {
  activeAccounts: { label: 'Active accounts', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const burnConfig = {
  totalUsd: { label: 'Credit burn', color: 'var(--chart-3)' },
} satisfies ChartConfig;

export default function AdminAnalyticsPage() {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const [range, setRange] = useState<string>('30');
  const days = Number(range);

  const activity = useAdminActivityAnalytics(days);
  const usage = useAdminUsageAnalytics(days);

  const isLoading = activity.isLoading || usage.isLoading;
  const isFetching = activity.isFetching || usage.isFetching;
  const error = activity.error ?? usage.error;

  const activityDays = activity.data?.days ?? [];
  const usageDays = usage.data?.days ?? [];
  const summary = activity.data?.summary;
  const usageSummary = usage.data?.summary;

  // "No activity" is not the same as "still loading". A window where every day
  // is zero renders an empty state instead of a flat line pretending to be data.
  // Not memoized: the series is at most 90 entries, so the scan is cheaper than
  // the dependency array it would need.
  const hasActivity = activityDays.some((d) => d.sessionsCreated > 0 || d.activeAccounts > 0);
  const hasBurn = usageDays.some((d) => d.totalUsd > 0);

  const refresh = () => {
    void activity.refetch();
    void usage.refetch();
  };

  const sessionsLast7d = summary?.sessionsLast7d ?? 0;
  const sessionsPrev7d = summary?.sessionsPrev7d ?? 0;
  const delta = formatDelta(sessionsLast7d, sessionsPrev7d);
  const newAccountsInWindow = activityDays.reduce((sum, d) => sum + d.newAccounts, 0);

  return (
    <AdminPageShell
      title={tI18nComplete.raw('text94c116ee118a')}
      description={tI18nComplete.raw('text5a32374d30b4')}
      action={<AdminRefreshButton busy={isFetching} onRefresh={refresh} />}
      filters={
        <Tabs value={range} onValueChange={setRange}>
          <TabsListCompact>
            {RANGES.map((r) => (
              <TabsTriggerCompact key={r.value} value={r.value}>
                {r.label}
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
      }
    >
      {error ? (
        <ErrorState
          title={tI18nComplete.raw('text4a6562501752')}
          description={
            error instanceof Error ? error.message : tI18nComplete.raw('text59845e809cc9')
          }
          action={
            <Button variant="outline" size="sm" onClick={refresh}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : isLoading ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <StatGrid>
            <StatTile
              label={tI18nComplete.raw('text6312bece1004')}
              value={formatCount(sessionsLast7d)}
              hint={
                delta ?? tI18nComplete('text01e9e629cbb0', { value0: formatCount(sessionsPrev7d) })
              }
              tone={deltaTone(sessionsLast7d, sessionsPrev7d)}
            />
            <StatTile
              label={tI18nComplete.raw('text240580c01610')}
              value={`${formatCount(summary?.dau ?? 0)} / ${formatCount(summary?.wau ?? 0)} / ${formatCount(summary?.mau ?? 0)}`}
              hint={tI18nComplete.raw('texte8eb61063713')}
            />
            <StatTile
              label={tI18nComplete('textd196b7afe1d9', { value0: days })}
              value={formatCount(newAccountsInWindow)}
              hint={tI18nComplete('text2309cb81f4b9', {
                value0: formatCount(summary?.totalAccounts ?? 0),
              })}
            />
            <StatTile
              label={tI18nComplete('textfd537cf32a82', { value0: days })}
              value={formatUsd(usageSummary?.totalUsd ?? 0)}
              hint={tI18nComplete('textec58b394f1e2', {
                value0: formatCount(usageSummary?.payingAccountsLast7d ?? 0),
              })}
            />
          </StatGrid>

          <AdminSection
            title={tI18nComplete.raw('text3d7978401c4c')}
            description={tI18nComplete('textdc261f20dba9', {
              value0: formatCount(summary?.totalProjects ?? 0),
            })}
          >
            <AdminPanel>
              {hasActivity ? (
                <ChartContainer config={sessionsConfig} className="h-[260px] w-full">
                  <BarChart
                    accessibilityLayer
                    data={activityDays}
                    margin={{ left: 4, right: 8, top: 4 }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={24}
                      tickFormatter={formatDay}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      width={40}
                      allowDecimals={false}
                      tickFormatter={formatCount}
                    />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent labelFormatter={(value) => formatDay(String(value))} />
                      }
                    />
                    {/* maxBarSize keeps a 7-day window from rendering seven slabs —
                        recharts otherwise divides the full width between the points,
                        and a wide panel turns thin marks into blocks. */}
                    <Bar
                      dataKey="sessionsCreated"
                      fill="var(--color-sessionsCreated)"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={40}
                    />
                  </BarChart>
                </ChartContainer>
              ) : (
                <NoData label={tI18nComplete.raw('textbe20f8439a89')} />
              )}
            </AdminPanel>
          </AdminSection>

          <div className="grid gap-5 lg:grid-cols-2">
            <AdminSection
              title={tI18nComplete.raw('text85afe431118b')}
              description={tI18nComplete.raw('text86103057a0df')}
            >
              <AdminPanel>
                {hasActivity ? (
                  <ChartContainer config={accountsConfig} className="h-[220px] w-full">
                    <AreaChart
                      accessibilityLayer
                      data={activityDays}
                      margin={{ left: 4, right: 8, top: 4 }}
                    >
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={32}
                        tickFormatter={formatDay}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={36}
                        allowDecimals={false}
                        tickFormatter={formatCount}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            labelFormatter={(value) => formatDay(String(value))}
                          />
                        }
                      />
                      <Area
                        dataKey="activeAccounts"
                        type="monotone"
                        stroke="var(--color-activeAccounts)"
                        fill="var(--color-activeAccounts)"
                        fillOpacity={0.12}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </AreaChart>
                  </ChartContainer>
                ) : (
                  <NoData label={tI18nComplete.raw('text4da168d59932')} />
                )}
              </AdminPanel>
            </AdminSection>

            <AdminSection
              title={tI18nComplete.raw('text8fd4602d9483')}
              description={
                usageSummary
                  ? tI18nComplete('text8e643cba1dff', {
                      value0: formatUsd(usageSummary.llmUsd),
                      value1: formatUsd(usageSummary.computeUsd),
                      value2: formatUsd(usageSummary.otherUsd),
                    })
                  : undefined
              }
            >
              <AdminPanel>
                {hasBurn ? (
                  <ChartContainer config={burnConfig} className="h-[220px] w-full">
                    <BarChart
                      accessibilityLayer
                      data={usageDays}
                      margin={{ left: 4, right: 8, top: 4 }}
                    >
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={32}
                        tickFormatter={formatDay}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        width={48}
                        tickFormatter={formatAxisUsd}
                      />
                      <ChartTooltip
                        content={
                          <ChartTooltipContent
                            labelFormatter={(value) => formatDay(String(value))}
                            formatter={(value) => (
                              <span className="text-foreground font-medium tabular-nums">
                                {formatUsd(Number(value))}
                              </span>
                            )}
                          />
                        }
                      />
                      <Bar
                        dataKey="totalUsd"
                        fill="var(--color-totalUsd)"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={40}
                      />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <NoData label={tI18nComplete.raw('texteda00b33d3af')} />
                )}
              </AdminPanel>
            </AdminSection>
          </div>
        </>
      )}
    </AdminPageShell>
  );
}

/** Shape-matched placeholder: the tile row, the tall chart, then the pair. */
function AnalyticsSkeleton() {
  return (
    <>
      <StatGridSkeleton />
      <Skeleton className="h-[320px] rounded-md" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-[280px] rounded-md" />
        <Skeleton className="h-[280px] rounded-md" />
      </div>
    </>
  );
}

function NoData({ label }: { label: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex h-[220px] items-center justify-center">
      <EmptyState
        icon={ChartBarIcon}
        size="sm"
        title={tI18nComplete.raw('text0cf9505f9f97')}
        description={label}
      />
    </div>
  );
}
