'use client';

import { useMatter } from '@/components/access';
import { type ColumnDraft, ColumnBuilder, blankColumn, columnsReady, toColumns } from '@/components/reviews/column-builder';
import { DocumentPicker } from '@/components/workflows/document-picker';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { PRESET_COLUMNS } from '@convex/lib/columns';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { errorToast } from '@kortix/ui/toast';
import { CaretLeftIcon, TableIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from 'convex/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function NewReviewPage() {
  const { matter } = useMatter();
  const router = useRouter();
  const docs = useQuery(api.documents.list, { matterId: matter._id });
  const create = useMutation(api.reviews.create);
  const [title, setTitle] = useState('Commercial contract basics');
  const [picked, setPicked] = useState<Id<'documents'>[] | null>(null);
  const [columns, setColumns] = useState<ColumnDraft[]>(() => PRESET_COLUMNS.map((c) => ({ ...c })));
  const [pending, setPending] = useState(false);
  const base = `/app/matters/${matter._id}`;
  const ready = (docs ?? []).filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0);
  const chosen = picked ?? ready.map((d) => d._id);
  const cells = chosen.length * columns.length;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const { reviewId } = await create({ matterId: matter._id, title, documentIds: chosen, columns: toColumns(columns) });
      router.push(`${base}/reviews/${reviewId}`);
    } catch (err) {
      errorToast('Could not start the review', { description: errorText(err) });
      setPending(false);
    }
  }

  return (
    <form onSubmit={start} className="mx-auto w-full max-w-6xl space-y-5 px-4 py-6 sm:px-6">
      <Link href={`${base}/reviews`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <CaretLeftIcon className="size-3" /> Reviews
      </Link>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-5">
          <section className="space-y-1.5">
            <Label htmlFor="review-title">Title</Label>
            <Input id="review-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Columns</h2>
              <div className="flex gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={() => { setColumns(PRESET_COLUMNS.map((c) => ({ ...c }))); setTitle('Commercial contract basics'); }}>
                  Commercial preset
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setColumns([blankColumn(new Set())])}>
                  Start blank
                </Button>
              </div>
            </div>
            <ColumnBuilder columns={columns} onChange={setColumns} />
          </section>
        </div>
        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-medium">Documents</h2>
            <DocumentPicker docs={ready} loading={docs === undefined} value={chosen} onChange={setPicked} />
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">
              {chosen.length} documents × {columns.length} columns = <span className="font-mono tabular-nums text-foreground">{cells}</span> cells. The table fills as
              each document is read, 4 documents per workspace.
            </p>
            <Button type="submit" className="mt-3 w-full" disabled={pending || chosen.length === 0 || !columnsReady(columns) || !title.trim()}>
              {pending ? <Loading className="size-4" /> : <TableIcon className="size-4" />} Run review
            </Button>
          </section>
        </aside>
      </div>
    </form>
  );
}
