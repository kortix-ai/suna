'use client';

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

export interface EntityAvatarProps {
  label?: string;
  /**
   * A single emoji grapheme standing in for the entity — today, a project's own
   * icon. Takes precedence over `icon` and over the label's initial.
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
  emoji,
  icon: IconComponent,
  size = 'md',
  className,
}: EntityAvatarProps) {
  const sizes = SIZE_MAP[size];
  const initial = (label?.trim()?.charAt(0) || '?').toUpperCase();
  const chalk = chalkColors(`${label?.trim()}` || initial);

  return (
    <span
      data-slot="entity-avatar"
      // chalkColors() is an inline style, so it beats any class a caller
      // passes. An emoji is already the colour — sitting it on a saturated
      // hash-derived pastel reads as noise, and in dark mode that pastel is a
      // bright square in an otherwise dark grid. So the emoji tile drops the
      // style entirely and takes a neutral fill from the class list below.
      style={
        emoji
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
        // initial's text size; before `className`, so a caller's own fill
        // (the project card's `bg-background`) still wins over `bg-muted`.
        emoji && ['bg-muted border-border/60', sizes.emoji],
        className,
      )}
    >
      {emoji ? (
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
