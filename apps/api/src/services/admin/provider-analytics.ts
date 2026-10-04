import type { listProviderEventsSince } from './queries';

/** The `GET /api/provider-analytics` body, aggregated from `days` of provider_events rows. */
export function summarizeProviderAnalytics(rows: Awaited<ReturnType<typeof listProviderEventsSince>>, days: number) {
  const pct = (xs: number[], p: number): number => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]);
  };
  const normLabel = (l: string): string =>
    l.startsWith('provider-create') ? 'provider-create'
      : (l === 'image-built' || l === 'image-cached') ? 'image' : l;
  const dayKey = (d: Date): string => new Date(d).toISOString().slice(0, 10);

  const provision = rows.filter((r: any) => r.kind === 'provision');
  const migrate = rows.filter((r: any) => r.kind === 'migrate');
  const provNames = Array.from(new Set(provision.map((r: any) => r.provider))).sort();

  // Per-provider summary + phase breakdown.
  const providers = provNames.map((p) => {
    const evs = provision.filter((r: any) => r.provider === p);
    const ok = evs.filter((r: any) => r.outcome === 'ok');
    const error = evs.filter((r: any) => r.outcome === 'error');
    const stopped = evs.filter((r: any) => r.outcome === 'stopped');
    const okMs = ok.map((r: any) => r.totalMs ?? 0).filter((n: number) => n > 0);
    const finished = ok.length + error.length;
    const phaseTotals: Record<string, { sum: number; n: number }> = {};
    for (const r of ok) {
      for (const m of (r.marks as any[]) ?? []) {
        const k = normLabel(String(m.label));
        const d = Number(m.deltaMs) || 0;
        (phaseTotals[k] ||= { sum: 0, n: 0 }).sum += d;
        phaseTotals[k].n += 1;
      }
    }
    const phases = Object.entries(phaseTotals).map(([label, v]) => ({ label, avgMs: Math.round(v.sum / v.n) }));
    return {
      provider: p,
      provisions: evs.length, ok: ok.length, error: error.length, stopped: stopped.length,
      successRate: finished ? Math.round((ok.length / finished) * 100) : null,
      p50Ms: pct(okMs, 50), p95Ms: pct(okMs, 95),
      avgMs: okMs.length ? Math.round(okMs.reduce((a: number, b: number) => a + b, 0) / okMs.length) : 0,
      phases,
    };
  });

  // Daily time-series: provision count + p50 latency per provider per day.
  const dayBuckets: Record<string, Record<string, number[]>> = {};
  for (const r of provision as any[]) {
    const dk = dayKey(r.createdAt);
    ((dayBuckets[dk] ||= {})[r.provider] ||= []);
    if (r.outcome === 'ok' && r.totalMs) dayBuckets[dk][r.provider].push(r.totalMs);
  }
  const allDays: string[] = [];
  for (let i = days - 1; i >= 0; i--) allDays.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  const countByDay: Record<string, Record<string, number>> = {};
  for (const r of provision as any[]) {
    const dk = dayKey(r.createdAt);
    (countByDay[dk] ||= {});
    countByDay[dk][r.provider] = (countByDay[dk][r.provider] || 0) + 1;
  }
  const latencyByDay = allDays.map((d) => {
    const row: Record<string, unknown> = { date: d };
    for (const p of provNames) row[p] = dayBuckets[d]?.[p]?.length ? pct(dayBuckets[d][p], 50) : null;
    return row;
  });
  const volumeByDay = allDays.map((d) => {
    const row: Record<string, unknown> = { date: d };
    for (const p of provNames) row[p] = countByDay[d]?.[p] ?? 0;
    return row;
  });

  // Migration flows.
  const flowMap: Record<string, number> = {};
  for (const r of migrate as any[]) {
    const key = `${r.fromProvider ?? '?'}→${r.provider}`;
    flowMap[key] = (flowMap[key] || 0) + 1;
  }
  const migrations = Object.entries(flowMap).map(([flow, count]) => ({ flow, count }));

  const okTot = provision.filter((r: any) => r.outcome === 'ok').length;
  const errTot = provision.filter((r: any) => r.outcome === 'error').length;
  const recentErrors = (rows as any[])
    .filter((r) => r.outcome === 'error')
    .slice(0, 10)
    .map((r) => ({ provider: r.provider, errorClass: r.errorClass, error: r.error, createdAt: r.createdAt }));

  return {
    days,
    totals: {
      provisions: provision.length, ok: okTot, error: errTot,
      stopped: provision.filter((r: any) => r.outcome === 'stopped').length,
      migrations: migrate.length,
      successRate: okTot + errTot ? Math.round((okTot / (okTot + errTot)) * 100) : null,
    },
    providers, latencyByDay, volumeByDay, migrations, recentErrors,
  };
}
