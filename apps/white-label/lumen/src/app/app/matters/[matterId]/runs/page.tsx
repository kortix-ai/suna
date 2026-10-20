'use client';

import { useMatter } from '@/components/access';
import { Elapsed, RunStatusBadge } from '@/components/runs/run-parts';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast } from '@kortix/ui/toast';
import { ChatCircleTextIcon, TableIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function RunsPage() {
  const { matter } = useMatter();
  const router = useRouter();
  const runs = useQuery(api.runs.listForMatter, { matterId: matter._id });
  const docs = useQuery(api.documents.list, { matterId: matter._id });
  const startReview = useMutation(api.runs.startReview);
  const ask = useMutation(api.runs.ask);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<'review' | 'ask' | null>(null);
  const ready = docs?.filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0).length ?? 0;
  const base = `/app/matters/${matter._id}`;

  async function go(kind: 'review' | 'ask') {
    setPending(kind);
    try {
      const runId = kind === 'review' ? (await startReview({ matterId: matter._id })).runId : await ask({ matterId: matter._id, question });
      router.push(`${base}/runs/${runId}`);
    } catch (err) {
      errorToast(kind === 'review' ? 'Could not start the review' : 'Could not ask', { description: errorText(err) });
      setPending(null);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">Runs</h2>
          <span className="text-xs text-muted-foreground">Reviews and questions on this matter</span>
        </header>
        {runs === undefined ? (
          <div className="space-y-2 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : !runs || runs.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            Runs and their results appear here. Start a review to turn the vault into a table.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((r) => (
              <li key={r._id}>
                <Link href={`${base}/runs/${r._id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40" data-testid="run-row">
                  {r.kind === 'review' ? <TableIcon className="size-4 text-muted-foreground" /> : <ChatCircleTextIcon className="size-4 text-muted-foreground" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.kind === 'review' ? 'Review' : 'Question'} · {r.documentCount} documents · {relativeTime(new Date(r._creationTime).toISOString())}
                      {r.startedAt ? <> · <Elapsed from={r.startedAt} to={r.finishedAt} /></> : null}
                    </span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{r.batchesDone}/{r.batchCount}</span>
                  <RunStatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="space-y-4">
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-medium">Review the vault</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A table of {ready} document{ready === 1 ? '' : 's'} × 8 commercial terms: parties, term, renewal, termination, liability cap, governing
            law, assignment, change of control. Every answer cites its clause.
          </p>
          <Button className="mt-3 w-full" size="sm" disabled={!ready || pending !== null} onClick={() => go('review')}>
            {pending === 'review' ? <Loading className="size-4" /> : <TableIcon className="size-4" />} New review
          </Button>
        </section>
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-medium">Ask across the vault</h2>
          <Textarea
            className="mt-2 min-h-20 text-sm"
            placeholder="Which agreements have uncapped liability?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && question.trim().length >= 3) void go('ask');
            }}
          />
          <Button className="mt-2 w-full" size="sm" variant="outline" disabled={!ready || question.trim().length < 3 || pending !== null} onClick={() => go('ask')}>
            {pending === 'ask' ? <Loading className="size-4" /> : <ChatCircleTextIcon className="size-4" />} Ask
          </Button>
        </section>
      </div>
    </div>
  );
}
