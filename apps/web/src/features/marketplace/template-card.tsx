'use client';

import Link from 'next/link';

import { cn } from '@/lib/utils';
import { templateVisual } from './template-visual';
import { type MarketplaceTemplate, templateRepoSlug } from './templates-catalog';

/**
 * The template card — minimal on purpose: tile + title + install affordance on
 * one row, a two-line description, and a quiet mono `owner/repo` row. The
 * WHOLE card is one button that opens the install modal, so the Install
 * affordance is a styled `span`, never a nested `<button>` — the same
 * one-control rule `AppCard` follows.
 *
 * Every card in a grid is the SAME height, and two things are load-bearing for
 * that: the description reserves two line boxes whether or not it fills them,
 * and the card fills its grid cell (`h-full`). See the notes on each.
 */
export function TemplateCard({
  template,
  onOpen,
  href,
}: {
  template: MarketplaceTemplate;
  /** Omitted on the public grid, where the card is a link instead of a button. */
  onOpen?: () => void;
  /**
   * Render the card as a link to this destination instead of a button. The
   * public `/marketplace` grid sets it so every card is a real `<a href>` a
   * crawler can follow; the in-project store leaves it unset and opens the
   * install modal.
   */
  href?: string;
}) {
  const { Icon, color, bgColor } = templateVisual(template.slug);
  const className = cn(
    // `h-full`, not just `w-full`: the card is wrapped in an `<li>` grid cell,
    // and a grid cell stretches while the button inside it does not. Without
    // this a short card leaves a gap under itself in a stretched row.
    'group hover:border-foreground/20 bg-popover flex h-full w-full cursor-pointer flex-col gap-2.5 rounded-md border p-4 text-left',
    'duration-normal transition-[border-color,transform] hover:-translate-y-0.5 active:scale-[0.99]',
  );
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        {/* Tinted status tile — the sanctioned tinted-tile + fill-icon pattern.
            The pair is derived from the slug (see `templateVisual`), never stored. */}
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-sm',
            bgColor,
            color,
          )}
        >
          <Icon weight="fill" className="size-5" aria-hidden />
        </span>
        <span className="text-foreground min-w-0 truncate text-sm font-medium">
          {template.title}
        </span>
        {/* The install affordance — a styled span, not a button, so the card
            stays the one control. */}
        <span
          aria-hidden
          className={cn(
            'bg-background text-foreground ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
            'group-hover:bg-foreground group-hover:text-background duration-normal transition-colors',
          )}
        >
          Install
        </span>
      </div>
      {/* `min-h-[2lh]` — exactly two line boxes of THIS paragraph, so a template
          with a one-line description reserves the same height as one with two
          and every card in the grid matches. Derived from the computed
          line-height, so it stays correct if either token moves. */}
      <p className="text-muted-foreground line-clamp-2 min-h-[2lh] text-xs leading-relaxed text-pretty">
        {template.description ?? 'No description in its kortix.yaml.'}
      </p>
      <div className="text-muted-foreground mt-auto flex items-center gap-1.5 pt-0.5 text-xs">
        <span className="min-w-0 truncate font-mono">{templateRepoSlug(template)}</span>
      </div>
    </>
  );
  // A crawler follows `<a href>`, not an onClick — so the PUBLIC grid passes
  // `href` and the card renders as a Link. Either way it stays ONE control.
  if (href) {
    return (
      // No `aria-label` here: the card's visible title IS the link's accessible
      // name, and "Install X" would misdescribe a link that opens a detail page.
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Install ${template.title}`}
      className={className}
    >
      {body}
    </button>
  );
}
