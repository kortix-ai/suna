'use client';

import type { CellFormat } from '@/lib/review-cells';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Textarea } from '@kortix/ui/textarea';
import { PlusIcon, TrashIcon } from '@phosphor-icons/react';

export type ColumnDraft = { key: string; label: string; prompt: string; format: CellFormat; options?: string[] };

export const FORMATS: Array<{ value: CellFormat; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'date', label: 'Date or duration' },
  { value: 'money', label: 'Money' },
  { value: 'tag', label: 'Tag' },
  { value: 'verbatim', label: 'Verbatim quote' },
];

/** "Non-solicit (12 months)" → "non_solicit_12_months", unique among `taken`. */
export function keyFor(label: string, taken: ReadonlySet<string>): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'c_$1') || 'column').slice(0, 36);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}

export const blankColumn = (taken: ReadonlySet<string>): ColumnDraft => ({ key: keyFor('Question', taken), label: '', prompt: '', format: 'text' });

/** Columns as rows: label, the question the agent answers, the answer format (and a tag column's options). */
export function ColumnBuilder({ columns, onChange, locked = 0 }: {
  columns: ColumnDraft[]; onChange: (c: ColumnDraft[]) => void; locked?: number;
}) {
  const set = (i: number, patch: Partial<ColumnDraft>) => {
    const next = columns.map((c, j) => (j === i ? { ...c, ...patch } : c));
    if (patch.label !== undefined && i >= locked) {
      const taken = new Set(next.filter((_, j) => j !== i).map((c) => c.key));
      next[i] = { ...next[i], key: keyFor(patch.label || 'Question', taken) };
    }
    onChange(next);
  };
  return (
    <div className="space-y-2" data-testid="column-builder">
      {columns.map((c, i) =>
        i < locked ? null : (
          <div key={i} className="space-y-2 rounded-lg border border-border bg-background p-3" data-testid="column-row">
            <div className="flex items-center gap-2">
              <Input aria-label="Column label" placeholder="Label" value={c.label} onChange={(e) => set(i, { label: e.target.value })} className="h-8 min-w-0 flex-1 text-sm" />
              <Select value={c.format} onValueChange={(f) => set(i, { format: f as CellFormat })}>
                <SelectTrigger aria-label="Answer format" className="h-8 w-40 shrink-0 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 shrink-0"
                aria-label={`Remove ${c.label || 'column'}`}
                disabled={columns.length - locked <= 1}
                onClick={() => onChange(columns.filter((_, j) => j !== i))}
              >
                <TrashIcon className="size-4" />
              </Button>
            </div>
            <Textarea
              aria-label="Question"
              placeholder="The question each document answers"
              value={c.prompt}
              onChange={(e) => set(i, { prompt: e.target.value })}
              className="min-h-8 py-1.5 text-sm"
              rows={1}
            />
            {c.format === 'tag' && (
              <Input
                aria-label="Tag options"
                placeholder="Options, separated by commas"
                value={(c.options ?? []).join(', ')}
                onChange={(e) => set(i, { options: e.target.value.split(',').map((o) => o.trimStart()) })}
                className="h-8 text-sm"
              />
            )}
          </div>
        ),
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={columns.length >= 20}
        onClick={() => onChange([...columns, blankColumn(new Set(columns.map((c) => c.key)))])}
      >
        <PlusIcon className="size-4" /> Add a column
      </Button>
    </div>
  );
}

/** True when every editable column has a label and a question, and each tag column has options. */
export const columnsReady = (columns: ColumnDraft[], from = 0) =>
  columns.slice(from).length > 0 &&
  columns.slice(from).every((c) => c.label.trim() && c.prompt.trim().length >= 3 && (c.format !== 'tag' || (c.options ?? []).some((o) => o.trim())));

/** What the API takes: trimmed options, only for tag columns. */
export const toColumns = (columns: ColumnDraft[]) =>
  columns.map((c) => ({
    key: c.key, label: c.label.trim(), prompt: c.prompt.trim(), format: c.format,
    ...(c.format === 'tag' ? { options: (c.options ?? []).map((o) => o.trim()).filter(Boolean) } : {}),
  }));
