'use client';

import { CheckIcon } from '@phosphor-icons/react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { GLYPH_SEARCH, glyphComponent } from './glyph-registry';
import { brandIconSources } from './kortix-glyphs';
import { useUiBrand } from '../providers/ui-provider';
import { glyphForeground, glyphHoverWash, glyphStyle } from './glyph-tint';
import { cn } from '../lib/utils';
import {
  PROJECT_GLYPH_COLORS,
  PROJECT_GLYPH_GROUPS,
  isProjectGlyphPaletteColor,
  normalizeProjectGlyphColor,
  type ProjectGlyphPaletteColor,
} from '@kortix/shared';

export interface GlyphSelection {
  name: string;
  color: string;
}

/**
 * The Icons tab of the project icon picker.
 *
 * Layout, top to bottom, inside one fixed 388px panel (the Emojis tab has the
 * same height, so the popover never resizes on a tab switch):
 *   1. Colour row: the eight preset dots, a divider, and the custom-colour dot.
 *      The custom dot swaps the row for a HEX field, a saturation/value square
 *      and a hue rail.
 *   2. Search field.
 *   3. The catalogue in its groups (`PROJECT_GLYPH_GROUPS`), 10 columns, every
 *      glyph solid and painted in the current colour.
 *
 * Neither a colour nor a glyph click closes the popover: you can pick the icon
 * first or the colour first, and each commit repaints the trigger at once.
 * Clicking outside closes it.
 *
 * `color` is a preset name or a lower-case `#rrggbb`; `--glyph` carries it to
 * every cell (see glyph-tint.ts).
 */

/** The preset dots: solid, the same token the glyph paints in. */
const SWATCH: Record<ProjectGlyphPaletteColor, string> = {
  grey: 'bg-glyph-solid-grey',
  red: 'bg-glyph-solid-red',
  orange: 'bg-glyph-solid-orange',
  yellow: 'bg-glyph-solid-yellow',
  lime: 'bg-glyph-solid-lime',
  blue: 'bg-glyph-solid-blue',
  purple: 'bg-glyph-solid-purple',
  magenta: 'bg-glyph-solid-magenta',
};

const DOT = cn(
  'relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full',
  'transition-[scale,box-shadow] duration-fast active:scale-[0.92]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover',
);

/** Selected dot: a ring one gap away, in the dot's own colour. */
const DOT_SELECTED = 'ring-[1.5px] ring-offset-2 ring-offset-popover ring-[color:var(--glyph)]';

const RAINBOW =
  'bg-[conic-gradient(from_180deg,#f25f5c,#f7b32b,#a6d96a,#4fc3f7,#7e57c2,#e05fbf,#f25f5c)]';

/**
 * A glyph's keyword list always includes its own lowercased name, so an empty
 * query matches everything. `startsWith`, not `includes`: a substring test
 * matched "cat" inside "duplicate" and "notification".
 */
export function matchesSearch(name: string, query: string): boolean {
  if (!query) return true;
  return GLYPH_SEARCH[name]?.some((keyword) => keyword.startsWith(query)) ?? false;
}

