// A one-row filter bar, like Linear: active filters are chips ("Size 11+ ×"), the rest sit behind one
// "Filter" button that opens a searchable list of dimensions, then that dimension's values.
// `undefined` means "any": a filter whose value is undefined is not active and shows no chip.
import { useState, type ReactNode } from 'react';
import { OptionList, type Option, type OptionValue } from './option-list';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export interface FilterDef<V extends OptionValue = OptionValue> {
  key: string;
  label: string;
  options: Option<V>[];
  value: V | undefined;
  onChange: (value: V | undefined) => void;
  searchable?: boolean;
}

export interface FilterBarProps {
  filters: FilterDef<any>[];
  /** Controlled open state of the "Filter" menu, so a page shortcut (f) can open it. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** Right side of the row: a result count, a sort. */
  trailing?: ReactNode;
  /** Shown on the Filter button, e.g. "f". */
  shortcut?: string;
}

const valueLabel = (f: FilterDef<any>) => f.options.find((o) => o.value === f.value)?.label ?? String(f.value);

export function FilterBar({ filters, menuOpen, onMenuOpenChange, trailing, shortcut }: FilterBarProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = menuOpen ?? ownOpen;
  const setOpen = (o: boolean) => { (onMenuOpenChange ?? setOwnOpen)(o); if (!o) setStep(null); };
  const [step, setStep] = useState<string | null>(null);
  const active = filters.filter((f) => f.value !== undefined);
  const picking = filters.find((f) => f.key === step);

  return (
    <div className="k-filter-bar" role="group" aria-label="Filters">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="k-button" data-variant="ghost" data-size="sm" aria-keyshortcuts={shortcut}>
          Filter{shortcut && <kbd className="k-kbd">{shortcut}</kbd>}
        </PopoverTrigger>
        <PopoverContent>
          {picking ? (
            <OptionList
              key={picking.key}
              label={picking.label}
              options={picking.options}
              value={picking.value}
              searchable={picking.searchable ?? picking.options.length > 8}
              onBack={() => setStep(null)}
              onPick={(v) => { picking.onChange(v); setOpen(false); }}
            />
          ) : (
            <OptionList
              key="dimensions"
              label="Filter by"
              searchable
              placeholder="Filter by…"
              options={filters.map((f) => ({ value: f.key, label: f.label, hint: f.value === undefined ? undefined : valueLabel(f) }))}
              onPick={(k) => setStep(String(k))}
            />
          )}
        </PopoverContent>
      </Popover>

      {active.map((f) => <FilterChip key={f.key} f={f} />)}

      {active.length > 1 && (
        <button type="button" className="k-button" data-variant="ghost" data-size="sm" onClick={() => active.forEach((f) => f.onChange(undefined))}>Clear</button>
      )}
      {trailing && <span className="k-filter-trailing">{trailing}</span>}
    </div>
  );
}

/** One active filter: the chip opens its values, × removes it. */
function FilterChip({ f }: { f: FilterDef<any> }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="k-chip-group">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="k-chip" aria-label={`${f.label}: ${valueLabel(f)}. Change`}>
          <span className="k-chip-key">{f.label}</span>
          <span>{valueLabel(f)}</span>
        </PopoverTrigger>
        <PopoverContent>
          <OptionList label={f.label} options={f.options} value={f.value} searchable={f.searchable ?? f.options.length > 8} onPick={(v) => { f.onChange(v); setOpen(false); }} />
        </PopoverContent>
      </Popover>
      <button type="button" className="k-chip" aria-label={`Remove ${f.label} filter`} onClick={() => f.onChange(undefined)}>×</button>
    </span>
  );
}
