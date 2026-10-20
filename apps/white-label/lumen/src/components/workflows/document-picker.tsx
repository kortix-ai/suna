'use client';

import type { Id } from '@convex/_generated/dataModel';
import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import { Skeleton } from '@kortix/ui/skeleton';
import { FileTextIcon } from '@phosphor-icons/react';

type Doc = { _id: Id<'documents'>; filename: string; pages?: number };

/** A checkbox list of the vault's ready documents, with "All" and "None". */
export function DocumentPicker({ docs, loading, value, onChange }: {
  docs: Doc[]; loading?: boolean; value: Id<'documents'>[]; onChange: (ids: Id<'documents'>[]) => void;
}) {
  if (loading) return <div className="mt-2 space-y-1.5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>;
  if (docs.length === 0) return <p className="mt-2 text-xs text-muted-foreground">No ready documents. Upload contracts to the vault first.</p>;
  const all = value.length === docs.length;
  return (
    <div className="mt-2" data-testid="document-picker">
      <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {value.length} of {docs.length} selected
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onChange(all ? [] : docs.map((d) => d._id))}>
          {all ? 'None' : 'All'}
        </Button>
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-auto">
        {docs.map((d) => (
          <li key={d._id}>
            <label className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/50">
              <Checkbox
                checked={value.includes(d._id)}
                onCheckedChange={(c) => onChange(c ? [...value, d._id] : value.filter((x) => x !== d._id))}
                aria-label={d.filename}
              />
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{d.filename}</span>
              {d.pages ? <span className="font-mono text-[11px] text-muted-foreground">{d.pages} p</span> : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
