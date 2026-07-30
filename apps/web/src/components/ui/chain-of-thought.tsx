'use client';

/**
 * ChainOfThought — a vertical chain where each step opens independently.
 *
 * Adapted from prompt-kit (https://prompt-kit.com/c/chain-of-thought.json).
 * Changes from upstream: Phosphor icons, and the connector uses `bg-border`
 * rather than `bg-primary/20` so it matches the rest of the thread's rails.
 */

import { CaretDownIcon, CircleIcon } from '@phosphor-icons/react';
import * as React from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export type ChainOfThoughtItemProps = React.ComponentProps<'div'>;

export function ChainOfThoughtItem({ children, className, ...props }: ChainOfThoughtItemProps) {
  return (
    <div className={cn('text-muted-foreground text-sm', className)} {...props}>
      {children}
    </div>
  );
}

export type ChainOfThoughtTriggerProps = React.ComponentProps<typeof CollapsibleTrigger> & {
  leftIcon?: React.ReactNode;
  swapIconOnHover?: boolean;
};

export function ChainOfThoughtTrigger({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  ...props
}: ChainOfThoughtTriggerProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        'group/cot text-muted-foreground hover:text-foreground',
        'flex w-full cursor-pointer items-center gap-2 text-left text-sm transition-colors',
        className,
      )}
      {...props}
    >
      <span className="relative inline-flex size-4 flex-none items-center justify-center">
        {leftIcon ? (
          <>
            <span
              className={cn('transition-opacity', swapIconOnHover && 'group-hover/cot:opacity-0')}
            >
              {leftIcon}
            </span>
            {swapIconOnHover && (
              <CaretDownIcon className="absolute size-4 opacity-0 transition-opacity group-hover/cot:opacity-100 group-data-[state=open]/cot:rotate-180" />
            )}
          </>
        ) : (
          <CircleIcon weight="fill" className="size-2" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </CollapsibleTrigger>
  );
}

export type ChainOfThoughtContentProps = React.ComponentProps<typeof CollapsibleContent>;

export function ChainOfThoughtContent({
  children,
  className,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <CollapsibleContent className={cn('overflow-hidden', className)} {...props}>
      <div className="grid grid-cols-[min-content_minmax(0,1fr)] gap-x-3">
        <div className="bg-border ml-[7px] h-full w-px group-data-[last=true]/step:hidden" />
        <div className="mt-1 space-y-2">{children}</div>
      </div>
    </CollapsibleContent>
  );
}

export type ChainOfThoughtStepProps = React.ComponentProps<typeof Collapsible> & {
  isLast?: boolean;
};

export function ChainOfThoughtStep({
  children,
  className,
  isLast = false,
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <Collapsible className={cn('group/step', className)} data-last={isLast} {...props}>
      {children}
      <div className="flex justify-start group-data-[last=true]/step:hidden">
        <div className="bg-border ml-[7px] h-3 w-px" />
      </div>
    </Collapsible>
  );
}

export type ChainOfThoughtProps = { children: React.ReactNode; className?: string };

export function ChainOfThought({ children, className }: ChainOfThoughtProps) {
  const items = React.Children.toArray(children);
  return (
    <div className={cn('space-y-0', className)}>
      {items.map((child, index) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<ChainOfThoughtStepProps>, {
              key: index,
              isLast: index === items.length - 1,
            })
          : child,
      )}
    </div>
  );
}
