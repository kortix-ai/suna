'use client';

import { Check, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CommandItem } from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/utils';
import type { ModelPickerItem } from '@kortix/sdk/react';

export interface ModelPickerRowProps {
  item: ModelPickerItem;
  selected: boolean;
  onSelect: () => void;
}

/**
 * A single model-first row — name, sublabel, and trailing affordances. Never
 * branches on harness: `item.experimental` / `item.liveSwap` / `item.free`
 * are plain data the `ModelPickerViewModel` already resolved (see
 * `use-model-picker.ts`), and `item.selectable === false` (the
 * `not-connected` group's rows) renders the same shape, just inert and
 * muted — visible, never hidden.
 *
 * Row height is pinned to 40px (`min-h-10`) so the hit area meets the
 * make-interfaces-feel-better minimum regardless of whether the sublabel is
 * present.
 */
export function ModelPickerRow({ item, selected, onSelect }: ModelPickerRowProps) {
  return (
    <CommandItem
      value={item.key}
      disabled={!item.selectable}
      onSelect={item.selectable ? onSelect : undefined}
      aria-current={selected ? 'true' : undefined}
      className={cn('min-h-10 transition-colors duration-150', selected && 'bg-primary/[0.06]')}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <div
          className={cn(
            'truncate text-sm leading-tight',
            !item.selectable
              ? 'text-muted-foreground font-medium'
              : selected
                ? 'text-foreground font-semibold'
                : 'text-foreground/90 font-medium',
          )}
        >
          {item.label}
        </div>
        {item.sublabel ? (
          <p className="text-muted-foreground/60 mt-0.5 truncate text-xs leading-snug">
            {item.sublabel}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {item.experimental ? (
          <Badge variant="beta" size="xs">
            Experimental
          </Badge>
        ) : null}
        {item.liveSwap ? (
          <Hint label="Can switch mid-session">
            <span title="Can switch mid-session" className="inline-flex">
              <Zap className="text-kortix-yellow size-3 shrink-0" />
            </span>
          </Hint>
        ) : null}
        {item.free === true ? <Tag variant="free">Free</Tag> : null}
        {selected ? <Check className="text-foreground size-3.5 shrink-0" /> : null}
      </div>
    </CommandItem>
  );
}
