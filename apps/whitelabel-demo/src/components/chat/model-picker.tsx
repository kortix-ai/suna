'use client';

/**
 * Model picker — a controlled, searchable dropdown over a server-side model list
 * (`useProjectModels`). Used identically on the new-session screen and in the
 * chat composer. `value`/`onChange` are a plain `{ providerID, modelID }` key, so
 * the same picker drives both the start config and per-message selection.
 */

import type { FlatModel, ModelKey } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, ChevronsUpDown, Cpu } from 'lucide-react';
import { useMemo, useState } from 'react';

export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: FlatModel[];
  value: ModelKey | null;
  onChange: (value: ModelKey | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? models.filter((m) => `${m.modelName} ${m.providerName}`.toLowerCase().includes(q))
      : models;
    return base.slice(0, 60);
  }, [query, models]);

  if (models.length === 0) return null;
  const current =
    value && models.find((m) => m.providerID === value.providerID && m.modelID === value.modelID);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 max-w-[170px] gap-1 px-2 text-xs text-muted-foreground">
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{current?.modelName ?? 'Default model'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="h-8 text-xs"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1 scrollbar-thin">
          {filtered.map((m) => {
            const selected = value?.providerID === m.providerID && value?.modelID === m.modelID;
            return (
              <button
                key={`${m.providerID}/${m.modelID}`}
                type="button"
                onClick={() => {
                  onChange({ providerID: m.providerID, modelID: m.modelID });
                  setOpen(false);
                  setQuery('');
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{m.modelName}</div>
                  <div className="truncate text-xs text-muted-foreground">{m.providerName}</div>
                </div>
                {selected && <Check className="size-4 shrink-0 text-brand" />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">No models match.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
