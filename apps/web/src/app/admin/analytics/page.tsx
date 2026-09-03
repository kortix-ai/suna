'use client';

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
      title="Analytics"
      description="Daily platform activity and credit burn. Every bucket is a UTC day."
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
          title="Could not load analytics"
          description={error instanceof Error ? error.message : 'The analytics request failed.'}
          action={
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : isLoading ? (
        <AnalyticsSkeleton />
      ) : (
        <>
          <StatGrid>
            <StatTile
              label="Sessions last 7 days"
              value={formatCount(sessionsLast7d)}
              hint={delta ?? `${formatCount(sessionsPrev7d)} in the previous 7 days`}
              tone={deltaTone(sessionsLast7d, sessionsPrev7d)}
            />
            <StatTile
              label="DAU / WAU / MAU"
              value={`${formatCount(summary?.dau ?? 0)} / ${formatCount(summary?.wau ?? 0)} / ${formatCount(summary?.mau ?? 0)}`}
              hint="Distinct users who started a session"
            />
            <StatTile
              label={`New accounts (${days}d)`}
              value={formatCount(newAccountsInWindow)}
              hint={`${formatCount(summary?.totalAccounts ?? 0)} accounts in total`}
            />
            <StatTile
              label={`Credit burn (${days}d)`}
              value={formatUsd(usageSummary?.totalUsd ?? 0)}
              hint={`${formatCount(usageSummary?.payingAccountsLast7d ?? 0)} accounts spent in the last 7 days`}
            />
          </StatGrid>

          <AdminSection
            title="Sessions created per day"
            description={`${formatCount(summary?.totalProjects ?? 0)} projects on the platform.`}
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
                <NoData label="No sessions were created in this window." />
              )}
            </AdminPanel>
          </AdminSection>

          <div className="grid gap-5 lg:grid-cols-2">
            <AdminSection
              title="Active accounts per day"
              description="Accounts that started at least one session."
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
                  <NoData label="No accounts were active in this window." />
                )}
              </AdminPanel>
            </AdminSection>

            <AdminSection
              title="Credit burn per day"
              description={
                usageSummary
                  ? `${formatUsd(usageSummary.llmUsd)} LLM · ${formatUsd(usageSummary.computeUsd)} compute · ${formatUsd(usageSummary.otherUsd)} other.`
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
                  <NoData label="No credits were spent in this window." />
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
  return (
    <div className="flex h-[220px] items-center justify-center">
      <EmptyState icon={ChartBarIcon} size="sm" title="No activity" description={label} />
    </div>
  );
}
