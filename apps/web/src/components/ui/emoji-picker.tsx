'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { EmojiPicker as Frimousse } from 'frimousse';

import Hint from '@/components/ui/hint';
import { InputGroupSearch, InputGroupSearchIcon } from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';

export interface EmojiSelection {
  emoji: string;
  label: string;
}

/**
 * Emoji picker built on frimousse.
 *
 * The hovered/keyboard-active cell takes one of six tints, rotated by three on
 * alternating rows so a tint never sits directly above itself. Rotation by
 * three within a six-cycle guarantees that for ANY column count — frimousse
 * defaults to 9 columns (its own JSDoc says 10, but the shipped default is
 * `columns = 9`, and we pass no override), and the guarantee does not depend on
 * that number. The repeating tile is 6 x 2 = 12 cells: the tint is a pure
 * function of (nth-child mod 6, row parity).
 *
 * Colours come from two paired token families in globals.css: a pale
 * `--color-emoji-fill-*` and a stronger `--color-emoji-ring-*` per hue. The
 * active cell is the ONLY visible cue for which emoji is selected — frimousse
 * gives every emoji button tabIndex={-1} and no focus ring — so the state
 * indicator has to clear WCAG 1.4.11's 3:1 against --popover. A pale fill
 * cannot reach that on white at any saturation, so the 1px inset ring carries
 * the contrast (measured 3.03–3.19:1) and the fill stays quiet.
 */

/**
 * Every variant is written out as a LITERAL string. Do not generate these with
 * a template literal or a .map() — Tailwind v4 extracts class names by scanning
 * source text, so an interpolated class name produces no CSS at all and the
 * hover backgrounds silently never appear.
 *
 * There is no `dark:` set: every token is a light-dark() pair, and :root /
 * .dark set color-scheme, so one class covers both themes.
 *
 * The ring GEOMETRY is declared once, as a single `data-[active]:inset-ring-1`
 * — only the colour is slot-specific. Repeating the width on all twelve slots
 * would be twelve chances for one to drift.
 *
 * VARIANT ORDER: `data-[active]` LAST, i.e.
 * `group-data-[row=even]/row:nth-[6n+1]:data-[active]:bg-…`. Verified against
 * tailwindcss 4.3.2, which compiles that to
 * `:is(:where(.group\/row)[data-row="even"] *):nth-child(6n+1)[data-active]`.
 * Leading with `data-[active]` also compiles to a working selector, so either
 * order emits CSS — this one just reads in the order the cascade applies.
 *
 * `nth-[6n+k]` counts the emoji button among its row's children, which is
 * exactly the column: frimousse renders nothing into a row but emoji buttons.
 *
 * WHY `data-row` AND NOT `group-odd/row:` / `group-even/row:` (the obvious
 * CSS-only choice): frimousse virtualises the list, so a row's `:nth-child()`
 * index counts only the rows currently mounted, offset by a hidden measurement
 * <div> that is always the first child and by a spacer <div> inserted before
 * every row that starts a category. `:nth-child(odd)` on a row therefore tracks
 * neither the logical row nor any stable value — it flips as you scroll.
 * `aria-rowindex`, which frimousse derives from the logical row index, is the
 * one stable source, so `<Row>` reads it and stamps the parity as an attribute.
 */
