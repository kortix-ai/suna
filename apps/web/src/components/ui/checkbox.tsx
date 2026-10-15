'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as React from 'react';

import { cn } from '@/lib/utils';

type CheckboxVariant = 'blue' | 'black';

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  label?: React.ReactNode;
  /** Fill of the checked box. `black` is the foreground ink, so it inverts in dark mode. */
  variant?: CheckboxVariant;
};

// One size everywhere: an 18px box, 6px corners, a round-capped check.
const checkboxControlClassName = cn(
  'peer flex size-[18px] shrink-0 items-center justify-center rounded-sm border-[1.5px] border-muted-foreground/60 bg-transparent text-background',
  'transition-[border-color,background-color]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-default disabled:opacity-50', // cursor-default: a disabled checkbox takes no click
  'aria-invalid:border-destructive',
);

const checkboxVariantClassName: Record<CheckboxVariant, string> = {
  blue: 'data-[state=checked]:border-kortix-blue data-[state=checked]:bg-kortix-blue data-[state=indeterminate]:border-kortix-blue data-[state=indeterminate]:bg-kortix-blue',
  black:
    'data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=indeterminate]:border-foreground data-[state=indeterminate]:bg-foreground',
};

function CheckMark({ indeterminate }: { indeterminate: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3">
      <path
        d={indeterminate ? 'M4 8h8' : 'M3.5 8.5l3 3 6-7'}
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Checkbox({ className, label, id, variant = 'blue', ...props }: CheckboxProps) {
  const generatedId = React.useId();
  const itemId = id ?? generatedId;

  const control = (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-variant={variant}
      id={itemId}
      className={cn(checkboxControlClassName, checkboxVariantClassName[variant], !label && className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center">
        <CheckMark indeterminate={props.checked === 'indeterminate'} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (!label) {
    return control;
  }

  return (
    <label
      htmlFor={itemId}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 transition-colors',
        'hover:bg-foreground/3',
        'has-data-[state=checked]:bg-foreground/6 has-data-[state=checked]:hover:bg-foreground/6',
        'has-focus-visible:ring-ring has-focus-visible:ring-offset-background has-focus-visible:ring-2 has-focus-visible:ring-offset-2',
        props.disabled && 'cursor-default opacity-50', // cursor-default: disabled keeps the default cursor (AGENTS.md → States)
        className,
      )}
    >
      {control}
      <span
        className={cn(
          'text-sm transition-[color,font-weight]',
          'text-muted-foreground',
          'peer-data-[state=checked]:text-foreground peer-data-[state=checked]:font-medium',
          props.disabled && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </label>
  );
}

Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
export type { CheckboxProps, CheckboxVariant };
