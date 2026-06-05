'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Boxes, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react';

import { backendApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface Dist { allowed: string[]; default: string; weights: Record<string, number>; }
interface Sbx {
  sandboxId: string; sessionId: string; accountId: string; projectId: string;
  provider: string; externalId: string | null; status: string; lastUsedAt: string | null;
}
interface SbxResp { sandboxes: Sbx[]; byProvider: { provider: string; count: number }[]; }

const statusVariant = (s: string): 'default' | 'secondary' | 'destructive' | 'outline' =>
  s === 'active' ? 'default' : s === 'error' ? 'destructive' : s === 'provisioning' ? 'secondary' : 'outline';

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

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-muted p-2"><Boxes className="h-5 w-5" /></div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sandbox Providers</h1>
          <p className="text-sm text-muted-foreground">Balance new sandboxes across providers, see what each is using, and migrate between them.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Split distribution</CardTitle>
          <CardDescription>
            Weighted-random selection for new sandboxes across the available providers. All-zero falls back to the
            default{dist ? ` (${dist.default})` : ''}. An explicit per-request provider always wins.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {distQ.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-5">
                {allowed.map((p) => {
                  const pct = totalW > 0 ? Math.round((Number(weights[p]) || 0) / totalW * 100) : 0;
                  return (
                    <div key={p} className="space-y-1.5 w-36">
                      <label className="text-sm font-medium capitalize flex items-center gap-1.5">
                        {p}{p === dist?.default && <Badge variant="outline" className="text-[10px]">default</Badge>}
                      </label>
                      <Input type="number" min={0} value={weights[p] ?? ''}
                        onChange={(e) => setWeights({ ...weights, [p]: e.target.value })} />
                      <div className="h-1.5 rounded bg-muted overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-xs text-muted-foreground">{pct}% of traffic</div>
                    </div>
                  );
                })}
              </div>
              <Button onClick={() => saveWeights.mutate()} disabled={saveWeights.isPending || !allowed.length}>
                {saveWeights.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Save distribution
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Sandboxes</CardTitle>
            <CardDescription>Every active sandbox and the provider it runs on.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {list?.byProvider?.map((b) => (
              <Badge key={b.provider} variant="secondary" className="capitalize">{b.provider} · {b.count}</Badge>
            ))}
            <Button variant="ghost" size="icon" onClick={() => listQ.refetch()}>
              <RefreshCw className={`h-4 w-4 ${listQ.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {listQ.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list?.sandboxes ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">No sandboxes</TableCell></TableRow>
                )}
                {(list?.sandboxes ?? []).map((s) => {
                  const canMigrate = allowed.filter((p) => p !== s.provider).length > 0;
                  return (
                    <TableRow key={s.sandboxId}>
                      <TableCell><Badge className="capitalize">{s.provider}</Badge></TableCell>
                      <TableCell><Badge variant={statusVariant(s.status)} className="capitalize">{s.status}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{s.sessionId?.slice(0, 8)}</TableCell>
                      <TableCell className="font-mono text-xs">{s.accountId?.slice(0, 8)}</TableCell>
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
          )}
        </CardContent>
      </Card>

      <Dialog open={!!migrating} onOpenChange={(o) => { if (!o) setMigrating(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Migrate sandbox</DialogTitle>
            <DialogDescription>
              Move <span className="font-mono">{migrating?.sessionId?.slice(0, 8)}</span> off
              <Badge className="capitalize mx-1">{migrating?.provider}</Badge>
              to another provider. A fresh sandbox is provisioned on the target (the repo re-clones) and the old one is removed.
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
            <Button onClick={() => migrate.mutate()} disabled={!target || migrate.isPending}>
              {migrate.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Migrate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