const EMOJI_BUTTON = cn(
  'flex size-8 items-center justify-center rounded-md text-lg leading-none',
  'cursor-pointer select-none',
  // `scale` not `transform`: Tailwind v4's scale-* utility sets the standalone
  // `scale` property, which `transition-property: transform` does not cover.
  // box-shadow is in the list because Tailwind draws inset-ring-* with it.
  'transition-[background-color,box-shadow,scale] duration-100 active:scale-[0.96]',

  // Ring geometry, declared once. Only the colour varies per slot below.
  'data-[active]:inset-ring-1',

  // Fill — even rows: 1→red, 2→amber, 3→green, 4→teal, 5→blue, 6→violet
  'group-data-[row=even]/row:nth-[6n+1]:data-[active]:bg-emoji-fill-red',
  'group-data-[row=even]/row:nth-[6n+2]:data-[active]:bg-emoji-fill-amber',
  'group-data-[row=even]/row:nth-[6n+3]:data-[active]:bg-emoji-fill-green',
  'group-data-[row=even]/row:nth-[6n+4]:data-[active]:bg-emoji-fill-teal',
  'group-data-[row=even]/row:nth-[6n+5]:data-[active]:bg-emoji-fill-blue',
  'group-data-[row=even]/row:nth-[6n+6]:data-[active]:bg-emoji-fill-violet',

  // Fill — odd rows: same six, rotated by three
  'group-data-[row=odd]/row:nth-[6n+1]:data-[active]:bg-emoji-fill-teal',
  'group-data-[row=odd]/row:nth-[6n+2]:data-[active]:bg-emoji-fill-blue',
  'group-data-[row=odd]/row:nth-[6n+3]:data-[active]:bg-emoji-fill-violet',
  'group-data-[row=odd]/row:nth-[6n+4]:data-[active]:bg-emoji-fill-red',
  'group-data-[row=odd]/row:nth-[6n+5]:data-[active]:bg-emoji-fill-amber',
  'group-data-[row=odd]/row:nth-[6n+6]:data-[active]:bg-emoji-fill-green',

  // Ring colour — same rotation, paired with the fill by hue
  'group-data-[row=even]/row:nth-[6n+1]:data-[active]:inset-ring-emoji-ring-red',
  'group-data-[row=even]/row:nth-[6n+2]:data-[active]:inset-ring-emoji-ring-amber',
  'group-data-[row=even]/row:nth-[6n+3]:data-[active]:inset-ring-emoji-ring-green',
  'group-data-[row=even]/row:nth-[6n+4]:data-[active]:inset-ring-emoji-ring-teal',
  'group-data-[row=even]/row:nth-[6n+5]:data-[active]:inset-ring-emoji-ring-blue',
  'group-data-[row=even]/row:nth-[6n+6]:data-[active]:inset-ring-emoji-ring-violet',
  'group-data-[row=odd]/row:nth-[6n+1]:data-[active]:inset-ring-emoji-ring-teal',
  'group-data-[row=odd]/row:nth-[6n+2]:data-[active]:inset-ring-emoji-ring-blue',
  'group-data-[row=odd]/row:nth-[6n+3]:data-[active]:inset-ring-emoji-ring-violet',
  'group-data-[row=odd]/row:nth-[6n+4]:data-[active]:inset-ring-emoji-ring-red',
  'group-data-[row=odd]/row:nth-[6n+5]:data-[active]:inset-ring-emoji-ring-amber',
  'group-data-[row=odd]/row:nth-[6n+6]:data-[active]:inset-ring-emoji-ring-green',
);

let warnedMissingRowIndex = false;

/**
 * Row parity, from frimousse's `aria-rowindex`.
 *
 * The fallback is deliberately noisy rather than silent: if frimousse ever
 * stopped emitting `aria-rowindex`, every row would fall back to `even`, the
 * rotation would collapse to a single set, and nothing would fail. The hidden
 * measurement row legitimately has neither `role` nor `aria-rowindex`, so only
 * a real row (`role="row"`) missing the index is a regression worth warning on.
 *
 * Note frimousse's `aria-rowindex` is 0-based, which is against ARIA's 1-based
 * convention. This code is correct against what it ships today; if frimousse
 * ever conforms, every parity flips and the rotation shifts by three.
 */
function rowParity(props: { role?: string; 'aria-rowindex'?: number }): 'even' | 'odd' {
  const rowIndex = props['aria-rowindex'];

  if (typeof rowIndex !== 'number') {
    if (process.env.NODE_ENV !== 'production' && props.role === 'row' && !warnedMissingRowIndex) {
      warnedMissingRowIndex = true;
      console.warn(
        '[EmojiPicker] a frimousse row is missing aria-rowindex; the active-cell ' +
          'tint rotation has collapsed to one set. Check the frimousse version.',
      );
    }
    return 'even';
  }

  return rowIndex % 2 === 0 ? 'even' : 'odd';
}

