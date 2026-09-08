'use client';

import { ArrowRightIcon, GithubLogoIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { templateVisual } from './template-visual';
import { type Template, countLabel } from './templates-catalog';

/**
 * One template, as a card.
 *
 * It reads as an ACTION card — a banner that gives the template a face, then
 * the name, what it does, where it came from, and the affordance — rather than
 * a dense utility row. That is the right weight for the primary surface of a
 * catalog whose whole job is "pick one of these".
 *
 * The banner is the template's identity, not decoration: the hue comes from
 * `templateVisual`, so the same template wears the same colour on this card, on
 * its detail page, and in the install modal, and a grid of otherwise identical
 * shapes stays scannable.
 *
 * The WHOLE card is one control. On the public catalog it is a real `<a href>`
 * a crawler follows to the detail page; in the in-project store it is a button
 * that opens the install modal. Either way the affordance in the corner is a
 * styled `span`, never a nested `<button>`.
 */
export function TemplateCardSkeleton({ size = 'featured' }: { size?: 'default' | 'featured' }) {
  const featured = size === 'featured';
  return (
    // Shape-matched to the card above — banner, title, two description lines,
    // meta row — so the grid does not jump when the catalog lands. A single
    // fixed-height block would have to guess the card's height and be wrong the
    // moment any of its type or spacing moves.
    <div className="bg-popover overflow-hidden rounded-md border">
      <Skeleton className={cn('w-full rounded-none', featured ? 'h-32' : 'h-20')} />
      <div className={cn('space-y-2', featured ? 'p-6' : 'p-5')}>
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-4 h-4 w-1/2" />
      </div>
    </div>
  );
}

export function TemplateCard({
  template,
  onOpen,
  href,
  size = 'featured',
}: {
  template: Template;
  /** Opens the install modal. The in-project store passes this instead of `href`. */
  onOpen?: () => void;
  /** Renders the card as a link. The public grid passes this instead of `onOpen`. */
  href?: string;
  /**
   * `featured` is the catalog's own grid — a taller banner and a larger title.
   * `default` is the compact form for cross-links ("Other templates").
   */
  size?: 'default' | 'featured';
}) {
  const { Icon, banner, color } = templateVisual(template.slug);
  const featured = size === 'featured';

  const className = cn(
    // `h-full`, not just `w-full`: the card sits in a stretched grid cell, and
    // the element inside it does not stretch on its own. Without this a short
    // card leaves a gap under itself in a taller row.
    'group bg-popover hover:border-foreground/20 flex h-full w-full flex-col overflow-hidden rounded-md border text-left',
    'duration-normal transition-[border-color,transform] ease-out active:scale-[0.99]',
  );

  const body = (
    <>
      <div
        className={cn(
          'flex items-center justify-center bg-gradient-to-br',
          banner,
          featured ? 'h-32' : 'h-20',
        )}
      >
        <Icon
          weight="fill"
          className={cn(featured ? 'size-9' : 'size-6', color, 'opacity-80')}
          aria-hidden
        />
      </div>

      <div className={cn('flex flex-1 flex-col gap-4', featured ? 'p-6' : 'p-5')}>
        <div className="min-w-0 space-y-1.5">
          <div
            className={cn(
              'text-foreground font-medium tracking-tight text-balance',
              featured ? 'text-lg' : 'text-base',
            )}
          >
            {template.title}
          </div>
          {template.description ? (
            <p className="text-muted-foreground line-clamp-2 text-sm leading-relaxed text-pretty">
              {template.description}
            </p>
          ) : null}
        </div>

        {/* `mt-auto` pins this row to the bottom, so the affordance sits on one
            line across a row of cards whose descriptions differ in length. */}
        <div className="mt-auto flex items-center justify-between gap-3 pt-1">
          <span className="text-muted-foreground/70 inline-flex min-w-0 items-center gap-1.5 text-xs">
            <GithubLogoIcon className="size-3.5 shrink-0" aria-hidden />
            {/* The publisher, not the full `owner/repo`: the repo slug is long
                enough to truncate away the count beside it, and the count is
                the part that helps you choose. The full slug is one click away
                on the detail page. */}
            <span className="truncate font-mono">{template.repo_owner}</span>
            {template.agents.length > 0 ? (
              <span className="shrink-0 tabular-nums">
                · {countLabel(template.agents.length, 'agent')}
              </span>
            ) : null}
          </span>
          <span className="text-foreground group-hover:text-kortix-base duration-normal inline-flex shrink-0 items-center gap-1 text-sm font-medium transition-colors ease-out">
            {href ? 'View' : 'Install'}
            <ArrowRightIcon
              className="duration-normal size-3.5 transition-transform ease-out group-hover:translate-x-0.5"
              aria-hidden
            />
          </span>
        </div>
      </div>
    </>
  );

  if (href) {
    // No `aria-label`: the card's visible title IS the link's accessible name,
    // and "Install X" would misdescribe a link that opens a detail page.
    return (
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
      className={cn(className, 'cursor-pointer')}
    >
      {body}
    </button>
  );
}
