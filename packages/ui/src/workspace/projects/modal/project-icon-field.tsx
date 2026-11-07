'use client';

import { useTranslations } from '../../../i18n';
import { SmileyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useState } from 'react';

import { Button } from '../../../primitives/button';
import { emojiTint, emojiTintHover } from '../../../primitives/emoji-tint';
import { EntityAvatar } from '../../../primitives/entity-avatar';
import type { GlyphSelection } from '../../../primitives/glyph-picker';
import { glyphFace as glyphDrawing } from '../../../primitives/glyph-face';
import { glyphForeground, glyphStyle, glyphTint, glyphTintHover } from '../../../primitives/glyph-tint';
import { FULL_BLEED_BORDER, useFullBleedGlyph } from '../../../primitives/kortix-glyphs';
import { Popover, PopoverContent, PopoverTrigger } from '../../../primitives/popover';
import { preloadProjectIconPicker, ProjectIconPicker } from '../../../primitives/project-icon-picker';
import { cn } from '../../../internal/lib/utils';

/** The codebase's icon-swap treatment: scale + opacity + blur, on a spring with
 *  no bounce. See packages/ui/src/markdown/copy-button.tsx. */
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

/**
 * What this field controls. A UNION, not two independently-nullable slots —
 * `{ emoji }` XOR `{ glyph }` XOR neither. The server deletes whichever of
 * `icon` / `icon_glyph` was NOT just written, so modelling the value as one
 * field rather than two is what makes it impossible for a host to construct a
 * state (and therefore a request) that sets both, or that clears one without
 * the other reflecting it. `NewWorkspacePage` (`/workspaces/new`, create) and
 * `GeneralProjectCard` (workspace Settings, edit — `settings-view.tsx`) hold
 * exactly this type as their icon state and pass it straight through.
 */
export type ProjectIconValue = { emoji: string } | { glyph: GlyphSelection } | null;

/**
 * Resolves a glyph selection to the component that actually draws it, along
 * with the bits the trigger needs to paint it — or `null` if the name isn't
 * in the registry (stale cached data: a project's `icon_glyph.name` outlived
 * a catalogue that shrank). One helper shared by every place below that asks
 * "is there a renderable glyph?", so a name that fails to resolve falls
 * through to the unset face identically everywhere instead of drifting.
 */
function resolveGlyphFace(glyph: GlyphSelection | null) {
  if (!glyph) return null;
  const GlyphComponent = glyphDrawing(glyph.name);
  return GlyphComponent ? { GlyphComponent, name: glyph.name, color: glyph.color } : null;
}

/** Icon trigger for `/workspaces/new`'s create form and workspace Settings' edit
 *  section. Sits beside the name input and opens the Emoji/Icon picker in a
 *  popover. Controlled: the host owns the icon so it can send it with its
 *  payload (create) or diff it against the stored project (edit), and reset
 *  it on close/cancel. */
