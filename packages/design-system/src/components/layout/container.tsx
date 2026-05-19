import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const containerVariants = cva('mx-auto w-full', {
  variants: {
    size: {
      xs: 'max-w-xl',
      sm: 'max-w-2xl',
      md: 'max-w-4xl',
      lg: 'max-w-6xl',
      xl: 'max-w-7xl',
      full: 'max-w-none',
    },
    padded: {
      true: 'px-4 sm:px-6 lg:px-8',
      false: '',
    },
  },
  defaultVariants: {
    size: 'lg',
    padded: true,
  },
});

export interface ContainerProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof containerVariants> {
  asChild?: boolean;
}

export function Container({ className, size, padded, asChild = false, ...props }: ContainerProps) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      className={cn(containerVariants({ size, padded }), className)}
      data-slot="container"
      {...props}
    />
  );
}

export function Section({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section data-slot="section" className={cn('py-12 md:py-20', className)} {...props} />;
}

export function Stack({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="stack" className={cn('flex flex-col gap-4', className)} {...props} />;
}

export function Inline({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="inline"
      className={cn('flex flex-row items-center gap-2', className)}
      {...props}
    />
  );
}
