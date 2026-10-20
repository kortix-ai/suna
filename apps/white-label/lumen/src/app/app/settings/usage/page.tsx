'use client';

import { useFirm } from '@/components/access';
import { AdminOnly } from '@/components/admin-only';
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

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[10rem_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
          <span className="truncate">{r.label}</span>
          <span className="h-2 rounded-full bg-muted">
            <span className="block h-2 rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs text-muted-foreground">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Usage() {
  const firm = useFirm();
  const u = useQuery(api.usage.summary, { firmId: firm._id });
  const directory = useQuery(api.members.directory, { firmId: firm._id });
  const logExport = useMutation(api.audit.logExport);
  if (!u) return <Skeleton className="h-60 rounded-xl" />;
  const name = (id: string) => directory?.find((d) => d.userId === id)?.name || directory?.find((d) => d.userId === id)?.email || '…';

  function exportCsv() {
    downloadCsv('lumen-usage-30d.csv', [
      ['kind', 'name', 'conversations'],
      ...u!.byMember.map((r) => ['member', name(r.userId), r.threads]),
      ...u!.byMatter.map((r) => ['matter', r.name, r.threads]),
    ]);
    void logExport({ firmId: firm._id, what: 'usage (30 days)' });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Last 30 days</p>
          <p className="font-display text-3xl" data-testid="usage-total">
            {u.threads} conversation{u.threads === 1 ? '' : 's'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={u.threads === 0}>
          <DownloadSimpleIcon className="size-4" /> Export CSV
        </Button>
      </div>
      {u.threads === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No conversations in the last 30 days.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 text-sm font-medium">By member</h2>
            <Bars rows={u.byMember.map((r) => ({ label: name(r.userId), value: r.threads }))} />
          </section>
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 text-sm font-medium">By matter</h2>
            <Bars rows={u.byMatter.map((r) => ({ label: r.name, value: r.threads }))} />
          </section>
        </div>
      )}
    </div>
  );
}
