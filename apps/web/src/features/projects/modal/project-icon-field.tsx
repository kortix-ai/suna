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
  /** `null` renders the unset face. The field can DISPLAY "no icon". */
  value: string | null;
  /**
   * ...but it can never PRODUCE one, so the setter is narrower than the getter.
   * The only call site is the picker's `onEmojiSelect`, which always has an
   * emoji. Nothing here clears: the trigger stays live so you reopen and switch,
   * and resetting to `null` on close is the modal's own state, not this field's.
   * Declaring `string | null` here would be a promise this component never keeps.
   */
  onChange: (icon: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  // Adjusting state during render: React's documented alternative to an effect
  // for "reset state when a prop changes". Radix drives `open` through
  // useControllableState, where a CONTROLLED prop that changes value on
  // re-render is simply recomputed and fires nothing — onOpenChange only runs
  // from setValue. So the `open && !disabled` guard below would close the
  // popover when `disabled` goes true without ever telling us, leaving local
  // `open` stuck at true; the next time `disabled` went false the guard would
  // re-evaluate to true and the picker would reopen with no user action. Task 7
  // wires `disabled={submitting}`, and a failed create flips that back.
  if (disabled && open) setOpen(false);

  return (
    // The guard is belt-and-braces on top of the reset above: `disabled` on the
    // Button already stops a click reaching us (a disabled button fires none,
    // and button.tsx adds disabled:pointer-events-none).
    //
    // `modal` is what makes the picker scrollable with a wheel or trackpad.
    // This field renders inside the create-project Modal, which is a Radix
    // Dialog, and Radix wraps the dialog's OVERLAY in react-remove-scroll with
    // `shards: [contentRef]` (react-dialog dist/index.mjs:110). That side-car
    // installs a non-passive `wheel` listener on `document` and calls
    // preventDefault() on every wheel whose target is neither inside the
    // overlay's React subtree nor inside the content shard. A popover portals
    // to document.body, so it is in neither: the picker's own overflow-y-auto
    // viewport never received the scroll. Dragging its scrollbar still worked,
    // which is what made the bug read as "only the scrollbar responds" — a
    // scrollbar drag is a pointer gesture, not a wheel event.
    //
    // `modal` makes Radix wrap THIS popover's content in its own RemoveScroll
    // (react-popover dist/index.mjs:134). react-remove-scroll keeps one
    // module-level `lockStack`, and its `shouldPrevent` returns early for any
    // lock that is not the last one pushed — so while the picker is open the
    // dialog's lock stands down and the picker's own lock takes over, with the
    // popover content as its container. Its boundary logic then walks into the
    // emoji viewport, finds scroll left to give, and lets the wheel through.
    //
    // Rejected alternative: portalling the popover into the dialog's content
    // element (PopoverContent already accepts `container`). ModalContent is
    // `overflow-y-auto` — and because neither axis is `visible`, that clips
    // BOTH — with `translate: -50% -50%` making it the containing block for
    // fixed descendants. Measured in Chromium at 1440x900: the popover is
    // 370px tall against a 253px content box, so portalling inside severed
    // 240.31px of the picker, including the point the wheel was aimed at.
    // `modal` leaves the popover's geometry byte-identical to before.
    <Popover open={open && !disabled} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          // The field renders inside the create modal's <form>. Without this a
          // click would submit it.
          type="button"
          // `outline`, not `secondary-outline`: the design system prescribes
          // outline for an icon-only button, and secondary-outline's
          // hover:bg-secondary is identical to its resting bg-secondary
          // (button.tsx:27), so the trigger gave no hover feedback at all.
          variant="outline"
          size="icon"
          // Never conditioned on `value`. The whole point of the control is
          // that it stays live after a pick, so you reopen it and switch.
          disabled={disabled}
          aria-label={value ? `Project icon: ${value}. Change it` : 'Choose project icon'}
          // size-9 matches the sibling name Input (`size="sm"` => h-9), which is
          // what the field has to line up with. That is 33.11px, under the 40px
          // a pointer target wants, so hit-area-1 pads the target out to 40.47
          // without moving anything: the gap to the input is 7.36px, so the two
          // targets still do not touch.
          //
          // The transition list replaces Button's base `transition-all`
          // (button.tsx:8), which both the Kortix polish rules and the animation
          // doctrine call a defect — without this, active:scale-[0.96] animates
          // on `transition: all`. The primitive is shared, so it is overridden
          // here rather than changed. `scale`, not `transform`: Tailwind v4's
          // scale-* utility sets the standalone `scale` property, which
          // `transition-property: transform` does not cover.
          className="hit-area-1 size-9 shrink-0 transition-[color,background-color,scale] duration-150 active:scale-[0.96]"
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

        This is a TRADEOFF, not a clean win. It is chosen for the
        overlay-scrollbar case, which is what this app is otherwise built
        against. A frimousse row is a bare flex line with no justification, and
        its `size-8` cells keep the default `flex-shrink: 1`:

        - Overlay scrollbars (macOS default; every measurement below). The 292px
          this file was first written with left 14.03px of surplus on the right
          of every row — the grid's right edge 12.19px short of the search
          field's while its left edge sat 1.84px outside it. At this width the
          surplus is 0.03px and the cells are square.
        - Classic scrollbars (Windows, Linux, macOS "Show scroll bars: Always").
          The viewport loses ~15px. At 292px the surplus absorbs almost all of
          it and each cell gives up ~0.11px, staying square. Here there is no
          surplus, so the whole ~15px comes out of the nine cells — ~1.67px
          each, and they visibly stop being square. This width is WORSE there.
          Not verified on such a platform; the real fix belongs in the picker,
          which owns the scrolling viewport, and is deliberately not made here.

        Beware: putting `scrollbar-gutter: stable` on that viewport would
        reserve the gutter on EVERY platform, so at this width the cells would
        squash everywhere. The geometry tests read column count, cell size and
        row padding from source — none of those change, so they would not catch
        it.

        `w-fit` lands on the same number today and was rejected: it makes the
        popover's geometry an emergent property of everything inside the picker,
        including the `truncate`d active-emoji label in its footer, whose
        intrinsic width is the full untruncated string.

        p-0 because the picker owns its own padding (p-2 search, px-1.5 rows,
        px-2 footer); PopoverContent's default p-4 would inset it a second time.

        Radix gives the content role="dialog"; without a label it is announced
        as an unnamed one.
      */}
      <PopoverContent
        align="start"
        aria-label="Choose project icon"
        className="w-[calc(75*var(--spacing)+2px)] overflow-hidden p-0"
      >
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
