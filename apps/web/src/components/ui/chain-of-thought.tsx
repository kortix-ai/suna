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

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';

export type ChainOfThoughtItemProps = React.ComponentProps<'div'>;

export function ChainOfThoughtItem({ children, className, ...props }: ChainOfThoughtItemProps) {
  return (
    <div className={cn('text-muted-foreground text-sm', className)} {...props}>
      {children}
    </div>
  );
}

export type ChainOfThoughtTriggerProps = React.ComponentProps<typeof DisclosureTrigger> & {
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
    <DisclosureTrigger
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
    </DisclosureTrigger>
  );
}

export type ChainOfThoughtContentProps = React.ComponentProps<typeof DisclosureContent>;

export function ChainOfThoughtContent({
  children,
  className,
  ...props
}: ChainOfThoughtContentProps) {
  return (
    <DisclosureContent className={cn('overflow-hidden', className)} {...props}>
      <div className="grid grid-cols-[min-content_minmax(0,1fr)] gap-x-3">
        <div className="bg-border ml-[7px] h-full w-px group-data-[last=true]/step:hidden" />
        <div className="mt-1 space-y-2">{children}</div>
      </div>
    </DisclosureContent>
  );
}

export type ChainOfThoughtStepProps = React.ComponentProps<typeof Disclosure> & {
  isLast?: boolean;
};

export function ChainOfThoughtStep({
  children,
  className,
  isLast = false,
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <Disclosure
      className={cn('group/step relative pb-3 data-[last=true]:pb-0', className)}
      data-last={isLast}
      {...props}
    >
      {/*
			  The rail spans the step rather than sitting after it.

			  It used to be a fixed-height spacer rendered below the content, which
			  made one element do two jobs: the gap between steps AND the line
			  connecting them. A spacer cannot know how tall its sibling is, so the
			  moment a step expanded — a search card, a command block — the line
			  stayed 0.9rem and the chain visibly broke, leaving the expanded step
			  floating unconnected.

			  Splitting the jobs fixes it: `pb-3` owns the gap, and the rail is
			  absolutely positioned so `bottom` stretches it to whatever the step
			  currently is. Expanded or collapsed, the line always reaches.

			  `left-2` puts the 1px rail on the 8px centre of the 16px leading icon —
			  the same column every step's icon occupies. `top-5` clears the icon;
			  `bottom-0.5` stops just short of the next one so the rail reads as
			  connecting the icons rather than colliding with them.
			*/}
      <div
        aria-hidden
        className={cn(
          'bg-muted-foreground/60 absolute top-[1.6rem] bottom-0 left-2 w-px',
          'group-data-[last=true]/step:hidden',
        )}
      />
      {children}
    </Disclosure>
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
