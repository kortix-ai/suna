'use client';

import { useFirm } from '@/components/access';
import { NewMatterDialog } from '@/components/matters/matter-form';
import { useAddSampleMatter } from '@/components/matters/sample-matter';
import { PageBody, PageHeader } from '@/components/page';
import { STATUS_LABEL } from '@/lib/roles';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { BriefcaseIcon, LockSimpleIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Status = 'open' | 'on_hold' | 'closed';

export const statusVariant = (s: string) => (s === 'open' ? 'highlight' : s === 'on_hold' ? 'warning' : 'muted') as 'highlight' | 'warning' | 'muted';

/** Matters the caller can see: search, a status filter, most recent activity first. */
export function MattersList({ startOpen = false }: { startOpen?: boolean }) {
  const firm = useFirm();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [open, setOpen] = useState(startOpen);
  const matters = useQuery(api.matters.list, {
    firmId: firm._id, search: search.trim() || undefined, status: status === 'all' ? undefined : status,
  });
  const filtering = search.trim() !== '' || status !== 'all';
  const sample = useAddSampleMatter();
  const addSample = () =>
    sample.add(firm._id).then(
      (id) => router.push(`/app/matters/${id}/vault`),
      (err) => errorToast('Could not add the sample matter', { description: errorText(err) }),
    );

  return (
    <PageBody>
      <PageHeader
        title="Matters"
        description={`Every matter at ${firm.name} you can open.`}
        actions={
          <Button onClick={() => setOpen(true)}>
            <PlusIcon className="size-4" /> New matter
          </Button>
        }
      />
      <NewMatterDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o && startOpen) router.replace('/app/matters');
        }}
        onCreated={(id) => {
          setOpen(false);
          router.push(`/app/matters/${id}`);
        }}
      />

      <div className="mt-6 flex flex-wrap gap-2">
        <div className="relative min-w-60 flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search matters" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, client or number" className="pl-8" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as Status | 'all')}>
          <SelectTrigger aria-label="Status" className="h-10 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="on_hold">On hold</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_6rem_5rem_4rem_6rem] gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
          <span>Matter</span>
          <span>Client</span>
          <span>Status</span>
          <span className="text-right">Documents</span>
          <span className="text-right">Runs</span>
          <span className="text-right">Last activity</span>
        </div>
        {matters === undefined &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="border-b border-border/60 px-4 py-3 last:border-0">
              <Skeleton className="h-5 w-full" />
            </div>
          ))}
        {matters?.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <BriefcaseIcon className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {filtering ? 'No matter matches these filters.' : 'No matters yet. Create your first matter, or open the sample matter.'}
            </p>
            {!filtering && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setOpen(true)}>
                  <PlusIcon className="size-4" /> New matter
                </Button>
                <Button size="sm" variant="outline" disabled={sample.progress !== null} onClick={addSample}>
                  {sample.progress !== null && <Loading className="size-4" />} {sample.progress ?? 'Open the sample matter'}
                </Button>
              </div>
            )}
          </div>
        )}
        <ul aria-label="Matters">
          {matters?.map((m) => (
            <li key={m._id} className="border-b border-border/60 last:border-0">
              <Link
                href={`/app/matters/${m._id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/50 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_6rem_5rem_4rem_6rem]"
              >
                <span className="flex w-full min-w-0 items-center gap-2 md:w-auto">
                  <span className="truncate font-medium">{m.name}</span>
                  {m.number && <span className="shrink-0 font-mono text-xs text-muted-foreground">{m.number}</span>}
                  {m.visibility === 'restricted' && <LockSimpleIcon aria-label="Restricted" className="size-3.5 shrink-0 text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground md:flex-none">{m.client || '—'}</span>
                <span className="hidden md:block">
                  <Badge variant={statusVariant(m.status)}>{STATUS_LABEL[m.status]}</Badge>
                </span>
                <span className="hidden text-right font-mono text-xs text-muted-foreground md:block">{m.documentCount}</span>
                <span className="hidden text-right font-mono text-xs text-muted-foreground md:block">{m.runCount}</span>
                <span className="text-right text-xs text-muted-foreground">
                  <span className="md:hidden">
                    <Badge variant={statusVariant(m.status)}>{STATUS_LABEL[m.status]}</Badge> · {m.documentCount} docs ·{' '}
                  </span>
                  {relativeTime(new Date(m.lastActivityAt).toISOString())}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </PageBody>
  );
}
