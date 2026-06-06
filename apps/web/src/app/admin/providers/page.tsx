'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRightLeft, Boxes, Loader2, MoreHorizontal, RefreshCw,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis,
} from 'recharts';

import { backendApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { IconInbox } from '@/components/ui/kortix-icons';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import { SectionContainer, SectionHeader } from '../_components/section-header';

// ── types ──────────────────────────────────────────────────────────────────
interface Dist { allowed: string[]; default: string; weights: Record<string, number>; }
interface Sbx {
  sandboxId: string; sessionId: string; accountId: string; projectId: string;
  provider: string; externalId: string | null; status: string; lastUsedAt: string | null;
}
interface SbxResp { sandboxes: Sbx[]; byProvider: { provider: string; count: number }[]; }
interface ProviderStat {
  provider: string; provisions: number; ok: number; error: number; stopped: number;
  successRate: number | null; p50Ms: number; p95Ms: number; avgMs: number;
  phases: { label: string; avgMs: number }[];
}
interface Analytics {
  days: number;
  totals: { provisions: number; ok: number; error: number; stopped: number; migrations: number; successRate: number | null };
  providers: ProviderStat[];
  latencyByDay: Record<string, any>[];
  volumeByDay: Record<string, any>[];
  migrations: { flow: string; count: number }[];
  recentErrors: { provider: string; errorClass: string | null; error: string | null; createdAt: string }[];
}

// ── helpers ─────────────────────────────────────────────────────────────────
const PALETTE = ['hsl(217 91% 60%)', 'hsl(160 84% 39%)', 'hsl(38 92% 50%)', 'hsl(280 75% 62%)', 'hsl(0 84% 60%)'];
const colorFor = (i: number) => PALETTE[i % PALETTE.length];
const PHASES = ['row+tokens', 'image', 'provider-create', 'before-active-hook', 'row-active'];
const PHASE_COLORS: Record<string, string> = {
  'row+tokens': 'hsl(217 60% 55%)', image: 'hsl(160 60% 42%)',
  'provider-create': 'hsl(38 80% 52%)', 'before-active-hook': 'hsl(280 55% 60%)',
  'row-active': 'hsl(220 9% 55%)',
};
const statusBadge = (s: string): 'default' | 'secondary' | 'destructive' | 'outline' =>
  s === 'active' ? 'default' : s === 'error' ? 'destructive' : s === 'provisioning' ? 'secondary' : 'outline';
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtMs = (ms?: number | null) =>
  ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// flat bordered stat strip that matches the table surface (no raised gray cards)
function StatStrip({ items }: { items: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'default' | 'success' | 'danger' | 'warning' }[] }) {
  const tone = { default: '', success: 'text-emerald-500', danger: 'text-red-500', warning: 'text-amber-500' };
  return (
    <div className="rounded-2xl border border-border/60 overflow-hidden grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-border/60">
      {items.map((it, i) => (
        <div key={i} className="p-4 min-w-0">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 truncate">{it.label}</div>
          <div className={cn('mt-1 text-2xl font-semibold tracking-tight tabular-nums truncate', tone[it.tone ?? 'default'])}>{it.value}</div>
          {it.hint != null && <div className="mt-0.5 text-xs text-muted-foreground truncate">{it.hint}</div>}
        </div>
      ))}
    </div>
  );
}

