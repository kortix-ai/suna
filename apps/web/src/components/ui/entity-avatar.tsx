'use client';

import { emojiTint } from '@/components/ui/emoji-tint';
import { glyphComponent } from '@/components/ui/glyph-registry';
import { glyphForeground, glyphTint } from '@/components/ui/glyph-tint';
import type { Icon } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';
import { chalkColors } from '@kortix/shared';
import { type Icon as IconType } from '@phosphor-icons/react';

/**
 * `emoji` is its own step, not the initial's `text-*`: an emoji is the tile's
 * content, not a letter set in the tile's type scale. Inheriting `box`'s size
 * puts a 14px emoji in the 36.8px `lg` card tile — legible, but visibly a
 * letter-sized thing in an icon-sized hole.
 *
 * The values are measured, not derived. A colour-emoji face is a bitmap strike,
 * so `measureText` over-reports it and the glyph paints WIDER than its
 * font-size. Rasterised through Chromium on this font stack, painted extent vs.
 * the tile it sits in:
 *
 *   xs  13px → 16×14 in 18.40  (0.87)      md  16px → 20×17 in 29.44  (0.68)
 *   sm  14px → 18×16 in 22.08  (0.82)      lg  20px → 22×17 in 36.80  (0.60)
 *                                          xl  30px → 30×25 in 51.52  (0.58)
 *
 * Nothing overflows its tile. The two small tiles run proportionally fuller
 * because `text-xs` (13px) is the floor of this app's type scale — and below
 * that an emoji stops being readable in an 18px square anyway.
 */
const SIZE_MAP = {
  xs: { box: 'size-5 rounded-sm text-xs', icon: 'size-3', emoji: 'text-xs' },
  sm: { box: 'size-6 rounded-sm text-xs', icon: 'size-3.5', emoji: 'text-sm' },
  md: { box: 'size-8 rounded-md text-xs', icon: 'size-4', emoji: 'text-base' },
  lg: { box: 'size-10 rounded-md text-sm', icon: 'size-5', emoji: 'text-xl' },
  xl: { box: 'size-14 rounded-md text-base', icon: 'size-7', emoji: 'text-3xl' },
} as const;

export type EntityAvatarSize = keyof typeof SIZE_MAP;

/**
 * Resolves a `glyph` prop to the component that actually draws it, or `null`
 * if the name isn't in the registry.
 *
 * Its own function rather than an inline `glyph ? glyphComponent(…) : null`
 * at each use site, because EVERY use site (the inline style, the tile's
 * class list, the rendered face) has to agree on whether there IS a
 * renderable glyph, and a name that fails to resolve has to fall through to
 * the rest of the precedence chain identically everywhere. Two independent
 * `glyphComponent()` calls computing the same answer is how they drift.
 */
function resolveGlyph(glyph?: { name: string; color: string } | null) {
  if (!glyph) return null;
  const GlyphComponent = glyphComponent(glyph.name);
  return GlyphComponent ? { GlyphComponent, color: glyph.color } : null;
}

export interface EntityAvatarProps {
  label?: string;
  /**
   * A named glyph + colour — a project's alternative to `emoji`. Takes
   * precedence over `emoji`, `icon`, and the label's initial: the field that
   * produces this value is a union (a project has an emoji XOR a glyph,
   * never both), so whichever was chosen last is what should paint.
   *
   * An unknown `name` resolves through `glyphComponent()` to `null` and
   * falls through to the rest of the precedence chain rather than painting
   * an empty tile — the server rejects unknown names, but a client
   * rendering STALE cached data (an old snapshot in the query cache, a
   * catalogue that shrank) must not break.
   */
  glyph?: { name: string; color: string } | null;
  /**
   * A single emoji grapheme standing in for the entity — today, a project's
   * own icon. Beaten by `glyph`; takes precedence over `icon` and over the
   * label's initial.
   *
   * Typed `| null` so it takes `KortixProject.icon` (server-validated to one
   * emoji, or null) with no coercion at the call site. Anything falsy — null,
   * undefined, '' — is "no emoji" and falls through to the existing behaviour,
   * which is what keeps all ~30 emoji-less call sites byte-identical.
   */
  emoji?: string | null;
  icon?: Icon | IconType;
  size?: EntityAvatarSize;
  className?: string;
}