export function EmojiPicker({
  onEmojiSelect,
  className,
}: {
  onEmojiSelect: (emoji: EmojiSelection) => void;
  className?: string;
}) {
  return (
    <Frimousse.Root
      onEmojiSelect={onEmojiSelect}
      // Self-hosted, not frimousse's default CDN. Left unset, frimousse fetches
      // the emojibase dataset from `https://cdn.jsdelivr.net/npm/emojibase-data`
      // in the user's browser the first time the picker opens — the only
      // external runtime CDN this app would have. dosco ships self-hosted, so
      // that is wrong here regardless; what makes it a defect is that it fails
      // INVISIBLY. frimousse exposes `Loading` and `Empty` and no error slot,
      // and its cold-cache path is a bare `await` (only the etag-revalidation
      // branch catches), so an unreachable CDN leaves the popover on `Loading`
      // forever with no message. Air-gapped installs, restricted networks and
      // any future `connect-src` CSP all land there.
      //
      // frimousse appends `${locale}/data.json` and `${locale}/messages.json`
      // to this. Both are copied into `public/emojibase/en/` at dev/build time
      // by scripts/emojibase-data.mjs — one locale, ~782 KB on disk / ~94 KB
      // gzipped, fetched on first open and never part of the JS bundle.
      //
      // These two literals are the same values the copy script spells out, and
      // nothing but src/components/ui/emoji-picker-data.test.ts ties them
      // together: a build script cannot import a client component's constants.
      // `locale` is written out rather than left to frimousse's `en` default so
      // the coupling is visible at the place someone would change it.
      emojibaseUrl="/emojibase"
      locale="en"
      className={cn('isolate flex h-[368px] w-full flex-col', className)}
    >
      <div className="p-1">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <Frimousse.Search
            aria-label="Search emoji"
            placeholder="Search emoji"
            className={cn(
              'border-border bg-popover text-foreground placeholder:text-muted-foreground/60',
              'h-9 w-full rounded-md border pr-3 pl-9 text-sm font-medium transition-[color] outline-none',
              'focus:border-kortix-blue focus:border focus:outline-none',
              // frimousse hardcodes type="search". Tailwind's preflight resets
              // ::-webkit-search-decoration but not ::-webkit-search-cancel-button,
              // so without this WebKit paints its native clear X inside the field.
              // Same reset input.tsx already carries for type="search".
              '[&::-webkit-search-cancel-button]:appearance-none',
            )}
          />
        </InputGroupSearch>
      </div>

      <Frimousse.Viewport className="relative flex-1 overflow-y-auto outline-none">
        <Frimousse.Loading className="text-muted-foreground absolute inset-0 flex items-center justify-center">
          <Loading />
        </Frimousse.Loading>

        <Frimousse.Empty className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-balance">
          {({ search }) => <>No emoji for &ldquo;{search}&rdquo;</>}
        </Frimousse.Empty>

        <Frimousse.List
          aria-label="Emoji"
          className="pb-1.5 select-none"
          components={{
            // In each of these, `className` comes AFTER `{...props}` and merges
            // `props.className`. All three prop types extend ComponentProps, so
            // className is in the type; frimousse does not pass one today, but
            // if it ever did, a className before the spread would be replaced
            // outright and the whole tint system would go dead silently.
            CategoryHeader: ({ category, ...props }) => (
              <div
                {...props}
                className={cn(
                  'bg-popover text-muted-foreground px-2 pt-3 pb-1.5 text-xs font-medium',
                  props.className,
                )}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div
                {...props}
                data-row={rowParity(props)}
                className={cn('group/row flex px-1.5', props.className)}
              >
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button type="button" {...props} className={cn(EMOJI_BUTTON, props.className)}>
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </Frimousse.Viewport>

      <div className="border-border/60 flex h-11 items-center gap-2 border-t px-2">
        <Frimousse.ActiveEmoji>
          {({ emoji }) =>
            emoji ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-lg leading-none">{emoji.emoji}</span>
                <span className="text-muted-foreground truncate text-xs">{emoji.label}</span>
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">Pick an emoji</span>
            )
          }
        </Frimousse.ActiveEmoji>
        <Hint label="Change skin tone" side="top">
          <Frimousse.SkinToneSelector className="hover:bg-muted ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-base transition-[background-color,scale] duration-100 active:scale-[0.96]" />
        </Hint>
      </div>
    </Frimousse.Root>
  );
}
