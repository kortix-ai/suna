'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Boxes, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';

import { backendApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';

import { SectionContainer, SectionHeader, StatPill, StatRow } from '../_components/section-header';

interface Dist { allowed: string[]; default: string; weights: Record<string, number>; }
interface Sbx {
  sandboxId: string; sessionId: string; accountId: string; projectId: string;
  provider: string; externalId: string | null; status: string; lastUsedAt: string | null;
}
interface SbxResp { sandboxes: Sbx[]; byProvider: { provider: string; count: number }[]; }

const statusBadge = (s: string): 'default' | 'secondary' | 'destructive' | 'outline' =>
  s === 'active' ? 'default' : s === 'error' ? 'destructive' : s === 'provisioning' ? 'secondary' : 'outline';

const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function ProvidersPage() {
  const qc = useQueryClient();

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
      [s.provider, s.status, s.sessionId, s.accountId, s.externalId ?? '']
        .some((v) => v.toLowerCase().includes(q)),
    );
  }, [list, search]);

  return (
    <SectionContainer>
      <SectionHeader
        icon={Boxes}
        title="Sandbox Providers"
        description="Balance new sandboxes across providers, inspect what each one is running, and migrate a session between providers. Migration re-provisions on the target and re-clones the session's git branch."
        actions={
          <Button variant="outline" size="sm" onClick={() => listQ.refetch()} disabled={listQ.isFetching} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', listQ.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <StatRow>
        <StatPill label="Total sandboxes" value={totalSandboxes.toLocaleString()} hint="Across all providers" />
        {allowed.map((p) => {
          const pct = totalW > 0 ? Math.round((Number(weights[p]) || 0) / totalW * 100) : 0;
          return (
            <StatPill
              key={p}
              label={p}
              value={(countByProvider[p] ?? 0).toLocaleString()}
              hint={`${pct}% of new sandboxes`}
              className="capitalize"
            />
          );
        })}
      </StatRow>

      {/* ── Split distribution editor ─────────────────────────────────────── */}
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
                    <Input
                      type="number" min={0} value={weights[p] ?? ''}
                      onChange={(e) => setWeights({ ...weights, [p]: e.target.value })}
                      className="rounded-2xl"
                    />
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

      {/* ── Search ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <PageSearchBar
          value={search}
          onChange={setSearch}
          placeholder="Search by provider, status, session, account, or external ID…"
        />
      </div>

      {/* ── Sandboxes table ───────────────────────────────────────────────── */}
      {listQ.isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-2xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-border/60 bg-card">
          <EmptyState
            icon={IconInbox}
            title={search ? 'No sandboxes match your search' : 'No sandboxes yet'}
            description={search ? 'Try a different search term.' : 'New sandboxes appear here as sessions spin up.'}
            action={search ? <Button variant="outline" size="sm" onClick={() => setSearch('')}>Clear search</Button> : undefined}
          />
        </div>
      ) : (
        <div className={cn('rounded-2xl border border-border/60 overflow-hidden transition-opacity', listQ.isFetching && 'opacity-70')}>
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
                      <Badge variant="outline" size="sm" className="capitalize">{s.provider}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadge(s.status)} size="sm" className="capitalize">{s.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="min-w-0 max-w-[280px]">
                        <div className="truncate font-mono text-xs">{s.sessionId?.slice(0, 8)}</div>
                        {s.externalId && (
                          <div className="truncate text-xs text-muted-foreground font-mono">{s.externalId.slice(0, 22)}</div>
                        )}
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
                          <DropdownMenuItem
                            disabled={!canMigrate}
                            onClick={() => { setMigrating(s); setTarget(allowed.find((p) => p !== s.provider) ?? ''); }}
                          >
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

      {/* ── Migrate dialog ────────────────────────────────────────────────── */}
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
              <SelectContent>
                {targets.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
              </SelectContent>
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
