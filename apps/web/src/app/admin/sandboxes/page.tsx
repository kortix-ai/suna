'use client';

import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { ArrowsLeftRightIcon, DotsThreeIcon } from '@phosphor-icons/react';
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
import {
  AdminEmptyFrame,
  AdminPanel,
  AdminSection,
  AdminTableFrame,
} from '../_components/admin-panel';
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const ranges = useLocalizedUiCatalog(RANGES);
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
      successToast(tI18nComplete.raw('textadf5fc6a2d24'));
      qc.invalidateQueries({ queryKey: ['admin', 'provider-distribution'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? tI18nComplete.raw('text53ad6f999b1f')),
  });

  const [migrating, setMigrating] = useState<Sbx | null>(null);
  const [target, setTarget] = useState('');
  const migrate = useMutation({
    mutationFn: async () => migrateAdminSandboxProvider(migrating!.sessionId, target),
    onSuccess: () => {
      successToast(tI18nComplete('text44df00d3050e', { value0: target }));
      setMigrating(null);
      qc.invalidateQueries({ queryKey: ['admin', 'sandboxes'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? tI18nComplete.raw('textc98995fad3b9')),
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
      successToast(tI18nComplete.raw('textbc86ed0acea7'));
      qc.invalidateQueries({ queryKey: ['admin', 'provider-fallback'] });
    },
    onError: (e: Error) => errorToast(e?.message ?? tI18nComplete.raw('text53ad6f999b1f')),
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
      title={tI18nComplete.raw('text3f2c01e07be5')}
      description={tI18nComplete.raw('text4b0e0e2050e3')}
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
          <TabsTrigger value="overview">{tI18nComplete.raw('textd4b1ea5708dd')}</TabsTrigger>
          <TabsTrigger value="analytics">{tI18nComplete.raw('text94c116ee118a')}</TabsTrigger>
        </TabsList>
        {/* ── OVERVIEW ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-8">
          {listQ.isLoading ? (
            <StatGridSkeleton count={3} />
          ) : (
            <StatGrid>
              <StatTile
                label={tI18nComplete.raw('text1eaee08882eb')}
                value={totalSandboxes.toLocaleString()}
                hint={tI18nComplete.raw('text5cbdd59d7048')}
              />
              {allowed.map((p) => {
                const pct = totalW > 0 ? Math.round(((Number(weights[p]) || 0) / totalW) * 100) : 0;
                return (
                  <StatTile
                    key={p}
                    label={p[0].toUpperCase() + p.slice(1)}
                    value={(countByProvider[p] ?? 0).toLocaleString()}
                    hint={tI18nComplete('text347cf684f3e7', { value0: pct })}
                  />
                );
              })}
            </StatGrid>
          )}

          <AdminSection
            title={tI18nComplete.raw('text43a857886565')}
            description={tI18nComplete('textf6668c33ea1a', {
              value0: dist ? ` (${dist.default})` : '',
            })}
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
                                {tI18nComplete.raw('text37a8eec1ce19')}
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
                            {pct}
                            {tI18nComplete.raw('text499977bddecf')}
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
                    {tI18nComplete.raw('text85457bd27cfc')}
                  </Button>
                </>
              )}
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title={tI18nComplete.raw('text2953b4f72d16')}
            description={tI18nComplete.raw('textf32b512d4c31')}
          >
            <AdminPanel className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <span className="text-foreground text-sm">
                  {tI18nComplete.raw('textc8392f8bbd61')}
                </span>
                {fbQ.isLoading ? (
                  <Skeleton className="h-5 w-9 rounded-full" />
                ) : (
                  <Switch
                    checked={fbEnabled}
                    onCheckedChange={setFbEnabled}
                    aria-label={tI18nComplete.raw('text158c8bdea1b0')}
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
                {tI18nComplete.raw('text08cfb2899839')}
              </Button>
            </AdminPanel>
          </AdminSection>

          <AdminSection
            title={tI18nComplete.raw('text2d2827ffc214')}
            description={tI18nComplete.raw('textd038adbf2bca')}
            action={
              <div className="w-full sm:w-72">
                <AdminSearch
                  value={search}
                  onChange={setSearch}
                  placeholder={tI18nComplete.raw('texte7a5e2570fb6')}
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
                  title={
                    search
                      ? tI18nComplete.raw('text062bccfdad1c')
                      : tI18nComplete.raw('texta670596d72fd')
                  }
                  description={
                    search
                      ? tI18nComplete.raw('textce18e358bf01')
                      : tI18nComplete.raw('textd4c2dd15aae0')
                  }
                  action={
                    search ? (
                      <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                        {tI18nComplete.raw('text3b7ea51793e9')}
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
                      <TableHead>{tI18nComplete.raw('text472590ae974d')}</TableHead>
                      <TableHead>{tI18nComplete.raw('text920e413c7d41')}</TableHead>
                      <TableHead>{tI18nComplete.raw('text6959b4159575')}</TableHead>
                      <TableHead>{tI18nComplete.raw('text7e1b0d5641f2')}</TableHead>
                      <TableHead>{tI18nComplete.raw('text830ec7f812f9')}</TableHead>
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
                              <Hint label={tI18nComplete.raw('text20dba837bd8e')}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={tI18nComplete.raw('text20dba837bd8e')}
                                  >
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
                                  {tI18nComplete.raw('text969a25894852')}
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
              {tI18nComplete.raw('text27342581678a')}
            </p>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-44 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {ranges.map((r) => (
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
                title={tI18nComplete.raw('text9c41daf68e2e')}
                description={tI18nComplete.raw('texta4cf35d7f3ca')}
              />
            </AdminEmptyFrame>
          ) : (
            <>
              <StatGrid>
                <StatTile
                  label={tI18nComplete.raw('text7982ad72bd36')}
                  value={an.totals.provisions.toLocaleString()}
                  hint={`${an.totals.migrations} migrations`}
                />
                <StatTile
                  label={tI18nComplete.raw('text49da60f8a292')}
                  value={an.totals.successRate == null ? '—' : `${an.totals.successRate}%`}
                  tone={
                    an.totals.successRate != null && an.totals.successRate < 90
                      ? 'warning'
                      : 'success'
                  }
                  hint={tI18nComplete('textad0f852848bf', {
                    value0: an.totals.ok,
                    value1: an.totals.error,
                  })}
                />
                <StatTile
                  label={tI18nComplete.raw('textcb702378f315')}
                  value={an.totals.error.toLocaleString()}
                  tone={an.totals.error > 0 ? 'danger' : 'default'}
                  hint={
                    an.totals.stopped
                      ? tI18nComplete('text58dfb849aa70', { value0: an.totals.stopped })
                      : tI18nComplete.raw('text87ee04b2e9ee')
                  }
                />
                <StatTile
                  label={tI18nComplete.raw('text996c32b35f21')}
                  value={an.providers.length}
                  hint={anProviders.join(' · ') || '—'}
                />
              </StatGrid>

              <AdminSection
                title={tI18nComplete.raw('text910ab2c6e011')}
                description={tI18nComplete.raw('text7055405b8f29')}
              >
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{tI18nComplete.raw('text472590ae974d')}</TableHead>
                      <TableHead className="text-right">
                        {tI18nComplete.raw('text7982ad72bd36')}
                      </TableHead>
                      <TableHead className="text-right">
                        {tI18nComplete.raw('textc88a0b907419')}
                      </TableHead>
                      <TableHead className="text-right">
                        {tI18nComplete.raw('text875636a511da')}
                      </TableHead>
                      <TableHead className="text-right">
                        {tI18nComplete.raw('textf771f4d32eee')}
                      </TableHead>
                      <TableHead className="text-right">
                        {tI18nComplete.raw('textcb702378f315')}
                      </TableHead>
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
                  title={tI18nComplete.raw('textbdc837a7b2e4')}
                  description={tI18nComplete.raw('textf1ef9e0be888')}
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
                  title={tI18nComplete.raw('text34842398fd2d')}
                  description={tI18nComplete.raw('textfd7e911ee733')}
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
                title={tI18nComplete.raw('text1499fcd195a5')}
                description={tI18nComplete.raw('text73741827862b')}
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
                  title={tI18nComplete.raw('text799b25b8c943')}
                  description={tI18nComplete.raw('text9bd290d1b0ce')}
                >
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>{tI18nComplete.raw('text472590ae974d')}</TableHead>
                        <TableHead>{tI18nComplete.raw('text4f3a9bd00397')}</TableHead>
                        <TableHead>{tI18nComplete.raw('text54a0e8c17ebb')}</TableHead>
                        <TableHead>{tI18nComplete.raw('textcf9c7aa24a26')}</TableHead>
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
                                {tI18nComplete.raw('textec21b3b973a3')}
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
            <ModalTitle>{tI18nComplete.raw('text5150c9d9bb20')}</ModalTitle>
            <ModalDescription>
              {tI18nComplete.raw('text998c22f68978')}
              <span className="font-mono">{migrating?.sessionId?.slice(0, 8)}</span> off{' '}
              <span className="capitalize">{migrating?.provider}</span>
              {tI18nComplete.raw('text09a3bb2aced6')}
            </ModalDescription>
          </ModalHeader>
          <div className="px-4 pb-2">
            <Field>
              <FieldLabel htmlFor="migrate-target">
                {tI18nComplete.raw('text86ecd94bbb17')}
              </FieldLabel>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="migrate-target" className="w-full">
                  <SelectValue placeholder={tI18nComplete.raw('texte1d36c3adeeb')} />
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
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button
              onClick={() => migrate.mutate()}
              disabled={!target || migrate.isPending}
              className="gap-1.5"
            >
              {migrate.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('textf988ed29d81b')}
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
