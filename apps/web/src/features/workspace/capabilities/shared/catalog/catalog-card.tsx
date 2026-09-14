'use client';

import type { CSSProperties, ReactNode } from 'react';

import Link from 'next/link';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface CatalogCardProps {
  leading?: ReactNode;
  title: ReactNode;
  description?: string | null;
  badges?: ReactNode;
  /** A muted facts line under the description — the card's third row. */
  meta?: ReactNode;
  trailing?: ReactNode;
  /** A card that NAVIGATES renders as a real `next/link` — prefetched, middle-
   *  clickable, and a client transition rather than a `router.push` from a
   *  button (see the no-hard-refresh nav contract). Cards that open a modal
   *  in place keep `onClick`. Exactly one of the two. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  /** A card in a PICK list — the agent editor's grant pages. The checkbox
   *  toggles membership; the body still opens the entity (`onClick`), so one
   *  card answers both "is it granted?" and "what is it?". Two sibling
   *  controls, never one nested in the other. */
  select?: {
    checked: boolean;
    onCheckedChange: () => void;
    /** Off in All / None mode — the set is decided for every card. */
    disabled?: boolean;
    label: string;
  };
}

export function CatalogCard({
  leading,
  title,
  description,
  badges,
  meta,
  trailing,
  href,
  onClick,
  disabled,
  className,
  style,
  select,
}: CatalogCardProps) {
  const classes = cn(
    'bg-accent/50 group border-border/60  flex w-full items-start gap-3 rounded-md border px-4 py-3.5 text-left',
    'transition-[background-color,border-color] duration-150 ease-out',
    'hover:bg-accent hover:border-border',
    'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
    disabled && 'pointer-events-none opacity-60',
    className,
  );
  // `trailing` may hold its own control (the connectors grant page's Required
  // toggle), so in select mode it is a SIBLING of the body button, never a
  // child — a <button> inside a <button> is invalid HTML and a hydration error.
  const trailingSlot = trailing ? <span className="shrink-0">{trailing}</span> : null;
  const content = (
    <>
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {description ? (
          <span className="text-muted-foreground line-clamp-2 text-xs text-pretty">
            {description}
          </span>
        ) : null}
        {meta ? (
          <span className="text-muted-foreground/80 flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-xs">
            {meta}
          </span>
        ) : null}
      </span>
    </>
  );
  const body = (
    <>
      {content}
      {trailingSlot}
    </>
  );

  if (select) {
    return (
      <div
        style={style}
        data-selected={select.checked || undefined}
        className={cn(classes, select.checked && 'border-border bg-accent')}
      >
        <Checkbox
          aria-label={select.label}
          checked={select.checked}
          disabled={disabled || select.disabled}
          onCheckedChange={() => select.onCheckedChange()}
          className="mt-0.5"
        />
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none"
        >
          {content}
        </button>
        {trailingSlot}
      </div>
    );
  }
  if (href) {
    return (
      <Link
        href={href}
        prefetch
        aria-disabled={disabled || undefined}
        style={style}
        className={classes}
      >
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={style} className={classes}>
      {body}
    </button>
  );
}
