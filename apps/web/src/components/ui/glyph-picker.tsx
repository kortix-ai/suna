'use client';

import { CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { GLYPH_SEARCH, glyphComponent } from '@/components/ui/glyph-registry';
import { glyphForeground, glyphTint, glyphTintHover } from '@/components/ui/glyph-tint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { PROJECT_GLYPH_COLORS, PROJECT_GLYPH_NAMES, type ProjectGlyphColor } from '@kortix/shared';

export interface GlyphSelection {
  name: string;
  color: string;
}

/**
 * Glyph grid for picking a project icon. Same geometry contract as
 * `emoji-picker.tsx` on purpose: `h-[368px]`, 9 columns of `size-8` cells in
 * rows padded `px-1.5`. `project-icon-field.tsx` sizes the popover to that
 * exact width (9 * 8 + 2 * 1.5 spacing units); a different column count or a
 * different fixed height changes the popover's geometry the moment the Icon
 * tab is selected, so both numbers are copied here, not re-derived.
 *
 * glyph-picker.test.tsx checks those same four literals — `size-8`, `px-1.5`,
 * `grid-cols-9`, `h-[368px]` — but never against THIS raw, commented file: the
 * three grid classes are asserted against `renderToStaticMarkup` output (real
 * shipped DOM, no comments exist there at all), and the height comparison
 * strips every block and line comment out of both this file and
 * emoji-picker.tsx before matching. A doc comment repeating these class
 * names — like this one — is deliberately safe to write and cannot make
 * either test pass or fail.
 *
 * All 202 catalogue glyphs render in ONE `grid-cols-9`, in
 * `PROJECT_GLYPH_NAMES`'s declaration order — no category headers. This
 * shipped with an 8-category sub-grid (sticky header per category) first;
 * review feedback was that the categories added scannable structure but no
 * function — nothing filters, sorts, or navigates by category — so they were
 * cut. `PROJECT_GLYPH_GROUPS` (in `@kortix/shared`) still owns the grouping
 * and the ordering; `PROJECT_GLYPH_NAMES` is that same catalogue flattened in
 * declaration order, so related glyphs stay adjacent even with the headers
 * gone. Flattening it a second time here, instead of importing the flat
 * export, would risk a reordering that drifts from the shared source.
 *
 * The grid IS the colour preview: every cell paints in `color`, not just the
 * one the user last picked. Clicking a swatch re-tints the whole grid and
 * leaves the popover open — colour is a modifier you can change your mind
 * about. Clicking a glyph commits `{ name, color }` and closes it — the glyph
 * is the choice. That asymmetry is deliberate, not an oversight.
 *
 * Unlike an emoji cell (tinted only while `data-active`, via frimousse's
 * pointer/keyboard tracking), a glyph cell carries its colour in TWO layers:
 * the icon itself is tinted at rest (`glyphForeground`, so the preview reads
 * before you ever touch the grid), and the fill + 1px inset ring appear only
 * on hover (`glyphTintHover` + a local ring map below) — the same tile
 * treatment an emoji cell shows on `data-active`, so hovering either tab reads
 * as the same surface.
 */

/**
 * Hover-only ring colour, one literal class per palette colour.
 *
 * `glyph-tint.ts` exports the REST tile (`glyphTint`: fill + ring, always on —
 * built for a host like the project-icon trigger button that stays tinted
 * once an icon is picked) and the hover FILL restated on its own
 * (`glyphTintHover`, for fighting a host variant's `hover:bg-*`). Neither is a
 * hover-scoped RING. A glyph cell here has no rest-state tile at all — only
 * the tinted icon — so the ring has to be introduced fresh, hover-scoped, and
 * it has to stay a literal string per colour: Tailwind v4 extracts class names
 * by scanning source TEXT, so gluing a `hover:` prefix onto a helper's return
 * value at runtime would compile to nothing.
 */
const GLYPH_HOVER_RING: Record<ProjectGlyphColor, string> = {
  grey: 'hover:inset-ring-glyph-ring-grey',
  red: 'hover:inset-ring-glyph-ring-red',
  orange: 'hover:inset-ring-glyph-ring-orange',
  yellow: 'hover:inset-ring-glyph-ring-yellow',
  lime: 'hover:inset-ring-glyph-ring-lime',
  blue: 'hover:inset-ring-glyph-ring-blue',
  purple: 'hover:inset-ring-glyph-ring-purple',
  magenta: 'hover:inset-ring-glyph-ring-magenta',
};

/** `color` is typed `string` at the component boundary (it round-trips through
 *  plain project state, same as `glyph-tint.ts`'s own props) but the hover-ring
 *  map above is keyed by the narrow palette type, so an unrecognised value —
 *  stale cached data, a hand-edited row — falls back to grey rather than
 *  indexing to `undefined` and silently dropping the hover ring. */
function resolveGlyphColor(color: string): ProjectGlyphColor {
  return (PROJECT_GLYPH_COLORS as readonly string[]).includes(color)
    ? (color as ProjectGlyphColor)
    : 'grey';
}

/** Ring geometry declared once — only the colour is per-instance below, same
 *  reasoning as EMOJI_BUTTON's single `data-[active]:inset-ring-1`. */
const GLYPH_BUTTON = cn(
  'flex size-8 items-center justify-center rounded-md',
  'cursor-pointer select-none',
  'transition-[background-color,box-shadow,scale] duration-100 active:scale-[0.96]',
  'hover:inset-ring-1',
);

/** A glyph's keyword list always includes its own lowercased name
 *  (glyph-registry.test.tsx pins this), so an empty query matches everything
 *  and a real query only needs a substring check against that list. */
function matchesSearch(name: string, query: string): boolean {
  if (!query) return true;
  return GLYPH_SEARCH[name]?.some((keyword) => keyword.includes(query)) ?? false;
}

export function GlyphPicker({
  color,
  onColorChange,
  onGlyphSelect,
  className,
}: {
  color: string;
  onColorChange: (color: string) => void;
  onGlyphSelect: (glyph: GlyphSelection) => void;
  className?: string;
}) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const resolvedColor = resolveGlyphColor(color);

  // Filtered even when `query` is empty — `matchesSearch` short-circuits to
  // `true` there, so this is the one code path for both states rather than a
  // branch that has to be proven to agree with its sibling.
  const names = PROJECT_GLYPH_NAMES.filter((name) => matchesSearch(name, query));

  return (
    <div className={cn('isolate flex h-[368px] w-full flex-col', className)}>
      <div className="space-y-2 p-2">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            aria-label="Search icons"
            placeholder="Search icons"
            variant="popover"
            size="sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <InputGroupSearchClear onClick={() => setSearch('')} />
        </InputGroupSearch>

        {/* Moved here from a footer below the grid: colour is a modifier over
            the glyph you're about to pick, decided before you scan the grid,
            so it reads as part of the search header, not a trailing readout.
            No `border-t` — that rule separated a footer from the content
            above it; this row now shares the header block with the search
            field and takes its `space-y-2` rhythm instead. Dropping the
            footer's fixed `h-11` hands that height back to the scrollable
            grid below.

            `glyphTint` (the REST tile, not the hover-only variant used in the
            grid below) belongs here: a swatch IS a persistent colour
            indicator, not a hover preview, so it wears its own colour's fill
            + ring at all times. The selected swatch adds a checkmark rather
            than a thicker ring — that keeps every swatch's ring at the same
            1px `glyphTint` already draws, so the row doesn't shift geometry
            when the selection changes. */}
        <div className="flex items-center justify-between gap-1.5">
          {PROJECT_GLYPH_COLORS.map((paletteColor) => (
            <button
              key={paletteColor}
              type="button"
              data-swatch={paletteColor}
              aria-pressed={paletteColor === resolvedColor}
              aria-label={`Colour: ${paletteColor}`}
              onClick={() => onColorChange(paletteColor)}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full',
                'cursor-pointer transition-[scale] duration-100 active:scale-[0.96]',
                glyphTint(paletteColor),
              )}
            >
              {paletteColor === resolvedColor ? (
                <CheckIcon className={cn('size-3.5', glyphForeground(paletteColor))} />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto">
        {names.length > 0 ? (
          <div className="grid grid-cols-9 px-1.5 pb-1.5 select-none">
            {names.map((name) => {
              const Glyph = glyphComponent(name);
              if (!Glyph) return null;

              return (
                <button
                  key={name}
                  type="button"
                  data-glyph={name}
                  aria-label={name}
                  onClick={() => onGlyphSelect({ name, color: resolvedColor })}
                  className={cn(
                    GLYPH_BUTTON,
                    glyphForeground(color),
                    glyphTintHover(color),
                    GLYPH_HOVER_RING[resolvedColor],
                  )}
                >
                  <Glyph className="size-4" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-balance">
            No icons for &ldquo;{search}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}
