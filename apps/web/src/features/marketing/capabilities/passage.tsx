'use client';

import { Reveal } from '@/components/home/reveal';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Passage as PassageContent } from './content';

/**
 * The shared shell all four passages are built on.
 *
 * WHY ONE SHELL. The four no longer sit together, so nothing else can tell a
 * reader they are the same species. Identical rail, identical measure, identical
 * foot: meet the third one and you already know what it is and how long it will
 * take. Four bespoke layouts would have been four more one-off surfaces on a
 * page that already has six. Same argument as `interludes/interlude.tsx`.
 *
 * WHY IT IS NOT A CARD. This is the only material on the home page that is meant
 * to be READ — everything around it is a hero video, a pinned card stack, a
 * wheel, a slab and a dark trust card. A card is a thing you scan. So there is
 * not a single box, fill or border-radius in here; the structure is entirely
 * typographic. One hairline appears, and only to separate the read from the
 * scan layer under it.
 *
 * WHY IT DOES NOT LOOK LIKE THE INTERLUDES. Those are 5/7 two-column sections
 * with a bordered panel on one side. This is a single narrow document with a
 * mono rail. A reader must never mistake one for the other, or the alternation
 * they were both built for stops working.
 *
 * WHY IT IS NARROWER THAN THE PAGE. The section shell is the page-standard
 * `mx-auto max-w-7xl px-6`, but the document inside is 45rem: a 10rem rail, a
 * 3rem gutter and a 32rem body that measures 67 characters per line at the base
 * size — inside the 65–70 a reader can hold. Long-form text set to the full grid
 * is unreadable, and the narrowing is what signals "this one is different, slow
 * down".
 *
 * WHY THE TITLE IS ONE STEP DOWN. Section pillars on this page run
 * `text-3xl sm:text-4xl`. Four passages at that weight would read as four more
 * pillars and flatten the page's rhythm. `text-2xl sm:text-3xl` says "a passage,
 * not a pillar" without whispering.
 *
 * Copy, and the accuracy gate every line of it had to pass, live in
 * `content.ts`. Read that file before editing a word here.
 */

/* ── mono tokens ───────────────────────────────────────────────────────────
   Product nouns, config keys, paths and template tokens are set in mono per
   the brand rules. Keeping the copy in `content.ts` as plain strings (rather
   than JSX) is what lets it stay reviewable and, later, translatable — so the
   markup is applied here, from one explicit list. Ordered longest-first so
   `kortix.yaml` can never be eaten by a shorter alternative. */
const MONO =
  /(\{\{ [a-z._*]+ \}\}|kortix\.yaml|kortix init|kortix ship|SKILL\.md|\/workspace|git revert|AES-256-GCM|HMAC-SHA256|\bgrep\b|\bmain\b)/g;

function withMono(text: string): ReactNode[] {
  // Key each part by its source offset — content-derived and unique even when
  // the same token appears twice. Split output strictly alternates prose
  // (even, may be empty) and captured token (odd, never empty), so the
  // tok/txt prefix keeps a leading empty prose part from colliding with the
  // token that shares its offset.
  let offset = 0;
  return text.split(MONO).map((part, i) => {
    const isToken = i % 2 === 1;
    const key = `${isToken ? 'tok' : 'txt'}-${offset}`;
    offset += part.length;
    return isToken ? (
      /* `whitespace-nowrap` matters: without it `AES-256-GCM` breaks at its own
         hyphens and `{{ cron.scheduled_for }}` splits across two lines at its
         braces, which reads as a typo rather than a token. Every token in the
         list above fits the 390px measure whole, so nothing can overflow. */
      <code
        key={key}
        className="text-foreground font-mono text-[0.85em] tracking-tight whitespace-nowrap"
      >
        {part}
      </code>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

/**
 * One passage: a mono eyebrow in the rail, a title, the read, and a foot that
 * carries the hard facts and the one link out.
 *
 * The rail stacks above the body below `md` rather than shrinking — a 10rem
 * column and a 67-character measure cannot both survive 390px. Stacked, the
 * eyebrow still reads as the kicker it is.
 */
export function Passage({ passage }: { passage: PassageContent }): ReactNode {
  return (
    <section id={passage.id} className="mx-auto max-w-7xl px-6 py-24 sm:py-30">
      <Reveal className="mx-auto max-w-[45rem]">
        <div className="grid gap-x-12 gap-y-4 md:grid-cols-[10rem_minmax(0,1fr)]">
          {/* rail · what this one is about */}
          <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase md:mt-2.5">
            {passage.eyebrow}
          </p>

          {/* body · the measure column */}
          <div className="min-w-0 max-w-[32rem]">
            <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance sm:text-3xl">
              {passage.title}
            </h2>

            <div className="mt-5 space-y-4">
              {passage.paragraphs.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="text-muted-foreground text-base leading-[1.7]"
                >
                  {withMono(paragraph)}
                </p>
              ))}
            </div>

            {/* The foot. One hairline is the whole of it: it closes the read,
                and it is what makes each passage look like a finished document
                rather than a paragraph someone stopped writing. The separator
                TRAILS its fact rather than leading the next one, so a wrap
                leaves the slash at the end of a line instead of orphaning it at
                the start of the next. */}
            <div className="border-border/60 mt-7 border-t pt-5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                {passage.facts.map((fact, i) => (
                  <span key={fact} className="flex items-center gap-2">
                    <span className="text-muted-foreground/80 font-mono text-[10px] tracking-widest whitespace-nowrap uppercase">
                      {fact}
                    </span>
                    {i < passage.facts.length - 1 ? (
                      <span aria-hidden className="text-muted-foreground/30 font-mono text-[10px]">
                        /
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>

              <Link
                href={passage.href}
                className="text-foreground duration-fast mt-4 inline-flex text-sm underline decoration-current/25 underline-offset-4 transition-colors hover:decoration-current"
              >
                {passage.linkLabel} →
              </Link>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