export function ProjectIconField({
  value,
  onChange,
  onGlyphChange,
  onClear,
  disabled,
  triggerClassName,
  fallbackLabel,
  align = 'start',
}: {
  /**
   * Sizing override for the trigger. `/workspaces/new` renders this as the page's own
   * `size-12` subject above the name field; everywhere else it sits inline
   * beside a `size="sm"` input and keeps the `size-9` default that matches it.
   */
  triggerClassName?: string;
  /**
   * What the unset face shows instead of the generic smiley: the workspace's
   * own initial, through `EntityAvatar`, chalk colour and all — the same tile
   * the switcher and the project cards draw.
   *
   * A smiley says "pick something". An initial says "this is what it will look
   * like if you pick nothing", which is true and is what a default should
   * communicate. Blank or absent falls back to the smiley, since an initial
   * derived from an empty name is just "?".
   */
  fallbackLabel?: string;
  /**
   * Where the picker hangs relative to the trigger. Defaults to `start` —
   * `/workspaces/new` and the create modal put the trigger on the leading edge of its
   * row, so `center`/`end` would push a ~278px popover past the edge.
   * Settings' Icon row passes `end` because the control sits on the trailing
   * side of a `SettingsRow`.
   */
  align?: 'start' | 'center' | 'end';
  /** `null` renders the unset face. The field can DISPLAY "no icon". */
  value: ProjectIconValue;
  /**
   * ...and neither setter can PRODUCE the unset state or the other setter's
   * shape — see `onClear` for removal. `onChange`'s only call site is the
   * picker's `onEmojiSelect`, which always has an emoji; `onGlyphChange`'s is
   * `onGlyphSelect`, which always has a glyph. Two narrow setters, not one
   * `(value: ProjectIconValue) => void`, because a single wide callback would
   * overload one signature with three different events — "picked an emoji",
   * "picked a glyph", "removed it" — and force every host to re-derive which
   * one happened from the argument. Removing gets its own name: `onClear`.
   */
  onChange: (icon: string) => void;
  onGlyphChange: (glyph: GlyphSelection) => void;
  /**
   * Remove the icon. OPTIONAL, and its presence is what decides whether the
   * field offers a remove control at all — so "can this field clear?" is a host
   * decision expressed in the type, not a runtime flag.
   *
   * `/workspaces/new` deliberately does not pass it: there is nothing saved to undo
   * there, and the trigger already stays live so you reopen it and switch.
   * Workspace Settings does, because an existing project's icon IS saved, and
   * without this there would be no way to ever take one back off.
   */
  onClear?: () => void;
  disabled?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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

  const emoji = value && 'emoji' in value ? value.emoji : null;
  const glyph = value && 'glyph' in value ? value.glyph : null;
  const glyphFace = resolveGlyphFace(glyph);
  // An Enterprise brand icon fills the whole tile, edge to edge.
  const fullBleed = useFullBleedGlyph(glyphFace?.name);
  // The face the trigger shows and the identity the cross-fade re-keys on —
  // one derivation for both, so they cannot drift apart. Keyed on colour too,
  // not just name: recolouring the same glyph is still a visible change the
  // swap has to animate, not a no-op the key would otherwise hide.
  const identity = glyphFace ? `glyph:${glyphFace.name}:${glyphFace.color}` : (emoji ?? 'unset');

  return (
    // The guard is belt-and-braces on top of the reset above: `disabled` on the
    // Button already stops a click reaching us (a disabled button fires none,
    // and button.tsx adds disabled:pointer-events-none).
    //
    // `modal` is what makes the picker scrollable with a wheel or trackpad.
    // In workspace Settings this field renders inside `CustomizeSectionWrapper`
    // -> `customize-panel.tsx`'s `Modal`, a Radix Dialog, and Radix wraps the
    // dialog's OVERLAY in react-remove-scroll with
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
    //
    // On `/workspaces/new` this field has no Dialog ancestor at all, so the bug above
    // cannot occur there — `modal` is simply inert in that host, not wrong.
    <Popover open={open && !disabled} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          // On `/workspaces/new` the field renders inside that page's <form>, where a
          // missing `type="button"` would submit it on click. Workspace
          // Settings has no surrounding <form>, so this is a no-op there —
          // still correct to keep, since a shared control should not assume
          // which host it is in.
          type="button"
          // The picker's panels load on demand (project-icon-picker.tsx);
          // aiming at or tabbing to the trigger fetches them before the click.
          onPointerEnter={preloadProjectIconPicker}
          onFocus={preloadProjectIconPicker}
          // `outline`, not `secondary-outline`: the design system prescribes
          // outline for an icon-only button, and secondary-outline's
          // hover:bg-secondary is identical to its resting bg-secondary
          // (button.tsx:27), so the trigger gave no hover feedback at all.
          variant="outline"
          size="icon"
          // Never conditioned on `value`. The whole point of the control is
          // that it stays live after a pick, so you reopen it and switch.
          disabled={disabled}
          aria-label={
            emoji
              ? tI18nComplete('text13447731697e', { value0: emoji })
              : glyphFace
                ? tI18nComplete('text13447731697e', { value0: glyphFace.name })
                : tI18nComplete.raw('text39a1c11af6d3')
          }
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
          // `transition-property: transform` does not cover. `box-shadow` is
          // there because Tailwind draws inset-ring-* with one, and the ring
          // below thickens on hover — the same list the picker's cells carry.
          //
          // ONCE AN ICON IS PICKED the trigger stops being a neutral outline
          // button and becomes the picker cell you just hovered: the same fill
          // under the same 1px inset ring, at rest, in the hue the emoji earns
          // (components/ui/emoji-tint.ts) or the colour the glyph was given
          // (components/ui/glyph-tint.ts). That is what ties it to the same
          // project's card tile and sidebar row.
          //
          // `emojiTintHover` / `glyphTintHover` are not decoration. `outline`
          // carries `hover:bg-foreground/5`, and a :hover rule outranks the
          // resting fill on specificity, so without them the pointer washes
          // the tint out to neutral grey and back. Restating the fill at the
          // same modifier makes tailwind-merge drop the variant's hover
          // entirely — which then leaves the trigger with no pointer feedback
          // at all, so `hover:brightness-110` lifts the tile instead. No icon
          // tile draws a border or ring.
          className={cn(
            'hit-area-1 size-9 shrink-0 transition-[color,background-color,filter,scale] duration-150 active:scale-[0.96]',
            // Last, so `cn`'s tailwind-merge lets a caller's own `size-*` beat
            // the `size-9` default rather than both landing in the class list.
            triggerClassName,
            emoji && [emojiTint(emoji), emojiTintHover(emoji), 'hover:brightness-110'],
            glyphFace && [glyphTint(glyphFace.color), glyphTintHover(glyphFace.color), 'hover:brightness-110'],
            fullBleed && [FULL_BLEED_BORDER, 'p-0'],
          )}
          style={glyphFace ? glyphStyle(glyphFace.color) : undefined}
        >
          {/* Both faces share one fixed box and cross-fade in place. Picking an
              icon closes the popover, so the eye is already on the trigger
              when it changes — a hard swap reads as two objects blinking.
              `initial={false}` keeps a field that mounts with a value from
              animating on first paint.

              size-6 (22.07px), not size-5: a text-lg emoji measures 21px wide,
              so a size-5 box left it hanging 2.61px out of the shared box. */}
          <span
            className={cn(
              'relative inline-flex items-center justify-center',
              // The initial tile fills the trigger; an emoji or glyph keeps the
              // measured size-6 box the comment above explains.
              glyphFace || (!emoji && fallbackLabel?.trim()) ? 'size-full' : 'size-6',
            )}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={identity}
                {...(reduceMotion ? SWAP_REDUCED : SWAP)}
                transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
                className="absolute inset-0 inline-flex items-center justify-center"
              >
                {glyphFace ? (
                  // Named by the button's aria-label, so the glyph itself
                  // stays out of the accessibility tree the same way the
                  // emoji does below — Phosphor's <svg> carries no implicit
                  // role, but the sizing/colour treatment matches on purpose.
                  <glyphFace.GlyphComponent
                    weight="fill"
                    className={cn(fullBleed ? 'size-full' : 'size-1/2', glyphForeground(glyphFace.color))}
                  />
                ) : emoji ? (
                  // Named by the button's aria-label, so the glyph itself stays
                  // out of the accessibility tree.
                  <span aria-hidden className="text-lg leading-none">
                    {emoji}
                  </span>
                ) : fallbackLabel?.trim() ? (
                  // The default face: the initial this workspace would carry
                  // anyway. `size-full` so the tile fills whatever the trigger
                  // is sized to (`size-12` on /new, `size-9` inline elsewhere)
                  // rather than sitting as a smaller square inside a larger box.
                  <EntityAvatar
                    label={fallbackLabel}
                    size="md"
                    className="size-full rounded-md text-lg"
                  />
                ) : (
                  <SmileyIcon className="text-muted-foreground size-4" />
                )}
              </m.span>
            </AnimatePresence>
          </span>
        </Button>
      </PopoverTrigger>
      {/*
        Width: the emoji grid's exact width. 12 columns of `size-8` cells in rows
        padded `px-3` is 12*8 + 2*3 = 102 `--spacing` units; `+2px` is the 1px
        border per side. The Icons tab fills the same width with 10 columns.
        p-0 because each panel owns its padding. Radix gives the content
        role="dialog", so it carries a label.
      */}
      <PopoverContent
        align={align}
        aria-label={tI18nComplete.raw('text39a1c11af6d3')}
        // Focus lands in the search field, not on the first tab: the tab took
        // a focus ring on every open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          const focusSearch = (tries: number) => {
            const input = content.querySelector<HTMLInputElement>('input');
            if (input) input.focus();
            else if (tries > 0) requestAnimationFrame(() => focusSearch(tries - 1));
            else content.focus();
          };
          focusSearch(20);
        }}
        className="w-[calc(102*var(--spacing)+2px)] overflow-hidden p-0"
      >
        <ProjectIconPicker
          // A pick never closes the popover: you try icons and colours in any
          // order and the trigger repaints live. Clicking outside closes it.
          onEmojiSelect={(picked) => onChange(picked.emoji)}
          onGlyphSelect={(picked) => onGlyphChange(picked)}
          selectedGlyph={glyphFace?.name}
          // Reopening lands on the tab you last used: a glyph project reopens
          // on Icon rather than defaulting back to Emoji every time.
          defaultTab={emoji ? 'emoji' : 'icon'}
          // Only meaningful when there IS a current glyph — otherwise the
          // picker keeps its own default (grey). `glyphFace?.color` reaching
          // `undefined` here is what lets ProjectIconPicker's own default
          // parameter apply; passing it explicitly would fight that default.
          defaultColor={glyphFace?.color}
          // The trash button in the picker header. Only when the host can
          // accept a removal (`onClear`) AND there is an icon to remove.
          removeLabel={tI18nComplete.raw('text93d6de7104f0')}
          onRemove={
            onClear && value
              ? () => {
                  onClear();
                  setOpen(false);
                }
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}
