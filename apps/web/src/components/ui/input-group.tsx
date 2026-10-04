'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Input,
  InputProps,
  inputSurfaceClasses,
  inputTransitionClasses,
} from '@/components/ui/input';
import { Close } from '@/features/icon/icons/close';
import { cn } from '@/lib/utils';

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        'group/input-group relative flex w-full items-center outline-none',
        inputSurfaceClasses,
        inputTransitionClasses,
        'h-9 min-w-0 has-[>textarea]:h-auto',

        // Variants based on alignment.
        'has-[>[data-align=inline-start]]:[&>input]:pl-2',
        'has-[>[data-align=inline-end]]:[&>input]:pr-2',
        'has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-start]]:[&>input]:pb-3',
        'has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3',

        // Focus state.
        // Focus state — the same border + halo as `Input`, drawn on the group
        // so addons sit inside the ring rather than beside it.
        'has-[[data-slot=input-group-control]:focus]:border-ring has-[[data-slot=input-group-control]:focus]:ring-ring/15 has-[[data-slot=input-group-control]:focus]:ring-3',

        // Error state.
        'has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-destructive/15 has-[[data-slot][aria-invalid=true]]:ring-3',

        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 [&>kbd]:rounded-[calc(var(--radius)-5px)] [&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        'inline-start': 'order-first pl-3 has-[>button]:ml-[-0.45rem] has-[>kbd]:ml-[-0.35rem]',
        'inline-end': 'order-last pr-3 has-[>button]:mr-[-0.45rem] has-[>kbd]:mr-[-0.35rem]',
        'block-start':
          'order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-2.5 [.border-b]:pb-3',
        'block-end':
          'order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-2.5 [.border-t]:pt-3',
      },
    },
    defaultVariants: {
      align: 'inline-start',
    },
  },
);

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) {
          return;
        }
        e.currentTarget.parentElement?.querySelector('input')?.focus();
      }}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva('flex items-center gap-2 text-sm shadow-none', {
  variants: {
    size: {
      xs: "h-6 gap-1 rounded-[calc(var(--radius)-5px)] px-2 has-[>svg]:px-2 [&>svg:not([class*='size-'])]:size-3.5",
      sm: 'h-8 gap-1.5 rounded-md px-2.5 has-[>svg]:px-2.5',
      'icon-xs': 'size-6 rounded-[calc(var(--radius)-5px)] p-0 has-[>svg]:p-0',
      'icon-sm': 'size-8 p-0 has-[>svg]:p-0',
    },
  },
  defaultVariants: {
    size: 'xs',
  },
});

function InputGroupButton({
  className,
  type = 'button',
  variant = 'ghost',
  size = 'xs',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'size'> &
  VariantProps<typeof inputGroupButtonVariants>) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        // The group paints the surface, border and ring; the control is bare.
        'flex-1 rounded-none border-0 bg-transparent shadow-none',
        'focus:ring-0 focus:outline-none aria-invalid:ring-0',
        className,
      )}
      {...props}
    />
  );
}

function InputGroupSearch({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="input-group-search" className={cn('relative w-full', className)} {...props} />
  );
}

function InputGroupSearchIcon({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group-search-icon"
      aria-hidden="true"
      className={cn(
        'text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  );
}

function InputGroupSearchInput({
  className,
  variant = 'transparent',
  size = 'md',
  ...props
}: InputProps) {
  return (
    <Input
      data-slot="input-group-search-control"
      variant={variant}
      size={size}
      className={cn('peer placeholder:text-muted-foreground/60 pl-9', className)}
      {...props}
    />
  );
}

function InputGroupSearchClear({
  className,
  variant = 'ghost',
  size = 'icon',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children'>) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label="Clear"
      data-slot="input-group-search-clear"
      className={cn(
        'absolute top-1/2 right-2 size-6 -translate-y-1/2 rounded-sm opacity-0 peer-focus:opacity-100',
        className,
      )}
      {...props}
    >
      <Close className="text-muted-foreground size-4" />
    </Button>
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
};
