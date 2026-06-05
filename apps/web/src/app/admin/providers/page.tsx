'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, RefreshCw } from 'lucide-react';

import { backendApi } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Dist { allowed: string[]; default: string; weights: Record<string, number>; }
interface Sbx {
  sandboxId: string; sessionId: string; accountId: string; projectId: string;
  provider: string; externalId: string | null; status: string; lastUsedAt: string | null;
}
interface SbxResp { sandboxes: Sbx[]; byProvider: { provider: string; count: number }[]; }

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'provider-distribution'] }),
  });

  const migrate = useMutation({
    mutationFn: async ({ sessionId, target }: { sessionId: string; target: string }) => {
      const r = await backendApi.post(`/admin/api/sandboxes/${sessionId}/migrate`, { targetProvider: target });
      if (r.error) throw new Error(r.error.message);
      return r.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'sandboxes'] }),
  });

  const dist = distQ.data;
  const list = listQ.data;
  const allowed = dist?.allowed ?? [];
  const totalW = allowed.reduce((s, p) => s + (Number(weights[p]) || 0), 0);

  return (
    <div className="p-6 space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Sandbox Providers</h1>
        <p className="text-sm text-muted-foreground">
          Load-balance new sandboxes across providers, see what each sandbox is using, and migrate between providers.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Split distribution</h2>
        <p className="text-xs text-muted-foreground">
          Weighted-random selection for NEW sandboxes across allowed providers. All-zero falls back to the
          default ({dist?.default ?? '…'}). An explicit per-request provider always wins.
        </p>
        <div className="flex flex-wrap gap-4 items-end">
          {allowed.map((p) => (
            <div key={p} className="space-y-1">
              <label className="text-xs font-medium capitalize">{p}{p === dist?.default ? ' (default)' : ''}</label>
              <Input type="number" min={0} className="w-28" value={weights[p] ?? ''}
                onChange={(e) => setWeights({ ...weights, [p]: e.target.value })} />
              <div className="text-[10px] text-muted-foreground">{totalW > 0 ? Math.round((Number(weights[p]) || 0) / totalW * 100) : 0}%</div>
            </div>
          ))}
          <Button onClick={() => saveWeights.mutate()} disabled={saveWeights.isPending || !allowed.length}>
            {saveWeights.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Save
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-medium">Sandboxes by provider</h2>
          <Button variant="ghost" size="sm" onClick={() => listQ.refetch()}><RefreshCw className="h-4 w-4" /></Button>
          {list?.byProvider?.map((b) => (
            <Badge key={b.provider} variant="secondary" className="capitalize">{b.provider}: {b.count}</Badge>
          ))}
        </div>
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-2">Provider</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Session</th>
                <th className="text-left p-2">Account</th>
                <th className="text-left p-2">Migrate to</th>
              </tr>
            </thead>
            <tbody>
              {(list?.sandboxes ?? []).map((s) => (
                <tr key={s.sandboxId} className="border-t">
                  <td className="p-2"><Badge className="capitalize">{s.provider}</Badge></td>
                  <td className="p-2">{s.status}</td>
                  <td className="p-2 font-mono text-xs">{s.sessionId?.slice(0, 8)}</td>
                  <td className="p-2 font-mono text-xs">{s.accountId?.slice(0, 8)}</td>
                  <td className="p-2 flex gap-1">
                    {allowed.filter((p) => p !== s.provider).map((p) => (
                      <Button key={p} size="sm" variant="outline" disabled={migrate.isPending}
                        onClick={() => migrate.mutate({ sessionId: s.sessionId, target: p })}>
                        <ArrowRightLeft className="h-3 w-3 mr-1" />{p}
                      </Button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
