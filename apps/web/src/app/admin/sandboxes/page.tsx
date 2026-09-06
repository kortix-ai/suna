'use client';

import {
  ArrowsLeftRightIcon,
  DotsThreeIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { IconInbox } from '@/components/ui/kortix-icons';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import {
  getAdminProviderAnalytics,
  getAdminProviderDistribution,
  getAdminProviderFallback,
  listAdminSandboxes,
  migrateAdminSandboxProvider,
  setAdminProviderDistribution,
  setAdminProviderFallback,
} from '@kortix/sdk';

import { AdminPageShell, AdminRefreshButton } from '../_components/admin-page-shell';
import { AdminEmptyFrame, AdminPanel, AdminSection, AdminTableFrame } from '../_components/admin-panel';
import { AdminSearch } from '../_components/admin-table';
import { StatGrid, StatGridSkeleton, StatTile } from '../_components/stat-tile';

// ── types ──────────────────────────────────────────────────────────────────
interface Dist {
  allowed: string[];
  default: string;
  weights: Record<string, number>;
}
interface Sbx {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  projectId: string;
  provider: string;
  externalId: string | null;
  status: string;
  lastUsedAt: string | null;
}
interface SbxResp {
  sandboxes: Sbx[];
  byProvider: { provider: string; count: number }[];
}
interface ProviderStat {
  provider: string;
  provisions: number;
  ok: number;
  error: number;
  stopped: number;
  successRate: number | null;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  phases: { label: string; avgMs: number }[];
}
interface Analytics {
  days: number;
  totals: {
    provisions: number;
    ok: number;
    error: number;
    stopped: number;
    migrations: number;
    successRate: number | null;
  };
  providers: ProviderStat[];
  latencyByDay: Record<string, unknown>[];
  volumeByDay: Record<string, unknown>[];
  migrations: { flow: string; count: number }[];
  recentErrors: {
    provider: string;
    errorClass: string | null;
    error: string | null;
    createdAt: string;
  }[];
}

// ── chart colour ────────────────────────────────────────────────────────────
/**
 * Provider series colours, in assignment order.
 *
 * `--chart-1..5` is a SEQUENTIAL warm ramp (hue 92°→45°, lightness 0.88→0.47),
 * so two ADJACENT steps do not separate well enough for a categorical series —
 * the same finding recorded in `analytics/page.tsx`. This list therefore takes
 * the ramp's ends and middle first (1, 3, 5), which are the three most
 * separated steps it contains, and only falls back to the in-between steps for
 * a fourth and fifth provider. The fleet runs two or three.
 *
 * Every chart that uses these also renders a legend, and the per-provider
 * summary table below carries the same numbers as text — which is the relief
 * the dataviz rules require whenever series colour alone is doing work.
 *
 * The hand-written `hsl(...)` literals this replaces were off-token in both
 * themes, and unreadable in one of them.
 */
const PROVIDER_SERIES = [
  'var(--chart-1)',
  'var(--chart-3)',
  'var(--chart-5)',
  'var(--chart-2)',
  'var(--chart-4)',
];
const colorFor = (i: number) => PROVIDER_SERIES[i % PROVIDER_SERIES.length];

/**
 * Provisioning phases, in the order they execute.
 *
 * A stacked bar of consecutive phases IS ordered data, so the sequential ramp
 * is the correct encoding here rather than a compromise: the stack reads
 * light-to-dark left-to-right, in the order the phases actually run.
 */
const PHASES = ['row+tokens', 'image', 'provider-create', 'before-active-hook', 'row-active'];
const PHASE_COLORS: Record<string, string> = {
  'row+tokens': 'var(--chart-1)',
  image: 'var(--chart-2)',
  'provider-create': 'var(--chart-3)',
  'before-active-hook': 'var(--chart-4)',
  'row-active': 'var(--chart-5)',
};

// ── helpers ─────────────────────────────────────────────────────────────────
const statusBadge = (s: string): 'default' | 'secondary' | 'destructive' | 'outline' =>
  s === 'active'
    ? 'default'
    : s === 'error'
      ? 'destructive'
      : s === 'provisioning'
        ? 'secondary'
        : 'outline';
const fmtDate = (d: string | null) =>
  d
    ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
const fmtMs = (ms?: number | null) =>
  ms == null
    ? '—'
    : ms >= 1000
      ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`
      : `${Math.round(ms)}ms`;
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const RANGES = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export default function AdminSandboxesPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState(7);

  const distQ = useQuery({
    queryKey: ['admin', 'provider-distribution'],
    queryFn: async () => getAdminProviderDistribution<Dist>(),
  });
  const listQ = useQuery({
    queryKey: ['admin', 'sandboxes'],
    queryFn: async () => listAdminSandboxes<SbxResp>(300),
    refetchInterval: 10_000,
  });
  const anQ = useQuery({
    queryKey: ['admin', 'provider-analytics', days],
    queryFn: async () => getAdminProviderAnalytics<Analytics>(days),
    enabled: tab === 'analytics',
    refetchInterval: tab === 'analytics' ? 30_000 : false,
  });

  const [weights, setWeights] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!distQ.data) return;
    const w: Record<string, string> = {};
    for (const p of distQ.data.allowed) w[p] = String(distQ.data.weights[p] ?? 0);
    setWeights(w);
  }, [distQ.data]);

  const saveWeights = useMutation({
    mutationFn: async () => {
      const body: Record<string, number> = {};
      for (const k in weights) body[k] = Number(weights[k]) || 0;
      return setAdminProviderDistribution(body);
    },
    onSuccess: () => {
      successToast('Distribution saved');
      qc.invalidateQueries({ queryKey: ['admin', 'provider-distribution'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? 'Save failed'),
  });

  const [migrating, setMigrating] = useState<Sbx | null>(null);
  const [target, setTarget] = useState('');
  const migrate = useMutation({
    mutationFn: async () => migrateAdminSandboxProvider(migrating!.sessionId, target),
    onSuccess: () => {
      successToast(`Migrating to ${target}…`);
      setMigrating(null);
      qc.invalidateQueries({ queryKey: ['admin', 'sandboxes'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? 'Migrate failed'),
  });

  // ── Provider failover (one-shot, on session init) ─────────────────────────
  const fbQ = useQuery({
    queryKey: ['admin', 'provider-fallback'],
    queryFn: async () => getAdminProviderFallback(),
  });
  const [fbEnabled, setFbEnabled] = useState(false);
  useEffect(() => {
    if (fbQ.data) setFbEnabled(!!fbQ.data.enabled);
  }, [fbQ.data]);
  const saveFb = useMutation({
    mutationFn: async () => setAdminProviderFallback(fbEnabled),
    onSuccess: () => {
      successToast('Failover saved');
      qc.invalidateQueries({ queryKey: ['admin', 'provider-fallback'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? 'Save failed'),
  });

  const dist = distQ.data;
  const allowed = useMemo(() => dist?.allowed ?? [], [dist]);
  const totalW = allowed.reduce((s, p) => s + (Number(weights[p]) || 0), 0);
  const list = listQ.data;
  const targets = migrating ? allowed.filter((p) => p !== migrating.provider) : [];

  const countByProvider = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of list?.byProvider ?? []) m[b.provider] = b.count;
    return m;
  }, [list]);
  const totalSandboxes = useMemo(
    () => (list?.byProvider ?? []).reduce((s, b) => s + b.count, 0),
    [list],
  );

  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list?.sandboxes ?? [];
    if (!q) return all;
    return all.filter((s) =>
      [s.provider, s.status, s.sessionId, s.accountId, s.externalId ?? ''].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [list, search]);

  // analytics derived chart shapes
  const an = anQ.data;
  const anProviders = useMemo(() => an?.providers.map((p) => p.provider) ?? [], [an]);
  const chartConfig: ChartConfig = useMemo(() => {
    const c: ChartConfig = {};
    anProviders.forEach((p, i) => {
      c[p] = { label: p[0].toUpperCase() + p.slice(1), color: colorFor(i) };
    });
    return c;
  }, [anProviders]);
  const phaseData = useMemo(
    () =>
      (an?.providers ?? []).map((p) => {
        const row: Record<string, string | number> = {
          provider: p.provider[0].toUpperCase() + p.provider.slice(1),
        };
        for (const ph of PHASES) row[ph] = p.phases.find((x) => x.label === ph)?.avgMs ?? 0;
        return row;
      }),
    [an],
  );
  const phaseConfig: ChartConfig = useMemo(() => {
    const c: ChartConfig = {};
    for (const ph of PHASES) c[ph] = { label: ph, color: PHASE_COLORS[ph] };
    return c;
  }, []);

  const busy = listQ.isFetching || anQ.isFetching;

  return (
    <AdminPageShell
      width="wide"
      title="Sandboxes"
      description="Where new sandboxes are placed, how that placement performs, and the live fleet it produces."
      action={
        <AdminRefreshButton
          busy={busy}
          onRefresh={() => {
            void listQ.refetch();
            if (tab === 'analytics') void anQ.refetch();
          }}
        />
      }
    >
      {/* One Tabs root, not two. The list and the panels have to share a root
          or Radix cannot wire `aria-controls` between them — which is why the
          bar does not go in the shell's `filters` slot here. */}
      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>
        {/* ── OVERVIEW ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-8">
          {listQ.isLoading ? (
            <StatGridSkeleton count={3} />
          ) : (
            <StatGrid>
              <StatTile
                label="Total sandboxes"
                value={totalSandboxes.toLocaleString()}
                hint="Across every provider"
              />
              {allowed.map((p) => {
                const pct = totalW > 0 ? Math.round(((Number(weights[p]) || 0) / totalW) * 100) : 0;
                return (
                  <StatTile
                    key={p}
                    label={p[0].toUpperCase() + p.slice(1)}
                    value={(countByProvider[p] ?? 0).toLocaleString()}
                    hint={`${pct}% of new sandboxes`}
                  />
                );
              })}
            </StatGrid>
          )}

          <AdminSection
            title="Split distribution"
            description={`Weighted-random placement for new sandboxes. All-zero falls back to the default${dist ? ` (${dist.default})` : ''}. An explicit per-request provider always wins.`}
          >
            <AdminPanel className="space-y-5">
              {distQ.isLoading ? (
                <Skeleton className="h-24 w-full rounded-md" />
              ) : (
                <>
                  <div className="flex flex-wrap gap-4">
                    {allowed.map((p) => {
                      const pct =
                        totalW > 0 ? Math.round(((Number(weights[p]) || 0) / totalW) * 100) : 0;
                      return (
                        <Field key={p} className="w-40">
                          <FieldLabel
                            htmlFor={`weight-${p}`}
                            className="flex items-center gap-1.5 capitalize"
                          >
                            {p}
                            {p === dist?.default && (
                              <Badge variant="outline" size="sm">
                                default
                              </Badge>
                            )}
                          </FieldLabel>
                          <Input
                            id={`weight-${p}`}
                            type="number"
                            min={0}
                            value={weights[p] ?? ''}
                            onChange={(e) => setWeights({ ...weights, [p]: e.target.value })}
                          />
                          {/* Share of traffic, drawn once per keystroke. No
                              transition: the bar is driven by a number input,
                              and animating a keyboard-driven change makes the
                              field feel like it is lagging the keys. */}
                          <div
                            role="presentation"
                            className="bg-muted h-1.5 overflow-hidden rounded-full"
                          >
                            <div className="bg-foreground h-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-muted-foreground text-xs tabular-nums">
                            {pct}% of traffic
                          </span>
                        </Field>
                      );
                    })}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => saveWeights.mutate()}
                    disabled={saveWeights.isPending || !allowed.length}
                    className="gap-1.5"
                  >
                    {saveWeights.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                    Save distribution
                  </Button>
                </>
              )}
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title="Provider failover"
            description="Off by default. When enabled, a session init that fails retries once on the next provider."
          >
            <AdminPanel className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <span className="text-foreground text-sm">Retry a failed init on another provider</span>
                {fbQ.isLoading ? (
                  <Skeleton className="h-5 w-9 rounded-full" />
                ) : (
                  <Switch
                    checked={fbEnabled}
                    onCheckedChange={setFbEnabled}
                    aria-label="Enable provider failover"
                  />
                )}
              </div>
              <Button
                size="sm"
                onClick={() => saveFb.mutate()}
                disabled={saveFb.isPending}
                className="gap-1.5"
              >
                {saveFb.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                Save failover
              </Button>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title="Live fleet"
            description="The 300 most recent sandboxes. Refreshes every 10 seconds."
            action={
              <div className="w-full sm:w-72">
                <AdminSearch
                  value={search}
                  onChange={setSearch}
                  placeholder="Provider, status, session, account, external ID"
                />
              </div>
            }
          >
            {listQ.isLoading ? (
              <FleetTableSkeleton />
            ) : rows.length === 0 ? (
              <AdminEmptyFrame>
                <EmptyState
                  icon={IconInbox}
                  size="sm"
                  title={search ? 'No sandboxes match this search' : 'No sandboxes yet'}
                  description={
                    search
                      ? 'Try a different term.'
                      : 'New sandboxes appear here as sessions spin up.'
                  }
                  action={
                    search ? (
                      <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                        Clear search
                      </Button>
                    ) : undefined
                  }
                />
              </AdminEmptyFrame>
            ) : (
              <AdminTableFrame busy={listQ.isFetching}>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Session</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Last used</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((s) => {
                      const canMigrate = allowed.filter((p) => p !== s.provider).length > 0;
                      return (
                        <TableRow key={s.sandboxId}>
                          <TableCell>
                            <Badge variant="outline" size="sm" className="capitalize">
                              {s.provider}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusBadge(s.status)} size="sm" className="capitalize">
                              {s.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="max-w-[280px] min-w-0">
                              <div className="truncate font-mono text-xs">
                                {s.sessionId?.slice(0, 8)}
                              </div>
                              {s.externalId && (
                                <div className="text-muted-foreground truncate font-mono text-xs">
                                  {s.externalId.slice(0, 22)}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">
                            {s.accountId?.slice(0, 8)}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {fmtDate(s.lastUsedAt)}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <Hint label="Sandbox actions">
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" aria-label="Sandbox actions">
                                    <DotsThreeIcon className="size-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </Hint>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  disabled={!canMigrate}
                                  onClick={() => {
                                    setMigrating(s);
                                    setTarget(allowed.find((p) => p !== s.provider) ?? '');
                                  }}
                                >
                                  <ArrowsLeftRightIcon className="size-4 shrink-0" />
                                  Migrate to another provider…
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </AdminTableFrame>
            )}
          </AdminSection>
        </TabsContent>

        {/* ── ANALYTICS ────────────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="space-y-8">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm text-balance">
              How each provider performs — provisioning latency, success rate, and where the time
              goes.
            </p>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {anQ.isLoading ? (
            <>
              <StatGridSkeleton />
              <Skeleton className="h-72 w-full rounded-md" />
            </>
          ) : !an || an.totals.provisions === 0 ? (
            <AdminEmptyFrame>
              <EmptyState
                icon={IconInbox}
                size="sm"
                title="No provisioning data yet"
                description="Provision a few sandboxes — their timing and outcome show up here."
              />
            </AdminEmptyFrame>
          ) : (
            <>
              <StatGrid>
                <StatTile
                  label="Provisions"
                  value={an.totals.provisions.toLocaleString()}
                  hint={`${an.totals.migrations} migrations`}
                />
                <StatTile
                  label="Success rate"
                  value={an.totals.successRate == null ? '—' : `${an.totals.successRate}%`}
                  tone={
                    an.totals.successRate != null && an.totals.successRate < 90
                      ? 'warning'
                      : 'success'
                  }
                  hint={`${an.totals.ok} ok · ${an.totals.error} failed`}
                />
                <StatTile
                  label="Errors"
                  value={an.totals.error.toLocaleString()}
                  tone={an.totals.error > 0 ? 'danger' : 'default'}
                  hint={an.totals.stopped ? `${an.totals.stopped} stopped` : 'None stopped'}
                />
                <StatTile
                  label="Providers"
                  value={an.providers.length}
                  hint={anProviders.join(' · ') || '—'}
                />
              </StatGrid>

              <AdminSection
                title="Per provider"
                description="The same numbers the charts below encode as colour, as text."
              >
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">Provisions</TableHead>
                      <TableHead className="text-right">Success</TableHead>
                      <TableHead className="text-right">p50</TableHead>
                      <TableHead className="text-right">p95</TableHead>
                      <TableHead className="text-right">Errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {an.providers.map((p, i) => (
                      <TableRow key={p.provider}>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            {/* The legend key for every chart on this tab. */}
                            <span
                              aria-hidden
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ background: colorFor(i) }}
                            />
                            <span className="font-medium capitalize">{p.provider}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{p.provisions}</TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            p.successRate != null && p.successRate < 90 && 'text-kortix-orange',
                          )}
                        >
                          {p.successRate == null ? '—' : `${p.successRate}%`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMs(p.p50Ms)}</TableCell>
                        <TableCell className="text-muted-foreground text-right tabular-nums">
                          {fmtMs(p.p95Ms)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            p.error > 0 && 'text-kortix-red',
                          )}
                        >
                          {p.error}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AdminSection>

              <div className="grid gap-5 lg:grid-cols-2">
                <AdminSection
                  title="Provisioning latency (p50)"
                  description="Median time to a ready sandbox, per provider per day."
                >
                  <AdminPanel>
                    <ChartContainer config={chartConfig} className="h-[260px] w-full">
                      <AreaChart
                        accessibilityLayer
                        data={an.latencyByDay}
                        margin={{ left: 4, right: 8 }}
                      >
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                          tickFormatter={fmtDay}
                          minTickGap={24}
                        />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          width={42}
                          tickFormatter={(v) => fmtMs(v)}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent labelFormatter={(l) => fmtDay(String(l))} />
                          }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        {anProviders.map((p) => (
                          <Area
                            key={p}
                            type="monotone"
                            dataKey={p}
                            stroke={`var(--color-${p})`}
                            fill={`var(--color-${p})`}
                            fillOpacity={0.12}
                            strokeWidth={2}
                            connectNulls
                            dot={false}
                          />
                        ))}
                      </AreaChart>
                    </ChartContainer>
                  </AdminPanel>
                </AdminSection>

                <AdminSection
                  title="Provision volume"
                  description="Sandboxes provisioned per provider per day."
                >
                  <AdminPanel>
                    <ChartContainer config={chartConfig} className="h-[260px] w-full">
                      <BarChart
                        accessibilityLayer
                        data={an.volumeByDay}
                        margin={{ left: 4, right: 8 }}
                      >
                        <CartesianGrid vertical={false} />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={8}
                          tickFormatter={fmtDay}
                          minTickGap={24}
                        />
                        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent labelFormatter={(l) => fmtDay(String(l))} />
                          }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        {anProviders.map((p) => (
                          <Bar
                            key={p}
                            dataKey={p}
                            stackId="v"
                            fill={`var(--color-${p})`}
                            radius={2}
                          />
                        ))}
                      </BarChart>
                    </ChartContainer>
                  </AdminPanel>
                </AdminSection>
              </div>

              <AdminSection
                title="Where the time goes"
                description="Average duration of each provisioning phase, in execution order, for successful provisions."
              >
                <AdminPanel>
                  <ChartContainer config={phaseConfig} className="h-[220px] w-full">
                    <BarChart
                      accessibilityLayer
                      data={phaseData}
                      layout="vertical"
                      margin={{ left: 12, right: 12 }}
                    >
                      <CartesianGrid horizontal={false} />
                      <XAxis
                        type="number"
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => fmtMs(v)}
                      />
                      <YAxis
                        type="category"
                        dataKey="provider"
                        tickLine={false}
                        axisLine={false}
                        width={80}
                      />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      {PHASES.map((ph, i) => (
                        <Bar
                          key={ph}
                          dataKey={ph}
                          stackId="p"
                          fill={`var(--color-${ph})`}
                          radius={
                            i === 0 ? [4, 0, 0, 4] : i === PHASES.length - 1 ? [0, 4, 4, 0] : 0
                          }
                        />
                      ))}
                    </BarChart>
                  </ChartContainer>
                </AdminPanel>
              </AdminSection>

              {an.recentErrors.length > 0 && (
                <AdminSection
                  title="Recent errors"
                  description="The newest provisioning failures, with the class the API assigned them."
                >
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Provider</TableHead>
                        <TableHead>Class</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead>When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {an.recentErrors.map((e) => (
                        <TableRow key={`${e.provider}:${e.createdAt}:${e.error ?? ''}`}>
                          <TableCell>
                            <Badge variant="outline" size="sm" className="capitalize">
                              {e.provider}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {e.errorClass === 'capacity' ? (
                              <Badge variant="secondary" size="sm">
                                capacity
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                {e.errorClass ?? '—'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground max-w-[420px] truncate text-xs"
                            title={e.error ?? ''}
                          >
                            {e.error ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                            {new Date(e.createdAt).toLocaleString()}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AdminSection>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* ── migrate ─────────────────────────────────────────────────────────── */}
      <Modal
        open={!!migrating}
        onOpenChange={(open) => {
          if (!open) setMigrating(null);
        }}
      >
        <ModalContent className="lg:max-w-lg">
          <ModalHeader>
            <ModalTitle>Migrate sandbox</ModalTitle>
            <ModalDescription>
              Move session <span className="font-mono">{migrating?.sessionId?.slice(0, 8)}</span> off{' '}
              <span className="capitalize">{migrating?.provider}</span>. The session keeps its id;
              the sandbox is rebuilt.
            </ModalDescription>
          </ModalHeader>
          <div className="px-4 pb-2">
            <Field>
              <FieldLabel htmlFor="migrate-target">Target provider</FieldLabel>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="migrate-target" className="w-full">
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <ModalFooter className="sm:justify-between">
            <Button variant="outline-ghost" onClick={() => setMigrating(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => migrate.mutate()}
              disabled={!target || migrate.isPending}
              className="gap-1.5"
            >
              {migrate.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Migrate
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AdminPageShell>
  );
}

/** Shape-matched placeholder for the live-fleet table. */
function FleetTableSkeleton() {
  return (
    <div className="bg-popover overflow-hidden rounded-md border">
      <div className="bg-accent border-b px-5 py-2">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="divide-border divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-5 px-5 py-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="ml-auto h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
