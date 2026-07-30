'use client';

/**
 * Steps — a collapsible run of operations with a left rail.
 *
 * Adapted from prompt-kit (https://prompt-kit.com/c/steps.json). Changes from
 * upstream: Phosphor icons instead of lucide, kortix tokens instead of
 * bg-muted, and a `trailing` slot on the trigger for the duration readout.
 */

import { CaretDownIcon } from '@phosphor-icons/react';
import * as React from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type StepsItemProps = React.ComponentProps<'div'>;

export function StepsItem({ children, className, ...props }: StepsItemProps) {
  return (
    <div className={cn('text-muted-foreground text-sm', className)} {...props}>
      {children}
    </div>
  );
}

export type StepsTriggerProps = React.ComponentProps<typeof CollapsibleTrigger> & {
  leftIcon?: React.ReactNode;
  swapIconOnHover?: boolean;
  /** Right-aligned slot — duration, count, live indicator. */
  trailing?: React.ReactNode;
};

export function StepsTrigger({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  trailing,
  ...props
}: StepsTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        'group/steps text-muted-foreground hover:text-foreground',
        'flex w-full cursor-pointer items-center gap-2 text-left text-sm transition-colors',
        className,
      )}
      {...props}
    >
      {leftIcon ? (
        <span className="relative inline-flex size-4 flex-none items-center justify-center">
          <span
            className={cn('transition-opacity', swapIconOnHover && 'group-hover/steps:opacity-0')}
          >
            {leftIcon}
          </span>
          {swapIconOnHover && (
            <CaretDownIcon className="absolute size-4 opacity-0 transition-opacity group-hover/steps:opacity-100 group-data-[state=open]/steps:rotate-180" />
          )}
        </span>
      ) : (
        <CaretDownIcon className="size-4 flex-none transition-transform group-data-[state=open]/steps:rotate-180" />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? <span className="flex flex-none items-center gap-1.5">{trailing}</span> : null}
    </CollapsibleTrigger>
  );
}

export type StepsContentProps = React.ComponentProps<typeof CollapsibleContent> & {
  bar?: React.ReactNode;
};

export function StepsContent({ children, className, bar, ...props }: StepsContentProps) {
  return (
    <CollapsibleContent className={cn('overflow-hidden', className)} {...props}>
      <div className="mt-2 grid max-w-full min-w-0 grid-cols-[min-content_minmax(0,1fr)] items-start gap-x-3">
        <div className="min-w-0 self-stretch">{bar ?? <StepsBar />}</div>
        <div className="min-w-0 space-y-2 pb-1">{children}</div>
      </div>
    </CollapsibleContent>
  );
}

export type StepsBarProps = React.HTMLAttributes<HTMLDivElement>;

export function StepsBar({ className, ...props }: StepsBarProps) {
  // ml-[7px] centres a 1px rule under the size-4 trigger icon.
  return <div className={cn('bg-border ml-[7px] h-full w-px', className)} aria-hidden {...props} />;
}

export type StepsProps = React.ComponentProps<typeof Collapsible>;

export function Steps({ defaultOpen = true, className, ...props }: StepsProps) {
  return <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />;
}
