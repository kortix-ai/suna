'use client';

import { CheckIcon, DownloadSimpleIcon, PlusIcon, StarIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { craftVisual } from './craft-visual';
import { craftIsUpload, craftRepoSlug, formatCount, type Craft } from './crafts-catalog';

/**
 * The craft card — minimal on purpose: tile + title + install affordance on
 * one row, a two-line description, and a quiet mono repo row
 * (`owner/repo · ★ stars · installs`). The WHOLE card is one button that opens
 * the install modal, so the Install affordance is a styled `span`, never a
 * nested `<button>` — the same one-control rule `AppCard` follows.
 *
 * `glass` swaps the panel fill for the translucent one the project home paints
 * over the wallpaper — the same treatment the old starter chips used.
 */
export function CraftCard({
  craft,
  installed = false,
  onOpen,
  glass = false,
  compact = false,
}: {
  craft: Craft;
  /**
   * Whether THIS project has it. Passed in rather than read off the craft: the
   * index row is account-global, and the same craft is installed in one project
   * and not another. `useProjectCrafts` is the only source of this answer.
   */
  installed?: boolean;
  onOpen: () => void;
  /** Translucent fill for surfaces painted over the wallpaper (project home). */
  glass?: boolean;
  /**
   * The narrow home-preview form. At the home grid's ~261px the full meta row
   * (`owner/repo` + stars + installs) forces the slug into a 3-character stub,
   * so the compact card drops the installs metric and keeps the slug readable.
   * The store's wider cards carry all three.
   */
  compact?: boolean;
}) {
  const { Icon, color, bgColor } = craftVisual(craft.slug);
  const upload = craftIsUpload(craft);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={installed ? `${craft.title} — installed` : `Install ${craft.title}`}
      className={cn(
        'group hover:border-foreground/20 flex w-full cursor-pointer flex-col gap-2.5 rounded-md border p-4 text-left',
        'transition-[border-color,transform] duration-150 hover:-translate-y-0.5 active:scale-[0.99]',
        glass ? 'bg-background/60 backdrop-blur-sm' : 'bg-popover',
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Tinted status tile — the sanctioned tinted-tile + fill-icon pattern.
            The pair is derived from the slug (see `craftVisual`), never stored. */}
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-sm',
            bgColor,
            color,
          )}
        >
          <Icon weight="fill" className="size-5" aria-hidden />
        </span>
        <span className="text-foreground min-w-0 truncate text-sm font-medium">{craft.title}</span>
        {/* Installed crafts carry the status pill (earned green, like the
            connect dots); open ones carry the install affordance — a styled
            span, not a button, so the card stays the one control. */}
        {installed ? (
          <span
            aria-label="Installed"
            className={cn(
              'border-kortix-green/30 bg-kortix-green/15 text-kortix-green ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border py-0.5 text-xs font-medium',
              compact ? 'px-2' : 'px-2.5',
            )}
          >
            <CheckIcon weight="fill" className="size-3" aria-hidden />
            Installed
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              'bg-background text-foreground ml-auto inline-flex shrink-0 items-center rounded-full border py-0.5 text-xs font-medium',
              compact ? 'px-2' : 'px-2.5',
              'group-hover:bg-foreground group-hover:text-background transition-colors duration-150',
            )}
          >
            Install
          </span>
        )}
      </div>
      <p className="text-muted-foreground line-clamp-2 min-h-9 text-xs leading-relaxed text-pretty">
        {craft.description ?? 'No description in its kortix.yaml.'}
      </p>
      <div className="text-muted-foreground mt-auto flex items-center gap-1.5 pt-0.5 text-xs">
        <span className="min-w-0 truncate font-mono">{craftRepoSlug(craft)}</span>
        {/* Stars are a GitHub fact. An upload has none, and `0` would read as
            "nobody starred it" rather than "the question does not apply", so the
            metric is omitted instead of zeroed. */}
        {upload || craft.stars === null ? null : (
          <>
            <span aria-hidden className="text-muted-foreground/40 shrink-0">
              &bull;
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <StarIcon weight="fill" className="size-3" aria-hidden />
              {formatCount(craft.stars)}
            </span>
          </>
        )}
        {compact ? null : (
          <>
            <span aria-hidden className="text-muted-foreground/40 shrink-0">
              &bull;
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <DownloadSimpleIcon className="size-3" aria-hidden />
              {formatCount(craft.install_count)}
            </span>
          </>
        )}
      </div>
    </button>
  );
}

/**
 * The dashed end-of-row card. On the project home it is a LINK into the store;
 * in the store it is a BUTTON that opens the add-a-craft modal.
 */
export function CraftBuildCard({
  glass = false,
  href,
  onClick,
}: {
  glass?: boolean;
  /** When set, the card renders as a link to that destination. */
  href?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          'bg-muted text-muted-foreground',
        )}
      >
        <PlusIcon className="size-4" aria-hidden />
      </span>
      <span className="text-sm font-medium">Grow your crafts</span>
      <span className="text-muted-foreground text-center text-xs leading-relaxed text-pretty">
        Describe a craft and Kortix builds it.
      </span>
    </>
  );
  const className = cn(
    'hover:border-foreground/30 text-muted-foreground hover:text-foreground flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4',
    'transition-colors duration-150 active:scale-[0.99]',
    glass ? 'bg-background/40 backdrop-blur-sm' : 'bg-transparent',
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {body}
    </button>
  );
}
