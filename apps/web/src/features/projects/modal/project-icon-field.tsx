'use client';

import { SmileyIcon } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** The codebase's icon-swap treatment: scale + opacity + blur, on a spring with
 *  no bounce. See components/markdown/copy-button.tsx. */
const SWAP = {
  initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' },
  animate: { scale: 1, opacity: 1, filter: 'blur(0px)' },
  exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' },
} as const;

/**
 * Reduced motion keeps the cross-fade — it is what says the face changed — and
 * leaves out the scale and the blur, which are the parts that actually move.
 * motion/react does not do this on its own; without the branch the spring runs
 * at full strength under `prefers-reduced-motion: reduce`.
 *
 * It is built FROM `SWAP.animate` rather than written out, so the resting state
 * is byte-identical to the full variant's. The server cannot know the user's
 * preference, so it always renders the full variant's resting style; a
 * hand-written `{ opacity: 1 }` here made the client hydrate `opacity: 1` where
 * the server had written `opacity: 1; filter: blur(0px); transform: none`, and
 * React reported a hydration mismatch it explicitly would not patch up.
 * Only `opacity` differs from rest, so only `opacity` animates.
 */
const SWAP_REDUCED = {
  initial: { ...SWAP.animate, opacity: 0 },
  animate: SWAP.animate,
  exit: { ...SWAP.animate, opacity: 0 },
} as const;

/** Emoji trigger for the create-project modal. Sits beside the name input and
 *  opens the picker in a popover. Controlled: the modal owns the icon so it can
 *  send it with the create payload and clear it on close. */
export function ProjectIconField({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (icon: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  return (
    // `open && !disabled` so a field disabled while its popover is open — the
    // modal disables the row on submit — takes the popover down with it.
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          // The field renders inside the create modal's <form>. Without this a
          // click would submit it.
          type="button"
          variant="secondary-outline"
          size="icon"
          disabled={disabled}
          aria-label={value ? `Project icon: ${value}. Change it` : 'Choose project icon'}
          // size-9 matches the sibling name Input (`size="sm"` => h-9), which is
          // what the field has to line up with. That is 33.11px, under the 40px
          // a pointer target wants, so hit-area-1 pads the target out to 40.47
          // without moving anything: the gap to the input is 7.36px, so the two
          // targets still do not touch.
          className="hit-area-1 size-9 shrink-0 active:scale-[0.96]"
        >
          {/* Both faces share one fixed box and cross-fade in place. Picking an
              emoji closes the popover, so the eye is already on the trigger
              when it changes — a hard swap reads as two objects blinking.
              `initial={false}` keeps a field that mounts with a value from
              animating on first paint.

              size-6 (22.07px), not size-5: a text-lg emoji measures 21px wide,
              so a size-5 box left it hanging 2.61px out of the shared box. */}
          <span className="relative inline-flex size-6 items-center justify-center">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={value ?? 'unset'}
                {...(reduceMotion ? SWAP_REDUCED : SWAP)}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {value ? (
                  // Named by the button's aria-label, so the glyph itself stays
                  // out of the accessibility tree.
                  <span aria-hidden className="text-lg leading-none">
                    {value}
                  </span>
                ) : (
                  <SmileyIcon className="text-muted-foreground size-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
        </Button>
      </PopoverTrigger>
      {/*
        The width is the emoji grid's exact width, not a round number.
        `EmojiPicker` lays out 9 columns (frimousse 0.3.0's `columns` default;
        the picker passes no override) of `size-8` cells in a row padded
        `px-1.5` — in Tailwind `--spacing` units, 9*8 + 2*1.5 = 75. The `+2px`
        covers the 1px border per side, because PopoverContent is `border-box`.

        Exact rather than generous: a frimousse row is a bare flex line with no
        justification, so every surplus pixel becomes dead space on the RIGHT of
        every row and the grid stops lining up with the full-width search field
        above it. Measured in Chromium at the 292px this file was first written
        with: 14.03px of surplus per row, the grid's right edge 12.19px short of
        the search field's while its left edge sat 1.84px outside it. Here the
        surplus is 0.03px.

        `w-fit` lands on the same number today and was rejected: it makes the
        popover's geometry an emergent property of everything inside the picker,
        including the `truncate`d active-emoji label in its footer, whose
        intrinsic width is the full untruncated string.

        p-0 because the picker owns its own padding (p-2 search, px-1.5 rows,
        px-2 footer); PopoverContent's default p-4 would inset it a second time.
      */}
      <PopoverContent align="start" className="w-[calc(75*var(--spacing)+2px)] overflow-hidden p-0">
        <EmojiPicker
          onEmojiSelect={(emoji) => {
            onChange(emoji.emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
