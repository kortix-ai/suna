'use client';

import { ArrowsClockwiseIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { PINNED_STARTER_PROMPT, STARTER_PROMPTS_BY_ID } from '@/lib/starter-prompts';
import { cn } from '@/lib/utils';
import { useStarterRotationStore } from '@/stores/starter-prompt-rotation-store';
import { chalkColors } from '@kortix/shared';

import {
  BAND_HEADER_CLASS,
  BAND_LIST_CLASS,
  BAND_PANEL_CLASS,
  BAND_ROW_CLASS,
  BAND_ROW_HOVER_CLASS,
  BAND_TITLE_CLASS,
} from './band';

/**
 * Starter prompts, in the setup checklist's slot and wearing its panel.
 *
 * This is what project home shows once the checklist has nothing left to say —
 * dismissed, every step finished, or every step denied by IAM. The two are one
 * object changing its contents, so this reuses the checklist's exact chrome
 * from `./band.ts`: same panel, same header line, same row geometry, same
 * text rail.
 *
 * The one difference is the icon lane. A checklist row draws a pending ring or
 * a filled check there; a starter row draws the PROMPT's own icon, in the
 * hash-derived chalk colour that prompt already carried as a chip. That lane
 * is what tells you which band you are looking at without reading a word of
 * it.
 *
 * It replaces `starter-prompt-chips.tsx`, a centred wrapping row of outline
 * pills that sat under the composer. Pills there and a panel here were two
 * different shapes for the same job in the same column, and the pills had been
 * commented out rather than deleted.
 *
 * Deliberately NOT animated, and that survives the move — see the mount rule
 * in `setup-checklist.tsx`, which gives this band `initial={false}` so it is
 * simply drawn in place. These are part of the hero's first paint on every
 * project open, and motion the reader sits through that often is a delay
 * billed to them for no information gained. The shuffle control below follows
 * the same rule: the rows swap instantly, because you asked them to.
 */
export function StarterPromptBand({
  onPick,
  className,
}: {
  onPick: (text: string) => void;
  className?: string;
}) {
  /*
   * Today's five. The store resolves them at import time on the client
   * (`stores/starter-prompt-rotation-store.ts`), so this selector returns the
   * real set on the first render — no effect, no empty band for a frame.
   *
   * A selector, not `useStore()` whole: the state also carries `refresh`, and
   * subscribing to the whole object would re-render this band on any future
   * field added to it.
   *
   * Empty only on the server, where there is no storage and no local midnight
   * to compute against. The band does not render there anyway — its host gates
   * on `resolved`, which is false until the client has read storage — so the
   * pinned-row-only fallback below is belt and braces rather than a state
   * anyone sees.
   */
  const rotation = useStarterRotationStore((state) => state.ids);
  const reshuffle = useStarterRotationStore((state) => state.reshuffle);

  const rows = [
    PINNED_STARTER_PROMPT,
    ...rotation.flatMap((id) => STARTER_PROMPTS_BY_ID.get(id) ?? []),
  ];

  return (
    <section aria-label="Start with" className={cn(BAND_PANEL_CLASS, className)}>
      <div className={BAND_HEADER_CLASS}>
        {/* No count and no progress bar — there is nothing here to finish —
            and no dismiss control, because this IS the resting state. There is
            nothing to dismiss it to. */}
        <h2 className={BAND_TITLE_CLASS}>Start with</h2>

        {/*
          Shuffle.

          The rotation is designed to be invisible — one set a day, no controls
          — and this does not change that: the daily roll still owns the resting
          behaviour, and this is the escape hatch for the moment a person looks
          at five rows, wants none of them, and would otherwise close the band
          and forget it exists. Six of 186 prompts are on screen; the other 180
          were unreachable until you could ask for them.

          It calls the SAME `pickDay` a real day-roll calls, `recent` included,
          so pressing it repeatedly walks the pool exactly the way consecutive
          days do — and it cannot serve up a prompt from the last ten sets. It
          does not touch the expiry either: shuffling at noon still rolls again
          at midnight, so the daily rhythm survives being interrupted.

          No spinner and no cross-fade on the rows. This is direct manipulation
          — you pressed it, the rows changed — and the changed rows ARE the
          feedback. The press scale is the only motion, and it is the house one.
        */}
        <Hint label="Shuffle" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={reshuffle}
            aria-label="Shuffle the starter prompts"
            className="text-muted-foreground shrink-0 transition-[color,background-color,scale] active:scale-[0.96]"
          >
            <ArrowsClockwiseIcon className="size-3.5" />
          </Button>
        </Hint>
      </div>

      <div className={BAND_LIST_CLASS}>
        {rows.map((prompt, index) => {
          const PromptIcon = prompt.icon;
          const chalk = chalkColors(prompt.label);

          return (
            <button
              key={prompt.id}
              type="button"
              onClick={() => onPick(prompt.prompt)}
              className={cn(
                BAND_ROW_CLASS,
                BAND_ROW_HOVER_CLASS,
                'w-full cursor-pointer text-left',
                // Press feedback. The row had a hover and no `:active`, so the
                // click that fills the composer landed with no acknowledgement
                // from the thing that was clicked — the only visible response
                // was text appearing somewhere else on the page.
                //
                // `0.98`, not the house `0.96`: this is a full-width row, and
                // 4% on ~700px walks the right edge in by ~14px, which reads as
                // a lurch rather than a press. 2% is ~7px and still legible.
                // `scale` is named in the transition list because Tailwind v4's
                // `scale-*` sets the standalone `scale` property, which
                // `transition-colors` does not cover.
                'transition-[color,background-color,scale] active:scale-[0.98]',
                'motion-reduce:transition-none motion-reduce:active:scale-100',
                // Four rows on a phone, six from `sm:` up — the same cut the
                // pills made. Six rows is ~190px, and this band renders inside
                // a column centred in the TOP HALF of the surface
                // (`welcome-body.tsx`), so on a short viewport the last two
                // would push the composer's ballast to nothing for prompts
                // that are the least likely to be picked anyway.
                index >= 4 && 'max-sm:hidden',
              )}
            >
              {/* `size-4.5`, the checklist indicator's exact box, so the label
                  rail is shared between the two bands. The colour is the
                  prompt's own chalk hue — an inline style because it is
                  derived from the label at runtime, the same way
                  `EntityAvatar` tints a tile it hashed. */}
              <PromptIcon
                aria-hidden
                className="size-4.5 shrink-0"
                style={{ color: chalk.foreground }}
              />
              <span className="font-kerning-normal text-foreground min-w-0 flex-1 truncate text-sm">
                {prompt.label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
