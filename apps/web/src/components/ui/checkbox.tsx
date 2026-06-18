'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { CheckIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  label?: React.ReactNode;
};

const checkboxControlClassName = cn(
  'peer flex aspect-square size-[18px] shrink-0 items-center justify-center rounded-sm border border-muted-foreground/60 bg-transparent',
  'transition-[color,box-shadow,border-color,background-color]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'data-[state=checked]:border-foreground data-[state=checked]:bg-kortix-blue data-[state=checked]:border-kortix-blue data-[state=checked]:border',
  'data-[state=checked]:text-background data-[state=checked]:[&_svg]:size-3',
  'aria-invalid:border-destructive',
);

function Checkbox({ className, label, id, ...props }: CheckboxProps) {
  const generatedId = React.useId();
  const itemId = id ?? generatedId;

  const control = (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      id={itemId}
      className={cn(checkboxControlClassName, !label && className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-2.5" strokeWidth={3} />
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
        props.disabled && 'cursor-not-allowed opacity-50',
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
export type { CheckboxProps };
