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
 * The hover/keyboard-active background rotates through six low-chroma tints,
 * offset by three positions on alternating rows. Six rather than three:
 * frimousse lays out 10 columns, and a 3-tint rotation over 10 columns lines
 * the same tint up vertically every other row, which the row offset only half
 * breaks up. Six tints move the repeat to every 30 cells.
 *
 * The tints are HSL in the same register as `chalkColors`
 * (packages/shared/src/utils/chalk-colors.ts) rather than Tailwind's red-100 /
 * green-100 / blue-100 from the frimousse docs: those wash out to invisible on
 * a dark background, and read as foreign next to the rest of apps/web.
 */

/**
 * Every variant is written out as a LITERAL string. Do not generate these with
 * a template literal or a .map() — Tailwind v4 extracts class names by scanning
 * source text, so an interpolated class name produces no CSS at all and the
 * hover backgrounds silently never appear.
 *
 * `data-row=even` rows (the first, third, … logical row) run the six tints in
 * column order. `data-row=odd` rows start three along, so a tint never sits
 * directly above itself.
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
  'transition-[background-color,scale] duration-100 active:scale-[0.96]',

  // Even rows: 1→red, 2→amber, 3→green, 4→teal, 5→blue, 6→violet
  'group-data-[row=even]/row:nth-[6n+1]:data-[active]:bg-[hsl(4_46%_88%)]',
  'group-data-[row=even]/row:nth-[6n+2]:data-[active]:bg-[hsl(32_52%_87%)]',
  'group-data-[row=even]/row:nth-[6n+3]:data-[active]:bg-[hsl(96_34%_87%)]',
  'group-data-[row=even]/row:nth-[6n+4]:data-[active]:bg-[hsl(178_36%_86%)]',
  'group-data-[row=even]/row:nth-[6n+5]:data-[active]:bg-[hsl(212_46%_88%)]',
  'group-data-[row=even]/row:nth-[6n+6]:data-[active]:bg-[hsl(280_32%_88%)]',

  // Odd rows: same six, rotated by three
  'group-data-[row=odd]/row:nth-[6n+1]:data-[active]:bg-[hsl(178_36%_86%)]',
  'group-data-[row=odd]/row:nth-[6n+2]:data-[active]:bg-[hsl(212_46%_88%)]',
  'group-data-[row=odd]/row:nth-[6n+3]:data-[active]:bg-[hsl(280_32%_88%)]',
  'group-data-[row=odd]/row:nth-[6n+4]:data-[active]:bg-[hsl(4_46%_88%)]',
  'group-data-[row=odd]/row:nth-[6n+5]:data-[active]:bg-[hsl(32_52%_87%)]',
  'group-data-[row=odd]/row:nth-[6n+6]:data-[active]:bg-[hsl(96_34%_87%)]',

  // Dark mode: same rotation, low-lightness variants
  'dark:group-data-[row=even]/row:nth-[6n+1]:data-[active]:bg-[hsl(4_28%_26%)]',
  'dark:group-data-[row=even]/row:nth-[6n+2]:data-[active]:bg-[hsl(32_30%_25%)]',
  'dark:group-data-[row=even]/row:nth-[6n+3]:data-[active]:bg-[hsl(96_22%_24%)]',
  'dark:group-data-[row=even]/row:nth-[6n+4]:data-[active]:bg-[hsl(178_26%_24%)]',
  'dark:group-data-[row=even]/row:nth-[6n+5]:data-[active]:bg-[hsl(212_30%_27%)]',
  'dark:group-data-[row=even]/row:nth-[6n+6]:data-[active]:bg-[hsl(280_22%_27%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+1]:data-[active]:bg-[hsl(178_26%_24%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+2]:data-[active]:bg-[hsl(212_30%_27%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+3]:data-[active]:bg-[hsl(280_22%_27%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+4]:data-[active]:bg-[hsl(4_28%_26%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+5]:data-[active]:bg-[hsl(32_30%_25%)]',
  'dark:group-data-[row=odd]/row:nth-[6n+6]:data-[active]:bg-[hsl(96_22%_24%)]',
);

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
      className={cn('isolate flex h-[368px] w-full flex-col', className)}
    >
      <div className="p-2">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <Frimousse.Search
            placeholder="Search emoji"
            className={cn(
              'border-border bg-popover text-foreground placeholder:text-muted-foreground/60',
              'h-9 w-full rounded-md border pr-3 pl-9 text-sm font-medium transition-[color] outline-none',
              'focus:border-kortix-blue focus:border focus:outline-none',
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
          className="pb-1.5 select-none"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className="bg-popover text-muted-foreground px-2 pt-3 pb-1.5 text-xs font-medium"
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div
                className="group/row flex px-1.5"
                data-row={Number(props['aria-rowindex'] ?? 0) % 2 === 0 ? 'even' : 'odd'}
                {...props}
              >
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button type="button" className={EMOJI_BUTTON} {...props}>
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
