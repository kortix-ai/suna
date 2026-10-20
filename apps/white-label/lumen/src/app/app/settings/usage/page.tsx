'use client';

import { useFirm } from '@/components/access';
import { AdminOnly } from '@/components/admin-only';
import { KIND } from '@/components/runs/history-list';
import { downloadCsv } from '@/lib/csv';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { Skeleton } from '@kortix/ui/skeleton';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';

export default function UsagePage() {
  return (
    <AdminOnly>
      <Usage />
    </AdminOnly>
  );
}

function Bars({ rows }: { rows: { label: string; value: number; detail?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
          <span className="truncate">{r.label}</span>
          <span className="h-2 rounded-full bg-muted">
            <span className="block h-2 rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs text-muted-foreground" title={r.detail}>{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl">{value}</p>
    </div>
  );
}

function Usage() {
  const firm = useFirm();
  const u = useQuery(api.usage.summary, { firmId: firm._id });
  const directory = useQuery(api.members.directory, { firmId: firm._id });
  const logExport = useMutation(api.audit.logExport);
  if (!u) return <Skeleton className="h-60 rounded-xl" />;
  const name = (id: string) => directory?.find((d) => d.userId === id)?.name || directory?.find((d) => d.userId === id)?.email || '…';
  const total = u.threads + u.runs;
  const minutes = Math.round(u.agentMs / 60_000);

  function exportCsv() {
    downloadCsv('lumen-usage-30d.csv', [
      ['kind', 'name', 'conversations', 'runs'],
      ...u!.byMember.map((r) => ['member', name(r.userId), r.threads, r.runs]),
      ...u!.byMatter.map((r) => ['matter', r.name, r.threads, r.runs]),
      ...u!.byKind.map((r) => ['run kind', KIND[r.kind]?.label ?? r.kind, 0, r.runs]),
    ]);
    void logExport({ firmId: firm._id, what: 'usage (30 days)' });
  }

  const both = (r: { threads: number; runs: number }) => ({ value: r.threads + r.runs, detail: `${r.threads} conversations, ${r.runs} runs` });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">Last 30 days</p>
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={total === 0}>
          <DownloadSimpleIcon className="size-4" /> Export CSV
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-total">
        <Stat label="Conversations" value={u.threads} />
        <Stat label="Workflow runs" value={u.runs} />
        <Stat label="Documents read by runs" value={u.documentsRead} />
        <Stat label="Agent time" value={minutes < 1 && u.agentMs > 0 ? '< 1 min' : `${minutes} min`} />
      </div>
      {total === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No conversations or runs in the last 30 days.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 text-sm font-medium">By member</h2>
            <Bars rows={u.byMember.map((r) => ({ label: name(r.userId), ...both(r) }))} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 text-sm font-medium">By matter</h2>
            <Bars rows={u.byMatter.map((r) => ({ label: r.name, ...both(r) }))} />
          </section>
          {u.byKind.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-5 md:col-span-2">
              <h2 className="mb-3 text-sm font-medium">Runs by workflow</h2>
              <Bars rows={u.byKind.map((r) => ({ label: KIND[r.kind]?.label ?? r.kind, value: r.runs }))} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
