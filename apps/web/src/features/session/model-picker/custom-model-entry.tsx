'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ModelPickerViewModel } from '@kortix/sdk/react';

export interface CustomModelEntryProps {
  customEntry: NonNullable<ModelPickerViewModel['customEntry']>;
  value: string;
  onValueChange: (value: string) => void;
  onApply: (value: string) => void;
  className?: string;
}

/**
 * The free-typed "custom model id" affordance — rendered only when
 * `vm.customEntry.allowed`. Validation is entirely delegated to
 * `customEntry.validate` (the hook already resolved the harness-vs-gateway id
 * shape, see `use-model-picker.ts`); this component only ever renders the
 * result, never re-derives it.
 */
export function CustomModelEntry({
  customEntry,
  value,
  onValueChange,
  onApply,
  className,
}: CustomModelEntryProps) {
  const result = customEntry.validate(value);

  return (
    <div className={cn('border-border/60 border-t p-2', className)}>
      <div className="flex items-center gap-1.5">
        <Input
          variant="popover"
          size="md"
          placeholder={customEntry.placeholder}
          aria-label="Custom model id"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && result.ok) {
              event.preventDefault();
              onApply(value);
            }
          }}
          className="flex-1"
        />
        <Button
          type="button"
          size="sm"
          disabled={!result.ok}
          onClick={() => onApply(value)}
          className="h-10 shrink-0 active:scale-[0.96]"
        >
          Apply
        </Button>
      </div>
      {!result.ok && result.reason ? (
        <p className="text-kortix-red mt-1.5 text-xs">{result.reason}</p>
      ) : null}
    </div>
  );
}