export default function ProvidersPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState(7);

  const distQ = useQuery({
    queryKey: ['admin', 'provider-distribution'],
    queryFn: async () => {
      const r = await backendApi.get<Dist>('/admin/api/provider-distribution');
      if (r.error) throw new Error(r.error.message);
      return r.data!;
    },
  });
  const listQ = useQuery({
    queryKey: ['admin', 'sandboxes'],
    queryFn: async () => {
      const r = await backendApi.get<SbxResp>('/admin/api/sandboxes?limit=300');
      if (r.error) throw new Error(r.error.message);
      return r.data!;
    },
    refetchInterval: 10_000,
  });
  const anQ = useQuery({
    queryKey: ['admin', 'provider-analytics', days],
    queryFn: async () => {
      const r = await backendApi.get<Analytics>(`/admin/api/provider-analytics?days=${days}`);
      if (r.error) throw new Error(r.error.message);
      return r.data!;
    },
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
      const r = await backendApi.put('/admin/api/provider-distribution', body);
      if (r.error) throw new Error(r.error.message);
      return r.data;
    },
    onSuccess: () => { toast.success('Distribution saved'); qc.invalidateQueries({ queryKey: ['admin', 'provider-distribution'] }); },
    onError: (e: any) => toast.error(e?.message ?? 'Save failed'),
  });

  const [migrating, setMigrating] = useState<Sbx | null>(null);
  const [target, setTarget] = useState('');
  const migrate = useMutation({
    mutationFn: async () => {
      const r = await backendApi.post(`/admin/api/sandboxes/${migrating!.sessionId}/migrate`, { targetProvider: target });
      if (r.error) throw new Error(r.error.message);
      return r.data;
    },
    onSuccess: () => { toast.success(`Migrating to ${target}…`); setMigrating(null); qc.invalidateQueries({ queryKey: ['admin', 'sandboxes'] }); },
    onError: (e: any) => toast.error(e?.message ?? 'Migrate failed'),
  });

  const dist = distQ.data;
  const allowed = dist?.allowed ?? [];
  const totalW = allowed.reduce((s, p) => s + (Number(weights[p]) || 0), 0);
  const list = listQ.data;
  const targets = migrating ? allowed.filter((p) => p !== migrating.provider) : [];

  const countByProvider = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of list?.byProvider ?? []) m[b.provider] = b.count;
    return m;
  }, [list]);
  const totalSandboxes = useMemo(() => (list?.byProvider ?? []).reduce((s, b) => s + b.count, 0), [list]);

  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list?.sandboxes ?? [];
    if (!q) return all;
    return all.filter((s) =>
      [s.provider, s.status, s.sessionId, s.accountId, s.externalId ?? ''].some((v) => v.toLowerCase().includes(q)));
  }, [list, search]);

  // analytics derived chart shapes
  const an = anQ.data;
  const anProviders = an?.providers.map((p) => p.provider) ?? [];
  const chartConfig: ChartConfig = useMemo(() => {
    const c: ChartConfig = {};
    anProviders.forEach((p, i) => { c[p] = { label: p[0].toUpperCase() + p.slice(1), color: colorFor(i) }; });
    return c;
  }, [an]);
  const phaseData = useMemo(
    () => (an?.providers ?? []).map((p) => {
      const row: Record<string, any> = { provider: p.provider[0].toUpperCase() + p.provider.slice(1) };
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

  return (
    <SectionContainer>
      <SectionHeader
        icon={Boxes}
        title="Sandbox Providers"
        description="Balance new sandboxes across providers, inspect what each is running, migrate sessions between providers, and track how each provider performs."
        actions={
          <Button variant="outline" size="sm" disabled={listQ.isFetching || anQ.isFetching}
            onClick={() => { listQ.refetch(); if (tab === 'analytics') anQ.refetch(); }} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', (listQ.isFetching || anQ.isFetching) && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="grid w-full max-w-xs grid-cols-2">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        {/* ── OVERVIEW ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6">
          <StatStrip
            items={[
              { label: 'Total sandboxes', value: totalSandboxes.toLocaleString(), hint: 'Across all providers' },
              ...allowed.map((p) => {
                const pct = totalW > 0 ? Math.round((Number(weights[p]) || 0) / totalW * 100) : 0;
                return { label: p, value: (countByProvider[p] ?? 0).toLocaleString(), hint: `${pct}% of new sandboxes` };
              }),
            ]}
          />

          <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold tracking-tight">Split distribution</h2>
              <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
                Weighted-random selection for new sandboxes across the available providers. All-zero falls back to
                the default{dist ? ` (${dist.default})` : ''}. An explicit per-request provider always wins.
              </p>
            </div>
            {distQ.isLoading ? (
              <Skeleton className="h-24 w-full rounded-2xl" />
            ) : (
              <>
                <div className="flex flex-wrap gap-4">
                  {allowed.map((p) => {
                    const pct = totalW > 0 ? Math.round((Number(weights[p]) || 0) / totalW * 100) : 0;
                    return (
                      <div key={p} className="space-y-1.5 w-40">
                        <label className="text-xs font-medium capitalize flex items-center gap-1.5 text-muted-foreground">
                          {p}{p === dist?.default && <Badge variant="outline" size="sm" className="text-[10px]">default</Badge>}
                        </label>
                        <Input type="number" min={0} value={weights[p] ?? ''}
                          onChange={(e) => setWeights({ ...weights, [p]: e.target.value })} className="rounded-2xl" />
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">{pct}% of traffic</div>
                      </div>
                    );
                  })}
                </div>
                <Button size="sm" onClick={() => saveWeights.mutate()} disabled={saveWeights.isPending || !allowed.length} className="gap-1.5">
                  {saveWeights.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save distribution
                </Button>
              </>
            )}
          </div>

          <PageSearchBar value={search} onChange={setSearch} placeholder="Search by provider, status, session, account, or external ID…" />

          {listQ.isLoading ? (
            <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-2xl" />)}</div>
          ) : rows.length === 0 ? (
            <div className="rounded-2xl border border-border/60 bg-card">
              <EmptyState icon={IconInbox}
                title={search ? 'No sandboxes match your search' : 'No sandboxes yet'}
                description={search ? 'Try a different search term.' : 'New sandboxes appear here as sessions spin up.'}
                action={search ? <Button variant="outline" size="sm" onClick={() => setSearch('')}>Clear search</Button> : undefined} />
            </div>
          ) : (
            <div className={cn('rounded-2xl border border-border/60 overflow-hidden transition-opacity', listQ.isFetching && 'opacity-70')}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Provider</TableHead><TableHead>Status</TableHead>
                    <TableHead>Session</TableHead><TableHead>Account</TableHead>
                    <TableHead>Last used</TableHead><TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const canMigrate = allowed.filter((p) => p !== s.provider).length > 0;
                    return (
                      <TableRow key={s.sandboxId}>
                        <TableCell><Badge variant="outline" size="sm" className="capitalize">{s.provider}</Badge></TableCell>
                        <TableCell><Badge variant={statusBadge(s.status)} size="sm" className="capitalize">{s.status}</Badge></TableCell>
                        <TableCell>
                          <div className="min-w-0 max-w-[280px]">
                            <div className="truncate font-mono text-xs">{s.sessionId?.slice(0, 8)}</div>
                            {s.externalId && <div className="truncate text-xs text-muted-foreground font-mono">{s.externalId.slice(0, 22)}</div>}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{s.accountId?.slice(0, 8)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{fmtDate(s.lastUsedAt)}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem disabled={!canMigrate}
                                onClick={() => { setMigrating(s); setTarget(allowed.find((p) => p !== s.provider) ?? ''); }}>
                                <ArrowRightLeft className="h-4 w-4 mr-2" />Migrate to another provider…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ── ANALYTICS ────────────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="space-y-6">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">How each provider performs — provisioning latency, success rate, and where the time goes.</p>
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[130px] h-9 rounded-2xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Last 24h</SelectItem>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {anQ.isLoading ? (
            <div className="space-y-4"><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-72 w-full rounded-2xl" /></div>
          ) : !an || an.totals.provisions === 0 ? (
            <div className="rounded-2xl border border-border/60 bg-card">
              <EmptyState icon={IconInbox} title="No provisioning data yet"
                description="Provision a few sandboxes and their timing + outcome will show up here." />
            </div>
          ) : (
            <>
              <StatStrip items={[
                { label: 'Provisions', value: an.totals.provisions.toLocaleString(), hint: `${an.totals.migrations} migrations` },
                { label: 'Success rate', value: an.totals.successRate == null ? '—' : `${an.totals.successRate}%`,
                  tone: an.totals.successRate != null && an.totals.successRate < 90 ? 'warning' : 'success',
                  hint: `${an.totals.ok} ok · ${an.totals.error} err` },
                { label: 'Errors', value: an.totals.error.toLocaleString(), tone: an.totals.error > 0 ? 'danger' : 'default',
                  hint: an.totals.stopped ? `${an.totals.stopped} stopped` : 'none stopped' },
                { label: 'Providers', value: an.providers.length, hint: anProviders.join(' · ') || '—' },
              ]} />

              {/* per-provider summary table */}
              <div className="rounded-2xl border border-border/60 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Provider</TableHead><TableHead className="text-right">Provisions</TableHead>
                      <TableHead className="text-right">Success</TableHead><TableHead className="text-right">p50</TableHead>
                      <TableHead className="text-right">p95</TableHead><TableHead className="text-right">Errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {an.providers.map((p, i) => (
                      <TableRow key={p.provider}>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorFor(i) }} />
                            <span className="capitalize font-medium">{p.provider}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{p.provisions}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', p.successRate != null && p.successRate < 90 && 'text-amber-500')}>
                          {p.successRate == null ? '—' : `${p.successRate}%`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMs(p.p50Ms)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMs(p.p95Ms)}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', p.error > 0 && 'text-red-500')}>{p.error}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* latency over time */}
                <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-3">
                  <div><h3 className="text-sm font-semibold tracking-tight">Provisioning latency (p50)</h3>
                    <p className="text-xs text-muted-foreground">Median time to a ready sandbox, per provider per day.</p></div>
                  <ChartContainer config={chartConfig} className="h-[260px] w-full">
                    <AreaChart accessibilityLayer data={an.latencyByDay} margin={{ left: 4, right: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={fmtDay} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} width={42} tickFormatter={(v) => fmtMs(v)} />
                      <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => fmtDay(String(l))} />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      {anProviders.map((p) => (
                        <Area key={p} type="monotone" dataKey={p} stroke={`var(--color-${p})`} fill={`var(--color-${p})`}
                          fillOpacity={0.12} strokeWidth={2} connectNulls dot={false} />
                      ))}
                    </AreaChart>
                  </ChartContainer>
                </div>

                {/* volume per day */}
                <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-3">
                  <div><h3 className="text-sm font-semibold tracking-tight">Provision volume</h3>
                    <p className="text-xs text-muted-foreground">Sandboxes provisioned per provider per day.</p></div>
                  <ChartContainer config={chartConfig} className="h-[260px] w-full">
                    <BarChart accessibilityLayer data={an.volumeByDay} margin={{ left: 4, right: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={fmtDay} minTickGap={24} />
                      <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                      <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => fmtDay(String(l))} />} />
                      <ChartLegend content={<ChartLegendContent />} />
                      {anProviders.map((p) => (
                        <Bar key={p} dataKey={p} stackId="v" fill={`var(--color-${p})`} radius={2} />
                      ))}
                    </BarChart>
                  </ChartContainer>
                </div>
              </div>

              {/* phase breakdown — where the time goes */}
              <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-3">
                <div><h3 className="text-sm font-semibold tracking-tight">Where the time goes</h3>
                  <p className="text-xs text-muted-foreground">Average duration of each provisioning phase (successful provisions), per provider.</p></div>
                <ChartContainer config={phaseConfig} className="h-[220px] w-full">
                  <BarChart accessibilityLayer data={phaseData} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid horizontal={false} />
                    <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => fmtMs(v)} />
                    <YAxis type="category" dataKey="provider" tickLine={false} axisLine={false} width={80} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    {PHASES.map((ph, i) => (
                      <Bar key={ph} dataKey={ph} stackId="p" fill={`var(--color-${ph})`}
                        radius={i === 0 ? [4, 0, 0, 4] : i === PHASES.length - 1 ? [0, 4, 4, 0] : 0} />
                    ))}
                  </BarChart>
                </ChartContainer>
              </div>

              {an.recentErrors.length > 0 && (
                <div className="rounded-2xl border border-border/60 overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/60"><h3 className="text-sm font-semibold tracking-tight">Recent errors</h3></div>
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Provider</TableHead><TableHead>Class</TableHead>
                        <TableHead>Error</TableHead><TableHead>When</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {an.recentErrors.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell><Badge variant="outline" size="sm" className="capitalize">{e.provider}</Badge></TableCell>
                          <TableCell>{e.errorClass === 'capacity'
                            ? <Badge variant="secondary" size="sm">capacity</Badge>
                            : <span className="text-xs text-muted-foreground">{e.errorClass ?? '—'}</span>}</TableCell>
                          <TableCell className="max-w-[420px] truncate text-xs text-muted-foreground" title={e.error ?? ''}>{e.error ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* ── migrate dialog ───────────────────────────────────────────────────── */}
      <Dialog open={!!migrating} onOpenChange={(o) => { if (!o) setMigrating(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Migrate sandbox</DialogTitle>
            <DialogDescription>
              Move session <span className="font-mono">{migrating?.sessionId?.slice(0, 8)}</span> off
              <Badge variant="outline" size="sm" className="capitalize mx-1">{migrating?.provider}</Badge>
              to another provider. The session's working tree is flushed to its git branch, a fresh sandbox is
              provisioned on the target (re-cloning the branch), and the old one is removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <label className="text-sm font-medium">Target provider</label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger><SelectValue placeholder="Choose a provider" /></SelectTrigger>
              <SelectContent>{targets.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMigrating(null)}>Cancel</Button>
            <Button onClick={() => migrate.mutate()} disabled={!target || migrate.isPending} className="gap-1.5">
              {migrate.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Migrate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionContainer>
  );
}
