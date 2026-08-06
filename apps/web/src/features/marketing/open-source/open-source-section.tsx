'use client';

import { Reveal } from '@/components/home/reveal';
import { Github } from '@/features/icon/icons/github';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { openSource } from './content';
import { StarCount } from './star-count';

/**
 * Home-page open-source section — the aspirational note between the security
 * close and the questions under it.
 *
 * Four things on one centred axis: the number, what it counts, why the code is
 * open, and the way out. The number is read live from `/api/github-stars`,
 * never hardcoded, and is the only large numeral on the page. Copy, its sources
 * and the accuracy gate live next door in `content.ts`.
 *
 * ONE THING LEADS. The numeral leads and the sentence supports it, which is why
 * the heading is `text-lg sm:text-xl` rather than the `text-2xl sm:text-3xl` a
 * passage takes. Set at passage weight it fought the 72px number directly above
 * it and a reader had two places to start. Read in order the stack now says:
 * twenty thousand people are watching this / here is what that is a count of /
 * here is why it is open / here is the way in.
 *
 * WHAT WAS CUT TO GET HERE. The first version was a lifted `bg-card` slab —
 * headline, count, two-command terminal, four-row self-hosting ledger, centred
 * closing line, 1014px of it. The second kept a three-sentence body paragraph
 * and borrowed the Control passage's hairline-and-mono-facts foot; the facts
 * (`Developed in the open / Self-host or managed cloud / Any model, your keys`)
 * restated the paragraph, and the rule plus the facts plus two matched links
 * was more furniture than a second-to-last section can carry. Both went.
 *
 * THE TWO LINKS ARE NOT EQUALS, so they are not drawn as equals. `/about` is
 * the rest of the reason and takes the text link; the repo is the proof the
 * number is about something real and sits in the mono register the caption
 * above it already uses. Matched underlines read as a choice between two
 * comparable things, which these are not.
 *
 * WHY THERE IS NO PANEL. The original slab existed because a flat section
 * between the dark trust card and the CTA card read as the gap between two
 * surfaces. That argument dies with the content: a 72px numeral is itself the
 * anchor. Dropping the fill also fixes what `bg-card` cost in dark mode, where a
 * panel this empty was a large lifted rectangle with almost nothing on it.
 *
 * NO WALLPAPER HERE, and that is still deliberate. The brandmark wallpaper
 * (`WallpaperBackground wallpaperId="brandmark"`) was tried at five sizes in the
 * old panel: the mark is a 1px stroke cut for a full viewport, so every setting
 * faint enough to sit under type renders as a smudge and every setting strong
 * enough to read draws a line through the copy. `KortixGrid` is ruled out twice
 * over — it is the signature of the closing CTA, and it paints a
 * `kortix-green`/`kortix-purple` gradient into a section that carries no colour.
 */
export function OpenSourceSection(): ReactNode {
  return (
    <section id="open-source" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      {/* 34rem. Centred text needs a shorter measure than railed text before the
          ragged edges cost more than the symmetry returns, and at this width the
          heading breaks after "platform." — one sentence per line, which is the
          break it wants anyway. */}
      <Reveal className="mx-auto flex max-w-[34rem] flex-col items-center text-center">
        {/* No eyebrow. The caption directly under the digits already says what
            the number is, and a third mono line above it only delayed the one
            thing this section opens on. */}
        <StarCount caption={openSource.stars.caption} />

        <h2 className="text-foreground mt-9 text-lg font-medium tracking-tight text-balance sm:text-xl">
          {openSource.title}
        </h2>

        <div className="mt-6 flex flex-col items-center gap-3">
          <Link
            href={openSource.aboutHref}
            className="text-foreground duration-fast inline-flex text-sm underline decoration-current/25 underline-offset-4 transition-colors hover:decoration-current"
          >
            {openSource.aboutLabel} →
          </Link>

          <a
            href={openSource.repoHref}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground duration-fast inline-flex items-center gap-2 font-mono text-[10px] tracking-widest uppercase transition-colors"
          >
            <Github className="size-3.5" />
            {openSource.repoLabel}
          </a>
        </div>
      </Reveal>
    </section>
  );
}
