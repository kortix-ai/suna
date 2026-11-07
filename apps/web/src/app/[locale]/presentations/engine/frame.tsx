'use client';

/**
 * The slide frame: the landing page, at 16:9.
 *
 * A slide is the landing's page frame (`features/marketing/kit/page-frame.tsx`)
 * cut to one viewport: the 1440px column between two hairline rails, a
 * two-tone title, and one band whose hairlines cross the page and fade past
 * the rails (`kx-rail-fade`). The band carries the artifact: code, cells,
 * a screenshot or a diagram. Cells split by hairlines (`gap-px` over
 * `bg-border`). No eyebrow, no kicker, no reveal motion: a build step raises
 * opacity and nothing else moves.
 *
 * Spacing lines up with the landing: the title sits at `px-8 lg:px-28`, and
 * the band's content starts at the same edge (band `lg:px-17` + inner
 * `lg:px-11`).
 */

import { cn } from '@kortix/ui';
import { FileTextIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/* ── builds ─────────────────────────────────────────────────────────────── */

/**
 * A build-aware wrapper: ghosted until `on`, then lit. Opacity only, so the
 * layout never moves. Every ghost in every deck comes from here.
 */
export function Reveal({
  on,
  children,
  className,
}: {
  on: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'duration-slower transition-opacity ease-out',
        on ? 'opacity-100' : 'opacity-15',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── the frame ──────────────────────────────────────────────────────────── */

/** The two rails, 62px in from the column's edges on desktop. */
function Rails() {
  return (
    <>
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17"
      />
      <div
        aria-hidden
        className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17"
      />
    </>
  );
}

/** A band whose hairlines cross the page, its content between the rails. */
export function Band({
  children,
  className,
  innerClassName,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  return (
    <div className={cn('kx-rail-fade border-y px-4 lg:px-17', className)}>
      <div className={cn('bg-card px-4 py-8 lg:px-11 lg:py-10', innerClassName)}>{children}</div>
    </div>
  );
}

const TITLE_SIZE = {
  /** The cover: the landing hero's scale, one rung up for a projector. */
  cover: 'text-4xl sm:text-5xl lg:text-6xl',
  /** Every other slide: the landing's section title, one rung up. */
  slide: 'text-2xl sm:text-3xl lg:text-4xl',
} as const;

/**
 * One slide. The title is two-tone: `title` in ink, `titleMuted` on its own
 * line in the muted colour, same size and weight. `sub` is one sentence. The
 * band (`children`) holds the artifact.
 */
export function Slide({
  title,
  titleMuted,
  sub,
  children,
  size = 'slide',
  bandClassName,
}: {
  title: ReactNode;
  titleMuted?: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  size?: keyof typeof TITLE_SIZE;
  bandClassName?: string;
}) {
  return (
    <div className="bg-background relative mx-auto flex h-full w-full max-w-[1440px] flex-col">
      <Rails />
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-10 pt-20 pb-20 lg:gap-12">
        <header className="px-8 lg:px-28">
          <h2
            className={cn(
              'text-foreground max-w-5xl font-medium tracking-tight text-balance',
              TITLE_SIZE[size],
            )}
          >
            {title}
            {titleMuted ? (
              <>
                {' '}
                <span className="text-muted-foreground block">{titleMuted}</span>
              </>
            ) : null}
          </h2>
          {sub ? (
            <p className="text-muted-foreground mt-5 max-w-2xl text-base text-pretty sm:text-lg">
              {sub}
            </p>
          ) : null}
        </header>
        {children ? <Band innerClassName={bandClassName}>{children}</Band> : null}
      </div>
    </div>
  );
}

/* ── what goes in a band ────────────────────────────────────────────────── */

/** Cells split by hairlines: the band's grid over the border colour. */
export function Cells({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'bg-border border-border grid grid-cols-1 gap-px overflow-hidden rounded-sm border',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One cell: a quiet label, a title, a line of body. Any part may be absent. */
export function Cell({
  label,
  title,
  children,
  on = true,
  className,
}: {
  label?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  on?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('bg-background flex flex-col gap-3 p-6 lg:p-8', className)}>
      <Reveal on={on} className="flex h-full flex-col gap-3">
        {label ? (
          <span className="text-muted-foreground font-mono text-xs tabular-nums">{label}</span>
        ) : null}
        {title ? (
          <h3 className="text-foreground text-lg font-medium tracking-tight text-pretty">{title}</h3>
        ) : null}
        {children ? (
          <div className="text-muted-foreground text-sm leading-relaxed text-pretty">{children}</div>
        ) : null}
      </Reveal>
    </div>
  );
}

/** Key / value rows on hairlines. `upTo` ghosts the rows a build has not reached. */
export function Rows({
  rows,
  upTo,
  className,
}: {
  rows: readonly { readonly id: string; readonly k: ReactNode; readonly v: ReactNode }[];
  upTo?: number;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'border-border bg-background divide-border divide-y overflow-hidden rounded-sm border',
        className,
      )}
    >
      {rows.map((row, i) => (
        <Reveal key={row.id} on={upTo === undefined || i <= upTo}>
          <div className="grid grid-cols-1 gap-y-2 px-6 py-5 lg:grid-cols-12 lg:gap-x-8 lg:px-8">
            <dt className="text-foreground text-base font-medium text-pretty lg:col-span-4">
              {row.k}
            </dt>
            <dd className="text-muted-foreground text-sm leading-relaxed text-pretty lg:col-span-8">
              {row.v}
            </dd>
          </div>
        </Reveal>
      ))}
    </dl>
  );
}

/**
 * Literal text: a file excerpt or a terminal. `title` names the file or the
 * shell. A line that is only `…` marks a cut, and a line that starts with `# `
 * is a comment: both are muted. A line that starts with `$ ` is a command;
 * the prompt is set in the muted colour.
 */
export function Code({
  title,
  lines,
  className,
  textClassName = 'text-sm',
}: {
  title: string;
  lines: readonly string[];
  className?: string;
  textClassName?: string;
}) {
  return (
    <div className={cn('border-border bg-background overflow-hidden rounded-sm border', className)}>
      <p className="border-border text-muted-foreground border-b px-5 py-2.5 font-mono text-xs">
        {title}
      </p>
      <pre className={cn('overflow-hidden px-5 py-4 font-mono leading-relaxed', textClassName)}>
        {lines.map((line, i) => {
          if (line.trim() === '…' || line.startsWith('# '))
            return (
              <span key={i} className="text-muted-foreground block">
                {line}
              </span>
            );
          if (line.startsWith('$ '))
            return (
              <span key={i} className="text-foreground block">
                <span className="text-muted-foreground">$ </span>
                {line.slice(2)}
              </span>
            );
          return (
            <span key={i} className="text-foreground block">
              {line}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

/** A real product screenshot. Capped in `vh`: a slide never scrolls. */
export function Shot({
  src,
  alt,
  className,
  imgClassName = 'max-h-[52vh] object-cover object-top',
}: {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
}) {
  return (
    <div className={cn('border-border bg-background overflow-hidden rounded-sm border', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className={cn('block w-full select-none', imgClassName)}
        draggable={false}
      />
    </div>
  );
}

/* ── inline ─────────────────────────────────────────────────────────────── */

/** Literal text inside a sentence: a path, a key, a command. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono', className)}>{children}</span>;
}

/** The muted half of a two-tone line, inline. */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/* ── a project tree ─────────────────────────────────────────────────────── */

export type TreeRow = {
  /** The file or folder name. A folder ends in `/`. */
  readonly name: string;
  /** Nesting depth: 0 under the root. */
  readonly depth: number;
  /** One short note, muted, in the right column. */
  readonly note?: ReactNode;
  /** A muted row, such as "+7 more". */
  readonly quiet?: boolean;
};

/**
 * A repository as a file tree: the root name on top, one row per file or
 * folder, an indent guide per level, and a note column. Folder and file
 * glyphs come from Phosphor, as on the landing.
 */
export function Tree({
  root,
  meta,
  rows,
  className,
}: {
  root: string;
  meta?: ReactNode;
  rows: readonly TreeRow[];
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-background overflow-hidden rounded-sm border', className)}>
      <div className="border-border flex items-center justify-between gap-4 border-b px-5 py-3">
        <span className="text-foreground flex items-center gap-2 font-mono text-sm">
          <FolderSimpleIcon aria-hidden className="text-muted-foreground size-4" />
          {root}
        </span>
        {meta ? <span className="text-muted-foreground font-mono text-xs">{meta}</span> : null}
      </div>
      <ul className="py-2">
        {rows.map((row) => {
          const folder = row.name.endsWith('/');
          const Glyph = folder ? FolderSimpleIcon : FileTextIcon;
          return (
            <li
              key={`${row.depth}:${row.name}`}
              className="grid grid-cols-12 items-center gap-6 px-5 py-1.5"
            >
              <span className="col-span-5 flex items-center">
                {Array.from({ length: row.depth + 1 }, (_, i) => (
                  <span key={i} aria-hidden className="border-border h-7 w-5 shrink-0 border-l" />
                ))}
                {row.quiet ? (
                  <span aria-hidden className="mr-2 size-4 shrink-0" />
                ) : (
                  <Glyph aria-hidden className="text-muted-foreground mr-2 size-4 shrink-0" />
                )}
                <span
                  className={cn(
                    'truncate font-mono text-base',
                    row.quiet ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  {row.name}
                </span>
              </span>
              <span className="text-muted-foreground col-span-7 text-sm text-pretty">
                {row.note}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
