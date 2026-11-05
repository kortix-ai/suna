'use client';

import { EmojiPicker as Frimousse } from 'frimousse';

import Hint from './hint';
import Loading from './loading';
import { cn } from '../lib/utils';

export interface EmojiSelection {
  emoji: string;
  label: string;
}

/**
 * Emoji picker built on frimousse: 12 columns of `size-8` cells at `text-xl`
 * (20px), so about 80 emoji show at once inside the 388px panel.
 *
 * The hovered or keyboard-active cell takes a neutral wash
 * (`bg-foreground/8`). It replaced a six-hue tinted fill with a 1px ring: the
 * new picker draws no borders on cells. The wash is the only cue for the
 * keyboard-active emoji, and it is below WCAG 1.4.11's 3:1, which the old ring
 * cleared.
 */
const EMOJI_BUTTON = cn(
  'flex size-8 items-center justify-center rounded-md text-xl leading-none',
  'cursor-pointer select-none',
  'transition-[background-color,scale] duration-fast active:scale-[0.96]',
  'data-[active]:bg-foreground/8',
);

/** 12 columns of size-8 cells: 20px emoji, about 80 visible at once. */
const EMOJI_COLUMNS = 12;

export function EmojiPicker({
  onEmojiSelect,
  className,
  emojibaseUrl = '/emojibase',
}: {
  onEmojiSelect: (emoji: EmojiSelection) => void;
  className?: string;
  /**
   * Root-relative URL that serves `en/data.json` and `en/messages.json` from
   * `emojibase-data`. apps/web copies them to `public/emojibase/`. A host that
   * serves them elsewhere passes its own path; a host that serves nothing gets
   * a picker that stays on its loading state (frimousse has no error slot).
   */
  emojibaseUrl?: string;
}) {
  return (
    <Frimousse.Root
      onEmojiSelect={onEmojiSelect}
      // Self-hosted, not frimousse's default CDN. Left unset, frimousse fetches
      // the emojibase dataset from `https://cdn.jsdelivr.net/npm/emojibase-data`
      // in the user's browser the first time the picker opens — the only
      // external runtime CDN this app would have. Kortix ships self-hosted, so
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
      // nothing but apps/web/src/components/ui/emoji-picker-data.test.ts ties them
      // together: a build script cannot import a client component's constants.
      // `locale` is written out rather than left to frimousse's `en` default so
      // the coupling is visible at the place someone would change it.
      emojibaseUrl={emojibaseUrl}
      locale="en"
      columns={EMOJI_COLUMNS}
      className={cn('isolate flex h-[388px] w-full flex-col', className)}
    >
      <div className="border-border flex h-11 shrink-0 items-center border-b px-4">
        <Frimousse.Search
          aria-label="Search emoji"
          placeholder="Search emoji…"
          className={cn(
            'text-foreground placeholder:text-muted-foreground/70 h-full w-full bg-transparent text-sm outline-none',
            '[&::-webkit-search-cancel-button]:appearance-none',
          )}
        />
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
                  'bg-popover text-muted-foreground px-4 pt-3 pb-1.5 text-xs font-medium',
                  props.className,
                )}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div {...props} className={cn('flex px-3', props.className)}>
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

      <div className="border-border flex h-11 shrink-0 items-center gap-2 border-t px-4">
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
          <Frimousse.SkinToneSelector className="hover:bg-muted ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-base transition-[background-color,scale] duration-fast active:scale-[0.96]" />
        </Hint>
      </div>
    </Frimousse.Root>
  );
}