export function EntityAvatar({
  label,
  glyph,
  emoji,
  icon: IconComponent,
  size = 'md',
  className,
}: EntityAvatarProps) {
  const sizes = SIZE_MAP[size];
  const initial = (label?.trim()?.charAt(0) || '?').toUpperCase();
  const chalk = chalkColors(`${label?.trim()}` || initial);
  const resolvedGlyph = resolveGlyph(glyph);

  return (
    <span
      data-slot="entity-avatar"
      // chalkColors() is an inline style, so it beats any class a caller
      // passes. A glyph or an emoji is already the colour — sitting either on
      // a saturated hash-derived pastel reads as noise, and in dark mode that
      // pastel is a bright square in an otherwise dark grid. So a glyph or
      // emoji tile drops the style entirely and rebuilds itself from its own
      // tint tokens. See the class list.
      style={
        resolvedGlyph || emoji
          ? undefined
          : {
              backgroundColor: chalk.background,
              color: chalk.foreground,
              borderColor: chalk.border,
            }
      }
      className={cn(
        'inline-flex shrink-0 items-center justify-center border font-semibold',
        sizes.box,
        // After `sizes.box`, so tailwind-merge resolves `sizes.emoji` over the
        // initial's text size — and so `border-0` resolves over the base
        // `border`, which is what stops a neutral hairline being drawn OUTSIDE
        // the coloured inset ring.
        //
        // `emojiTint()` is the picker's hovered-cell treatment (a pale
        // `--color-emoji-fill-*` under a 1px `--color-emoji-ring-*` inset ring)
        // made this tile's RESTING look, with the hue derived from the emoji
        // rather than from a grid position the tile does not have. See
        // emoji-tint.ts for the mapping. Both the ring and the fill are
        // light-dark() pairs, so there is no `dark:` variant here.
        //
        // It replaces `bg-muted border-foreground/25 shadow-2xs`, which existed
        // to fix a different tile: a NEUTRAL fill measured 1.07:1 against the
        // card in dark, so it had to borrow an edge from `--foreground` and a
        // lift from a shadow to read as a tile at all. The tinted fill and its
        // ring carry that on their own — measured against all three surfaces in
        // both themes, the ring runs 2.30–3.55:1 and the fill 1.19–1.55:1
        // (.superpowers/sdd/2026-07-31-project-emoji-icons/tint-report.md).
        //
        // STILL LAST-WINS: a caller className that sets a background silently
        // beats `bg-emoji-fill-*` / `bg-glyph-fill-*` and leaves the tile
        // ringed but untinted. That is why the project card no longer passes
        // `bg-background`.
        resolvedGlyph ? glyphTint(resolvedGlyph.color) : emoji && [emojiTint(emoji), sizes.emoji],
        className,
      )}
    >
      {resolvedGlyph ? (
        // Same reasoning as the emoji span below: the tile always sits
        // beside the name it belongs to, so the glyph itself is decorative.
        // `sizes.icon`, not `sizes.emoji` — a glyph is a drawn Phosphor icon,
        // sized like the plain `icon` prop below, not like a text-rendered
        // emoji grapheme.
        <resolvedGlyph.GlyphComponent
          className={cn(sizes.icon, glyphForeground(resolvedGlyph.color))}
        />
      ) : emoji ? (
        // The tile always sits beside the name it belongs to, so the glyph is
        // decorative: announced, it reads the emoji's CLDR name immediately
        // before the label that says the same thing. Same treatment as the
        // picker trigger in features/projects/modal/project-icon-field.tsx.
        <span aria-hidden className="leading-none">
          {emoji}
        </span>
      ) : IconComponent ? (
        <IconComponent className={sizes.icon} />
      ) : (
        initial
      )}
    </span>
  );
}
