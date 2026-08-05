'use client';

import { Reveal } from '@/components/home/reveal';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import type { ReactNode } from 'react';
import { faq } from './content';

/**
 * The FAQ — mount between the trust section and the closing CTA. It is the last
 * thing a reader passes before the ask.
 *
 * IT IS AN ACCORDION, AND THAT IS A TRADE. Three of these answers concede
 * something — gates ship off, self-hosting is not air-gapped, and audit export
 * is an entitlement — and collapsing them puts the
 * sentences the section exists to say out loud one click away. That is the
 * accepted cost. It buys the thing that matters more here: expanded by default
 * the section was 1769px of prose sitting directly on top of the CTA, which
 * pushed the ask off the screen and demanded a full read nobody standing at the
 * end of a landing page is going to give. Collapsed it is a six-line list a
 * reader scans in a few seconds and opens exactly once.
 *
 * THE ONE RULE THIS PUTS ON THE COPY. A collapsed answer must never let the
 * section read as if it only says flattering things. Every question stays
 * neutral, so the awkward rows are visibly present in the resting state and a
 * reader hunting for the catch can see which row to open. If a future edit
 * rewrites a question into a claim, the collapse has turned the section into
 * marketing.
 *
 * `type="single" collapsible`, matching the careers board
 * (`features/marketing/careers/careers-page.tsx` → `Board`), which is the
 * signed-off pattern for this on the marketing surface. Single because the whole
 * argument above is about height: with `multiple`, a reader who opens four rows
 * is back at the wall of text the collapse existed to remove, and directly above
 * the CTA that is the one failure mode worth designing against. `collapsible` so
 * the open row closes again and the list returns to its resting state.
 *
 * Radix underneath, so `aria-expanded`, `aria-controls`, roving focus,
 * Enter/Space and arrow-key navigation are the primitive's behaviour, not
 * something re-implemented here.
 *
 * WHY THE ANSWER IS CAPPED AT 36rem. Full-bleed inside a `max-w-7xl` slab the
 * measure runs past 100 characters, well beyond where a reader loses the start
 * of the next line. Capped it sits near 70.
 *
 * WHY IT IS ONE BORDERED SLAB. The rows are a set — the point is partly that
 * there are only six of them and none is missing. Six separate cards would
 * read as six claims; one divided panel reads as a document, which is what an
 * FAQ is. `rounded-sm` and a hairline border, flat: it sits in the page flow, so
 * it gets an edge rather than elevation. The padding lives on the trigger and
 * the content, never on the bordered element, so the row seams run edge to edge.
 *
 * Copy, and the accuracy gate every answer had to pass, live in `content.ts`.
 * Read that file before editing a word here — three of these answers are
 * deliberately unflattering and must stay that way.
 */
export function FaqSection(): ReactNode {
  return (
    <section id="faq" className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      <Reveal>
        <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
          {faq.eyebrow}
        </p>
        <h2 className="text-foreground mt-5 max-w-2xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          {faq.title}
        </h2>
      </Reveal>

      <Reveal delay={0.06}>
        <Accordion
          type="single"
          collapsible
          className="border-border bg-card mt-10 overflow-hidden rounded-sm border"
        >
          {faq.items.map((item, i) => (
            <AccordionItem
              key={item.id}
              value={item.id}
              id={item.id}
              className={i > 0 ? 'border-border border-t' : ''}
            >
              {/* HIT AREA. `py-5` puts the row at 59px measured (1440 and 390
                  alike), clear of the 44px tap-target floor a previous audit
                  found several controls on this site below. The trigger is
                  `flex-1`, so the target is the whole 1234px row rather than the
                  words in it.

                  `hover:no-underline` because the caret is already the
                  affordance and an underline on top of it reads as a link. The
                  row tint is the hover cue instead, and it spans the full width
                  so the target is legible before the pointer reaches the text.
                  `rounded-sm` so the focus ring matches the slab it sits in
                  rather than the primitive's default `rounded-2xl`. */}
              <AccordionTrigger className="hover:bg-primary/[0.04] rounded-sm px-5 py-5 text-left hover:no-underline sm:px-8">
                <span className="text-foreground min-w-0 text-base leading-snug font-medium tracking-tight text-balance">
                  {item.question}
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-5 pb-6 sm:px-8">
                <p className="text-muted-foreground max-w-[36rem] min-w-0 text-base leading-[1.7] text-pretty">
                  {item.answer}
                </p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  );
}
