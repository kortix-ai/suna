'use client';

/**
 * Model picker — a thin dropdown over the SDK's own model layer. We don't
 * reimplement the catalog/visibility rules (those are subtle: mixed gateway vs
 * BYOK key formats, per-family "latest", connected-provider gating). Instead we
 * take the resolved `model` object from `useOpenCodeLocal()` and render its
 * `list`, and `set()` the chosen one. The selected `currentKey` is what the
 * workbench passes to `useSendOpenCodeMessage({ options: { model } })`.
 */

import type { OpenCodeLocalModel } from '@kortix/sdk/react';
import { Input } from '@/components/ui';
import { cn } from '@/lib/utils';
import { Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';

export function ModelPicker({ model }: { model: OpenCodeLocalModel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const list = model.list ?? [];
  const current = model.current;
  const filtered = query
    ? list.filter((m) =>
        `${m.modelName} ${m.providerName}`.toLowerCase().includes(query.toLowerCase()),
      )
    : list;

  // Nothing to choose yet (runtime warming / no providers) — show the default.
  const empty = list.length === 0;

  return (
    <div className="relative">
      <button
        type="button"
        disabled={empty}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex max-w-[200px] items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-panel-2)] disabled:opacity-60',
        )}
      >
        <span className="truncate">{current?.modelName ?? 'Default model'}</span>
        {!empty && <ChevronDown className="size-3.5 shrink-0 text-[var(--color-muted)]" />}
      </button>

      {open && !empty && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-xl">
            <div className="border-b border-[var(--color-border)] p-2">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="h-8 text-xs"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
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
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-panel-2)]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--color-fg)]">{m.modelName}</div>
                      <div className="truncate text-xs text-[var(--color-muted)]">
                        {m.providerName}
                      </div>
                    </div>
                    {selected && <Check className="size-4 shrink-0 text-[var(--color-accent)]" />}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-2.5 py-3 text-center text-xs text-[var(--color-muted)]">
                  No models match.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
