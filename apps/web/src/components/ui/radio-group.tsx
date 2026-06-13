'use client';

import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import * as React from 'react';

import { cn } from '@/lib/utils';

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid gap-1', className)}
      {...props}
    />
  );
}

type RadioGroupItemProps = React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
  label?: React.ReactNode;
};

const radioControlClassName = cn(
  'peer aspect-square size-4 shrink-0 rounded-full border border-muted-foreground/60 bg-transparent',
  'transition-[color,box-shadow,border-color,background-color]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'data-[state=checked]:border-foreground data-[state=checked]:bg-background data-[state=checked]:border-kortix-blue data-[state=checked]:border-4 ',
  'aria-invalid:border-destructive',
);

function RadioGroupItem({ className, label, id, ...props }: RadioGroupItemProps) {
  const generatedId = React.useId();
  const itemId = id ?? generatedId;

  const control = (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      id={itemId}
      className={cn(radioControlClassName, !label && className)}
      {...props}
    />
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
        className,
      )}
    >
      {control}
      <span
        className={cn(
          'text-sm transition-[color,font-weight]',
          'text-muted-foreground',
          'peer-data-[state=checked]:text-foreground peer-data-[state=checked]:font-medium',
        )}
      >
        {label}
      </span>
    </label>
  );
}

export { RadioGroup, RadioGroupItem };
export type { RadioGroupItemProps };
