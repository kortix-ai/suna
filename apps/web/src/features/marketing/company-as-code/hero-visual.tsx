'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { change } from './content';

/**
 * `/company-as-code` hero scene — the spine.
 *
 * The page's claim is that a company is a git repository, so the scene is the
 * one thing a repository actually is: a history. A commit spine runs the full
 * height and bleeds off the bottom, because the history predates the frame.
 *
 * Composition, deliberately not a centred panel:
 *  - the spine is off to the left at 13%, not down the middle;
 *  - the open change request is a large elevated card that overlaps the spine;
 *  - merged commits below it are bare mono rows on the same line, receding in
 *    contrast as they go back, then dissolving into the bottom edge.
 *
 * Real data only. The open request is `change.cr`; the two commits below it are
 * the real SHAs and subjects from the `git log --oneline` block this page
 * already renders in its audit section.
 *
 * MOTION — one pass on mount, then rest.
 */

/** From `grep.shell.lines` — the real log this page prints further down. */
const MERGED = [
  { sha: '8f2a1c4', subject: 'invoice-clerk: stop guessing at refunds' },
  { sha: '1d90b73', subject: 'invoice-clerk: first draft of the persona' },
] as const;

/** Where the spine sits. The card overlaps it rather than starting after it. */
const SPINE = 13;

export function CompanyAsCodeHeroVisual(): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;
  const { cr } = change;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label="A repository's history: one open change request against main, and the merged commits beneath it."
    >
      <div className="relative h-[23rem] w-full max-w-[38rem] overflow-hidden sm:h-[26rem]">
        {/* ── the history, running past the frame ─────────────────────── */}
        <m.span
          className="border-border absolute inset-y-0 origin-top border-l border-dashed mask-b-from-70% mask-b-to-100%"
          style={{ left: `${SPINE}%` }}
          initial={reduceMotion ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.55, delay: 0.08, ease: EASE_OUT }}
          aria-hidden
        />

        <m.span
          className="text-muted-foreground/40 absolute top-5 font-mono text-[10px] tracking-widest uppercase"
          style={{ left: `${SPINE}%`, transform: 'translateX(0.85rem)' }}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.2, ease: EASE_OUT }}
          aria-hidden
        >
          main
        </m.span>

        {/* ── what is open right now ──────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card/95 absolute top-[16%] right-[2%] left-[6%] rounded-lg border p-5 shadow-2xl backdrop-blur-xl"
          {...panel(reduceMotion)}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="bg-foreground ring-card size-2 shrink-0 rounded-full ring-4"
              aria-hidden
            />
            <span className="text-muted-foreground/60 font-mono text-[10px] tracking-widest uppercase">
              {cr.badge}
            </span>
          </div>
          <p className="text-foreground mt-3 text-[15px] leading-snug font-medium text-pretty">
            {cr.title}
          </p>
          <p className="text-muted-foreground/55 mt-2.5 truncate font-mono text-[11px]">
            {cr.file}
          </p>
          <p className="text-muted-foreground/45 mt-3 font-mono text-[11px]">
            {cr.branch} · {cr.author}
          </p>
        </m.div>

        {/* ── and what is already in ──────────────────────────────────── */}
        {MERGED.map((commit, i) => (
          <m.div
            key={commit.sha}
            className="absolute right-[6%] flex items-center gap-3"
            style={{ left: `${SPINE}%`, top: `${68 + i * 13}%` }}
            initial={reduceMotion ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.36, delay: LEAD + 0.42 + i * 0.08, ease: EASE_OUT }}
          >
            <span
              className="border-border bg-background -ml-[0.3rem] size-2 shrink-0 rounded-full border"
              aria-hidden
            />
            <span
              className={
                i === 0
                  ? 'text-foreground/70 shrink-0 font-mono text-[11px] tabular-nums'
                  : 'text-muted-foreground/40 shrink-0 font-mono text-[11px] tabular-nums'
              }
            >
              {commit.sha}
            </span>
            <span
              className={
                i === 0
                  ? 'text-muted-foreground/60 truncate font-mono text-[11px]'
                  : 'text-muted-foreground/35 truncate font-mono text-[11px]'
              }
            >
              {commit.subject}
            </span>
          </m.div>
        ))}
      </div>
    </div>
  );
}
