// A keyboard-first option list: type to filter (when searchable), ↑/↓ or Ctrl-n/p to move, Enter to pick,
// Home/End to jump. One focus stop with aria-activedescendant, like the command palette in apps/web.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export type OptionValue = string | number | boolean | undefined;
export interface Option<V extends OptionValue = OptionValue> {
  value: V;
  label: string;
  /** Right-aligned meta: a count, a shortcut, the current value. */
  hint?: string;
}

export interface OptionListProps<V extends OptionValue> {
  options: Option<V>[];
  value?: V;
  onPick: (value: V) => void;
  /** Accessible name of the list. */
  label: string;
  searchable?: boolean;
  placeholder?: string;
  emptyText?: string;
  /** Backspace in an empty search, or ←: go back one step (the FilterBar's dimension list). */
  onBack?: () => void;
}

export function OptionList<V extends OptionValue>({ options, value, onPick, label, searchable, placeholder = 'Search…', emptyText = 'No match', onBack }: OptionListProps<V>) {
  const id = useId();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q) || String(o.value ?? '').toLowerCase().includes(q)) : options;
  }, [options, query]);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => { (searchable ? input.current : list.current)?.focus(); }, [searchable]);
  useEffect(() => { setActive((i) => Math.min(i, Math.max(0, shown.length - 1))); }, [shown.length]);
  useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, id]);

  const onKeyDown = (e: KeyboardEvent) => {
    const move = (to: number) => { e.preventDefault(); setActive(Math.max(0, Math.min(shown.length - 1, to))); };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') || (!searchable && e.key === 'j')) return move(active + 1);
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') || (!searchable && e.key === 'k')) return move(active - 1);
    if (e.key === 'Home') return move(0);
    if (e.key === 'End') return move(shown.length - 1);
    if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o) onPick(o.value); return; }
    if (onBack && (e.key === 'ArrowLeft' || (e.key === 'Backspace' && !query))) { e.preventDefault(); onBack(); }
  };

  const activeId = shown[active] ? `${id}-${active}` : undefined;
  return (
    <div className="k-options-wrap" onKeyDown={onKeyDown}>
      {searchable && (
        <input
          ref={input}
          className="k-option-search"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          aria-label={`Search ${label}`}
        />
      )}
      <ul ref={list} id={`${id}-list`} className="k-options" role="listbox" aria-label={label} tabIndex={searchable ? -1 : 0} aria-activedescendant={searchable ? undefined : activeId}>
        {shown.length === 0 && <li className="k-option-empty">{emptyText}</li>}
        {shown.map((o, i) => (
          <li
            key={String(o.value)}
            id={`${id}-${i}`}
            role="option"
            className="k-option"
            aria-selected={o.value === value}
            data-active={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => onPick(o.value)}
          >
            <span className="k-truncate">{o.label}</span>
            {o.hint && <span className="k-option-hint">{o.hint}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
