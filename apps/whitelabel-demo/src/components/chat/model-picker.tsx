'use client';

/**
 * Model picker — a thin searchable dropdown over the SDK's own model layer. We
 * don't reimplement the catalog/visibility rules (mixed gateway vs BYOK key
 * formats, per-family "latest", connected-provider gating are subtle). We take
 * the resolved `model` from `useOpenCodeLocal()`, render its `list`, and `set()`
 * the choice. `currentKey` is what the workbench passes to send's options.model.
 */

import type { OpenCodeLocalModel } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';

export function ModelPicker({ model }: { model: OpenCodeLocalModel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const list = model.list ?? [];
  const current = model.current;
  const empty = list.length === 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? list.filter((m) => `${m.modelName} ${m.providerName}`.toLowerCase().includes(q))
      : list;
    return base.slice(0, 60);
  }, [query, list]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={empty}
          className="h-7 max-w-[180px] gap-1 px-2 text-xs text-muted-foreground"
        >
          <span className="truncate">{current?.modelName ?? 'Default model'}</span>
          {!empty && <ChevronsUpDown className="size-3 shrink-0 opacity-60" />}
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
            const selected =
              current?.providerID === m.providerID && current?.modelID === m.modelID;
            return (
              <button
                key={`${m.providerID}/${m.modelID}`}
                type="button"
                onClick={() => {
                  model.set({ providerID: m.providerID, modelID: m.modelID }, { recent: true });
                  setOpen(false);
                  setQuery('');
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
