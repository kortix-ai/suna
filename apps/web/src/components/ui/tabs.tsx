'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

interface TabsListProps extends React.ComponentProps<typeof TabsPrimitive.List> {
  variant?: 'default' | 'secondary';
  size?: 'default' | 'xs' | 'sm' | 'lg';
}

function TabsList({ className, variant = 'secondary', size = 'default', ...props }: TabsListProps) {
  const sizeMap = {
    default: 'h-9',
    xs: 'h-7',
    sm: 'h-8',
    lg: 'h-10',
  };
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'text-muted-foreground inline-flex w-fit items-center justify-center gap-1 rounded-lg',
        className,
        variant === 'secondary' && 'bg-foreground/10 p-[1.5px] px-[2px]',
        sizeMap[size],
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  variant?: 'default' | 'large' | 'transparent' | 'underline' | 'secondary' | 'a_accent-i_outline';
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:ring-kortix-blue inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--radius)-1.5px)] border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[0.6px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'data-[state=active]:bg-background hover:data-[state=inactive]:bg-foreground/6 data-[state=inactive]:bg-transparent',
        'data-[state=active]:text-foreground data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80',

        className,
        variant === 'large' &&
          'border-border/80 h-10 border px-4 data-[state=inactive]:bg-transparent',
        variant === 'transparent' &&
          'text-primary data-[state=active]:text-primary data-[state=inactive]:text-primary bg-transparent data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent dark:data-[state=active]:border-none',
        variant === 'underline' &&
          'text-primary data-[state=active]:border-primary data-[state=active]:text-primary data-[state=inactive]:text-primary rounded-none border-b-2 border-transparent bg-transparent data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent',
        variant === 'secondary' &&
          'data-[state=active]:bg-primary/90 data-[state=active]:text-background data-[state=inactive]:text-muted-foreground px-2 data-[state=inactive]:bg-transparent',
        variant === 'a_accent-i_outline' &&
          'data-[state=inactive]:border-border data-[state=active]:bg-foreground/5 data-[state=active]:text-accent-foreground data-[state=inactive]:text-foreground data-[state=active]:hover:bg-foreground/10 data-[state=inactive]:hover:bg-foreground/5 data-[state=inactive]:hover:text-foreground dark:data-[state=active]:bg-foreground/5 dark:data-[state=active]:text-accent-foreground dark:data-[state=inactive]:text-foreground px-2 data-[state=active]:border-transparent data-[state=active]:shadow-none data-[state=inactive]:bg-transparent dark:data-[state=active]:border-transparent',
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

/** Compact Radix TabsList — use inside <Tabs> root for smaller contexts. */
function TabsListCompact({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'bg-foreground/10 text-muted-foreground inline-flex h-7 w-fit items-center justify-center gap-0.5 rounded-md p-[1.5px] px-[2px]',
        className,
      )}
      {...props}
    />
  );
}

/** Compact Radix TabsTrigger — use inside <Tabs> root for smaller contexts. */
function TabsTriggerCompact({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'focus-visible:ring-kortix-blue inline-flex h-[calc(100%-2px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-[0.6px] focus-visible:outline-none',
        'data-[state=active]:bg-background hover:data-[state=inactive]:bg-foreground/6 data-[state=inactive]:bg-transparent',
        'data-[state=active]:text-foreground data-[state=inactive]:text-foreground/60 hover:data-[state=inactive]:text-foreground/80',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

/** Standalone filter pill bar — works WITHOUT a <Tabs> root. Use for filter bars, mode toggles. */
function FilterBar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="filter-bar"
      role="tablist"
      className={cn(
        'bg-foreground/5 text-muted-foreground inline-flex h-9 w-fit items-center justify-center gap-0.5 rounded-full p-0.5',
        className,
      )}
      {...props}
    />
  );
}

/** Standalone filter pill — works WITHOUT a <Tabs> root. Pair with FilterBar. */
function FilterBarItem({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      data-slot="filter-bar-item"
      role="tab"
      type="button"
      className={cn(
        'inline-flex h-[calc(100%-4px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-transparent px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150',
        'text-muted-foreground/60 hover:text-foreground/80',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:ring-foreground/6 data-[state=active]:shadow-sm data-[state=active]:ring-1',
        'disabled:pointer-events-none disabled:opacity-50',
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export {
  FilterBar,
  FilterBarItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
};
