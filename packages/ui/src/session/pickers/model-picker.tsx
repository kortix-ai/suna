'use client';

/**
 * Model picker: a controlled, searchable list over `session.models`.
 * `value` / `onChange` are a plain `{ providerID, modelID }` key, so the same
 * picker drives a new-session form and the per-message pick. In the search
 * field, ArrowUp / ArrowDown move the highlight and Enter picks it, as in the
 * composer's command menu. `providerLabel` relabels a provider (a white-label
 * host shows its own name for the `kortix` provider).
 */

import { CaretUpDownIcon, CheckIcon, CpuIcon } from '@phosphor-icons/react';
import type { FlatModel, ModelKey } from '@kortix/sdk/react';
import { useEffect, useId, useMemo, useState } from 'react';

import { Input } from '../../primitives/input';
import { MENU_INDICATOR, MENU_INDICATOR_ICON, menuRow } from '../../primitives/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { useUiStrings } from '../../providers/ui-provider';

const TRIGGER = 'text-muted-foreground hover:text-foreground h-7 max-w-44 min-w-0 gap-1 px-2 text-xs';

/** Case-insensitive match on model and provider name; at most 60 rows. */
export function filterModels(models: readonly FlatModel[], query: string): FlatModel[] {
  const q = query.trim().toLowerCase();
  const base = q ? models.filter((m) => `${m.modelName} ${m.providerName}`.toLowerCase().includes(q)) : models;
  return base.slice(0, 60);
}

export function ModelPicker({
  models,
  value,
  onChange,
  providerLabel,
}: {
  models: readonly FlatModel[];
  value: ModelKey | null;
  onChange: (value: ModelKey | null) => void;
  /** The provider line of a model row. Default: the server's `providerName`. */
  providerLabel?: (model: FlatModel) => string;
}) {
  const t = useUiStrings().chat;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const filtered = useMemo(() => filterModels(models, query), [models, query]);
  // Keep the keyboard highlight in view in a long list.
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${highlight}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlight, listId]);

  if (models.length === 0) return null;
  const current = value && models.find((m) => m.providerID === value.providerID && m.modelID === value.modelID);
  const pick = (m: FlatModel) => {
    onChange({ providerID: m.providerID, modelID: m.modelID });
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
        setHighlight(0);
      }}
    >
      <PopoverTrigger variant="transparent" className={TRIGGER} aria-label={t.model}>
        <CpuIcon className="size-3.5 shrink-0" />
        <span className="truncate">{current?.modelName ?? t.defaultModel}</span>
        <CaretUpDownIcon className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-border border-b p-2">
          <Input
            autoFocus
            size="xs"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || filtered.length === 0) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setHighlight((h) => Math.min(Math.max(h + step, 0), filtered.length - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(filtered[highlight] ?? filtered[0]);
              }
            }}
            placeholder={t.searchModels}
            aria-label={t.searchModels}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={filtered[highlight] ? `${listId}-${highlight}` : undefined}
          />
        </div>
        <div id={listId} role="listbox" aria-label={t.models} className="scrollbar-thin max-h-72 overflow-y-auto p-1">
          {filtered.map((m, i) => {
            const selected = value?.providerID === m.providerID && value?.modelID === m.modelID;
            return (
              <button
                key={`${m.providerID}/${m.modelID}`}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-highlighted={i === highlight ? '' : undefined}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(m)}
                className={menuRow('sm', 'default', 'text-left')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.modelName}</span>
                  <span className="text-muted-foreground block truncate text-xs">{providerLabel?.(m) ?? m.providerName}</span>
                </span>
                <span className={MENU_INDICATOR}>{selected && <CheckIcon className={MENU_INDICATOR_ICON} />}</span>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-muted-foreground px-2 py-3 text-center text-xs">{t.noModelsMatch}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