export function GlyphPicker({
  color,
  selected,
  onColorChange,
  onGlyphSelect,
  className,
}: {
  color: string;
  /** The glyph currently chosen; its cell keeps the wash. */
  selected?: string;
  onColorChange: (color: string) => void;
  onGlyphSelect: (glyph: GlyphSelection) => void;
  className?: string;
}) {
  const [search, setSearch] = useState('');
  const resolved = normalizeProjectGlyphColor(color) ?? 'grey';
  const isCustom = !isProjectGlyphPaletteColor(resolved);
  const [customOpen, setCustomOpen] = useState(isCustom);
  const query = search.trim().toLowerCase();

  // The Brand group (the account's own icon) shows only when the account has
  // a branding image, and takes the brand's name as its heading.
  const brand = useUiBrand();
  const hasBrandIcon = brandIconSources(brand) !== null;
  const groups = PROJECT_GLYPH_GROUPS.filter((group) => group.label !== 'Brand' || hasBrandIcon)
    .map((group) => ({
      label: group.label === 'Brand' ? (brand?.app_name?.trim() || 'Your brand') : group.label,
      names: (group.names as readonly string[]).filter((name) => matchesSearch(name, query)),
    }))
    .filter((group) => group.names.length > 0);

  return (
    <div
      style={glyphStyle(resolved)}
      className={cn('isolate flex h-[388px] w-full flex-col', className)}
    >
      {customOpen ? (
        <CustomColor
          color={isCustom ? resolved : presetHex(resolved)}
          onChange={onColorChange}
          onClose={() => setCustomOpen(false)}
        />
      ) : (
        <div className="border-border flex h-12 shrink-0 items-center justify-between border-b px-4">
          {PROJECT_GLYPH_COLORS.map((preset) => {
            const selected = preset === resolved;
            return (
              <button
                key={preset}
                type="button"
                data-swatch={preset}
                aria-pressed={selected}
                aria-label={`Colour: ${preset}`}
                onClick={() => onColorChange(preset)}
                style={selected ? { '--glyph': `var(--glyph-solid-${preset})` } as never : undefined}
                className={cn(DOT, SWATCH[preset], selected && DOT_SELECTED)}
              >
                {selected ? <CheckIcon weight="bold" className="size-3 text-white" /> : null}
              </button>
            );
          })}
          <span aria-hidden className="bg-border h-5 w-px" />
          <button
            type="button"
            data-swatch="custom"
            aria-pressed={isCustom}
            aria-label="Custom colour"
            onClick={() => setCustomOpen(true)}
            className={cn(DOT, RAINBOW, isCustom && 'ring-foreground ring-offset-popover ring-[1.5px] ring-offset-2')}
          />
        </div>
      )}

      <div className="border-border flex h-11 shrink-0 items-center border-b px-4">
        <input
          type="search"
          aria-label="Search icons"
          placeholder="Search icons…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="text-foreground placeholder:text-muted-foreground/70 h-full w-full bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
      </div>

      <div className="relative flex-1 overflow-y-auto px-3 pb-3 select-none">
        {groups.length > 0 ? (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="text-muted-foreground px-1 pt-3 pb-1.5 text-xs font-medium">
                {group.label}
              </h3>
              <div className="grid grid-cols-10">
                {group.names.map((name) => {
                  const Glyph = glyphComponent(name);
                  if (!Glyph) return null;
                  return (
                    <button
                      key={name}
                      type="button"
                      data-glyph={name}
                      data-selected={name === selected}
                      aria-label={name}
                      aria-pressed={name === selected}
                      onClick={() => onGlyphSelect({ name, color: resolved })}
                      className={cn(
                        'flex h-9 cursor-pointer items-center justify-center rounded-md',
                        'transition-[background-color,scale] duration-fast active:scale-[0.94]',
                        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                        glyphForeground(resolved),
                        glyphHoverWash(resolved),
                      )}
                    >
                      <Glyph weight="fill" className="size-[18px]" />
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        ) : (
          <p className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-balance">
            No icons for &ldquo;{search}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── Custom colour ─────────────────────────────────────────────────────── */

/** Each preset's dark-theme solid value, so the custom field opens on the
 *  colour the user already sees. Mirrors `--glyph-solid-*` in theme.css. */
const PRESET_HEX: Record<ProjectGlyphPaletteColor, string> = {
  grey: '#a3a6ad',
  red: '#ec5f5f',
  orange: '#f29b4d',
  yellow: '#f2c94c',
  lime: '#6cc18a',
  blue: '#6aa6f0',
  purple: '#a88bf3',
  magenta: '#e57abf',
};

function presetHex(color: string): string {
  return isProjectGlyphPaletteColor(color) ? PRESET_HEX[color] : '#a3a6ad';
}

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Pointer drag over an element; reports the pointer as 0-1 fractions. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const report = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    onMove(clamp((event.clientX - box.left) / box.width), clamp((event.clientY - box.top) / box.height));
  };
  return {
    ref,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      report(event);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) report(event);
    },
  };
}

function CustomColor({
  color,
  onChange,
  onClose,
}: {
  color: string;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color));
  const [draft, setDraft] = useState(color.slice(1).toUpperCase());
  const hex = hsvToHex(hsv);

  const commit = (next: Hsv) => {
    setHsv(next);
    const value = hsvToHex(next);
    setDraft(value.slice(1).toUpperCase());
    onChange(value);
  };

  const square = useDrag((x, y) => commit({ h: hsv.h, s: x, v: 1 - y }));
  const rail = useDrag((_, y) => commit({ ...hsv, h: y * 360 }));

  return (
    <div className="border-border shrink-0 border-b px-4 pt-3 pb-4">
      <div className="mb-3 flex items-center gap-3">
        <span aria-hidden className="size-6 shrink-0 rounded-full" style={{ background: hex }} />
        <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
          <span className="text-muted-foreground/80">HEX</span>
          <span className="text-foreground">#</span>
          <input
            aria-label="Hex colour"
            value={draft}
            maxLength={6}
            spellCheck={false}
            onChange={(event) => {
              const next = event.target.value.replace(/[^0-9a-f]/gi, '').toUpperCase();
              setDraft(next);
              const value = normalizeProjectGlyphColor(`#${next}`);
              if (value && value.startsWith('#')) {
                setHsv(hexToHsv(value));
                onChange(value);
              }
            }}
            className="text-foreground -ml-2 w-20 bg-transparent font-mono text-sm tabular-nums outline-none"
          />
        </label>
        <button
          type="button"
          aria-label="Back to preset colours"
          onClick={onClose}
          className={cn(DOT, RAINBOW, 'ring-foreground ring-offset-popover ring-[1.5px] ring-offset-2')}
        />
      </div>

      <div className="flex gap-3">
        <div
          {...square}
          role="slider"
          aria-label="Saturation and brightness"
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={hex}
          className="relative h-32 flex-1 cursor-crosshair touch-none rounded-md"
          style={{
            background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex({ h: hsv.h, s: 1, v: 1 })})`,
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_1px_3px_rgb(0_0_0/0.4)]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
          />
        </div>
        <div
          {...rail}
          role="slider"
          aria-label="Hue"
          aria-valuenow={Math.round(hsv.h)}
          aria-valuemin={0}
          aria-valuemax={360}
          className="relative h-32 w-2.5 cursor-ns-resize touch-none rounded-full bg-[linear-gradient(to_bottom,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)]"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
            style={{ top: `${(hsv.h / 360) * 100}%`, background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
          />
        </div>
      </div>
    </div>
  );
}
