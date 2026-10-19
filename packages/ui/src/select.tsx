// A real select: a trigger that shows the current label and opens an OptionList in a Popover.
import { useState } from 'react';
import { OptionList, type Option, type OptionValue } from './option-list';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export interface SelectProps<V extends OptionValue> {
  label: string;
  value: V;
  options: Option<V>[];
  onChange: (value: V) => void;
  searchable?: boolean;
  placeholder?: string;
  size?: 'sm' | 'default';
}

export function Select<V extends OptionValue>({ label, value, options, onChange, searchable, placeholder = 'Select', size = 'default' }: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="k-select-trigger" data-size={size} aria-label={`${label}: ${current?.label ?? placeholder}`}>
        <span className="k-truncate">{current?.label ?? <span className="k-muted">{placeholder}</span>}</span>
      </PopoverTrigger>
      <PopoverContent>
        <OptionList label={label} options={options} value={value} searchable={searchable ?? options.length > 8} onPick={(v) => { onChange(v); setOpen(false); }} />
      </PopoverContent>
    </Popover>
  );
}
