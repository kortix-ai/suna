'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { ArrowClockwiseIcon, DotsThreeIcon, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export function ToolActionBar({
  compact,
  loading,
  refreshLabel,
  menuLabel,
  onRefresh,
  secondaryLabel,
  secondaryIcon: SecondaryIcon,
  onSecondary,
  secondaryDisabled,
  secondaryDisabledClassName,
  secondaryIconClassName,
  refreshButtonClassName,
  secondaryButtonClassName,
  primary,
}: {
  compact: boolean;
  loading: boolean;
  refreshLabel: string;
  menuLabel: string;
  onRefresh: () => void;
  secondaryLabel: string;
  secondaryIcon: Icon;
  onSecondary: () => void;
  secondaryDisabled?: boolean;
  secondaryDisabledClassName?: string;
  /** The secondary icon's size class. Sized per caller; never derived from
   *  a styling className prop, which callers pass only when they have styles
   *  to add. */
  secondaryIconClassName?: string;
  refreshButtonClassName?: string;
  secondaryButtonClassName?: string;
  primary: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={menuLabel}
              className="active:scale-[0.96]"
            >
              <DotsThreeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onSelect={onRefresh}>
              <ArrowClockwiseIcon className={cn(loading && 'animate-spinner-spin')} />
              {refreshLabel}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={secondaryDisabled} onSelect={onSecondary}>
              <SecondaryIcon />
              {secondaryLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <Hint label={refreshLabel} side="top">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onRefresh}
              aria-label={refreshLabel}
              className={refreshButtonClassName}
            >
              <ArrowClockwiseIcon className={cn('size-4', loading && 'animate-spinner-spin')} />
            </Button>
          </Hint>
          <Hint label={secondaryLabel} side="top">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onSecondary}
              disabled={secondaryDisabled}
              aria-label={secondaryLabel}
              className={cn(
                secondaryButtonClassName,
                secondaryDisabled && secondaryDisabledClassName,
              )}
            >
              <SecondaryIcon className={secondaryIconClassName} />
            </Button>
          </Hint>
        </>
      )}
      {primary}
    </div>
  );
}
