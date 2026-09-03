'use client';

import {
  CheckIcon,
  DownloadSimpleIcon,
  GithubLogoIcon,
  SparkleIcon,
  StarIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { subprojectVisual } from './subproject-visual';
import {
  formatCount,
  subprojectIsUpload,
  subprojectRepoSlug,
  type Subproject,
} from './subprojects-catalog';

/**
 * The subproject card — minimal on purpose: tile + title + install affordance on
 * one row, a two-line description, and a quiet mono repo row
 * (`owner/repo · ★ stars · installs`). The WHOLE card is one button that opens
 * the install modal, so the Install affordance is a styled `span`, never a
 * nested `<button>` — the same one-control rule `AppCard` follows.
 *
 * Every card in a grid is the SAME height, and two things are load-bearing for
 * that: the description reserves two line boxes whether or not it fills them,
 * and the card fills its grid cell (`h-full`). See the notes on each.
 *
 * `glass` swaps the panel fill for the translucent one the project home paints
 * over the wallpaper — the same treatment the old starter chips used.
 */
export function SubprojectCard({
  subproject,
  installed = false,
  onOpen,
  href,
  glass = false,
  compact = false,
}: {
  subproject: Subproject;
  /**
   * Whether THIS project has it. Passed in rather than read off the subproject: the
   * index row is account-global, and the same subproject is installed in one project
   * and not another. `useProjectSubprojects` is the only source of this answer.
   */
  installed?: boolean;
  /** Omitted on the public grid, where the card is a link instead of a button. */
  onOpen?: () => void;
  /**
   * Render the card as a link to this destination instead of a button. The public
   * `/marketplace` grid sets it so every card is a real `<a href>` a crawler can
   * follow; the in-project store leaves it unset and opens the install modal.
   */
  href?: string;
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
  const { Icon, color, bgColor } = subprojectVisual(subproject.slug);
  const upload = subprojectIsUpload(subproject);
  const label = installed ? `${subproject.title} — installed` : `Install ${subproject.title}`;
  const className = cn(
    // `h-full`, not just `w-full`: in the store the card is wrapped in an
    // `<li>` grid cell, and a grid cell stretches while the button inside
    // it does not. Without this the card keeps its content height and a
    // short one leaves a gap under itself in a stretched row. The home
    // preview renders the card as a direct grid child, where the stretch
    // already applied — which is why only the store row looked broken.
    'group hover:border-foreground/20 flex h-full w-full cursor-pointer flex-col gap-2.5 rounded-md border p-4 text-left',
    'duration-normal transition-[border-color,transform] hover:-translate-y-0.5 active:scale-[0.99]',
    glass ? 'bg-background/60 backdrop-blur-sm' : 'bg-popover',
  );
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        {/* Tinted status tile — the sanctioned tinted-tile + fill-icon pattern.
              The pair is derived from the slug (see `subprojectVisual`), never stored. */}
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
          {subproject.title}
        </span>
        {/* Installed subprojects carry the status pill (earned green, like the
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
              'group-hover:bg-foreground group-hover:text-background duration-normal transition-colors',
            )}
          >
            Install
          </span>
        )}
      </div>
      {/* `min-h-[2lh]` — exactly two line boxes of THIS paragraph, so a subproject
            with a one-line description reserves the same height as a subproject with
            two and every card in the grid matches. `min-h-9` reserved 33.12px
            (`--spacing` is `0.23rem`) against a 42.25px pair of lines at the 13px
            `--text-xs` and `leading-relaxed` — 1.57 lines, which left the short
            card 9.14px shorter than its neighbours. `2lh` is derived from the
            computed line-height, so it stays correct if either token moves. */}
      <p className="text-muted-foreground line-clamp-2 min-h-[2lh] text-xs leading-relaxed text-pretty">
        {subproject.description ?? 'No description in its kortix.yaml.'}
      </p>
      <div className="text-muted-foreground mt-auto flex items-center gap-1.5 pt-0.5 text-xs">
        <span className="min-w-0 truncate font-mono">{subprojectRepoSlug(subproject)}</span>
        {/* Stars are a GitHub fact. An upload has none, and `0` would read as
              "nobody starred it" rather than "the question does not apply", so the
              metric is omitted instead of zeroed. */}
        {upload || subproject.stars === null ? null : (
          <>
            <span aria-hidden className="text-muted-foreground/40 shrink-0">
              &bull;
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
              <StarIcon weight="fill" className="size-3" aria-hidden />
              {formatCount(subproject.stars)}
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
              {formatCount(subproject.install_count)}
            </span>
          </>
        )}
      </div>
    </>
  );
  // A crawler follows `<a href>`, not an onClick — so the PUBLIC grid passes
  // `href` and the card renders as a Link, the same shape
  // `SubprojectBuildCard` below uses. Either way it stays ONE control.
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
    <button type="button" onClick={onOpen} aria-label={label} className={className}>
      {body}
    </button>
  );
}

/**
 * The dashed card. Two jobs, one shape:
 *
 *  - `grow` (default) — describe a subproject and have one built.
 *  - `add` — index a subproject that already exists, from a repo or a `.zip`.
 *
 * They are siblings, not a mode switch: one creates, the other imports. On the
 * project home the card is a LINK into the store; in the store it is a BUTTON
 * that opens the matching modal.
 */
export function SubprojectBuildCard({
  glass = false,
  variant = 'grow',
  href,
  onClick,
}: {
  glass?: boolean;
  variant?: 'grow' | 'add';
  /** When set, the card renders as a link to that destination. */
  href?: string;
  onClick?: () => void;
}) {
  const add = variant === 'add';
  const body = (
    <>
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-sm',
          'bg-muted text-muted-foreground',
        )}
      >
        {add ? (
          <GithubLogoIcon className="size-4" aria-hidden />
        ) : (
          <SparkleIcon className="size-4" aria-hidden />
        )}
      </span>
      <span className="text-sm font-medium">
        {add ? 'Add a subproject' : 'Grow your subprojects'}
      </span>
      <span className="text-muted-foreground text-center text-xs leading-relaxed text-pretty">
        {add
          ? 'Point at a GitHub repo, or upload a .zip.'
          : 'Describe a subproject and Kortix builds it.'}
      </span>
    </>
  );
  const className = cn(
    'hover:border-foreground/30 text-muted-foreground hover:text-foreground flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4',
    'transition-colors duration-normal active:scale-[0.99]',
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
