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
  /** Rendered on its own row directly under the title — a short token, not
   *  prose. Unlike `description` it takes nodes. */
  subtitle?: ReactNode;
  /** `plain` drops the border and resting fill — icon and title on the bare
   *  page, only a hover fill. The connector catalogue uses it; every other
   *  catalogue keeps the outlined default. */
  variant?: 'default' | 'plain';
  trailing?: ReactNode;
  /** `trailing` holds its own control (an Install menu). With `href` the card
   *  then renders the link and the control as siblings: a button inside an
   *  anchor is invalid HTML and a hydration error. */
  trailingInteractive?: boolean;
  /** A card that NAVIGATES renders as a real `next/link` — prefetched, middle-
   *  clickable, and a client transition rather than a `router.push` from a
   *  button (see the no-hard-refresh nav contract). Cards that open a modal
   *  in place keep `onClick`. Exactly one of the two. */
  href?: string;
  /** Pointer or keyboard intent on a navigating card, before the click. Used
   *  to start the destination's data read ~200–500 ms early. */
  onIntent?: () => void;
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
  subtitle,
  variant = 'default',
  trailing,
  trailingInteractive,
  href,
  onIntent,
  onClick,
  disabled,
  className,
  style,
  select,
}: CatalogCardProps) {
  const classes = cn(
    'group flex w-full items-start gap-3 rounded-md border text-left',
    'transition-[background-color,border-color] duration-(--duration-normal) ease-out',
    variant === 'plain'
      ? 'border-transparent bg-transparent px-3 py-2.5 hover:bg-accent'
      : 'bg-accent/50 border-border/60 hover:bg-accent hover:border-border px-4 py-3.5',
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
      <span className={cn('min-w-0 flex-1', variant === 'plain' ? 'space-y-0' : 'space-y-1')}>
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {subtitle ? <span className="flex flex-wrap items-center gap-1.5">{subtitle}</span> : null}
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
  if (href && trailingInteractive) {
    return (
      // The wrapper is not focusable, so `classes`' own `focus-visible` ring
      // never paints here: `has-` draws the same ring while the link holds
      // keyboard focus. The link's `after` covers the card, so the padding
      // still navigates; the control is `relative` to stay above it.
      <div
        style={style}
        className={cn(
          classes,
          'has-[a:focus-visible]:ring-ring/50 relative has-[a:focus-visible]:ring-2',
        )}
      >
        <Link
          href={href}
          prefetch
          aria-disabled={disabled || undefined}
          onPointerEnter={onIntent}
          onFocus={onIntent}
          className="flex min-w-0 flex-1 items-start gap-3 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          {content}
        </Link>
        {trailing ? <span className="relative shrink-0">{trailing}</span> : null}
      </div>
    );
  }
  if (href) {
    return (
      <Link
        href={href}
        prefetch
        aria-disabled={disabled || undefined}
        onPointerEnter={onIntent}
        onFocus={onIntent}
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
