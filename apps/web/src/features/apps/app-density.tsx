'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';

import Hint from '@/components/ui/hint';

import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '@/i18n/product-catalog-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';

import { GridNineIcon, SquaresFourIcon, type Icon as PhosphorIcon } from '@phosphor-icons/react';

import { useCallback, useSyncExternalStore } from 'react';



/**
 * How many tiles the gallery puts in a row.
 *
 * **Container queries, not viewport breakpoints.** This page sits beside a
 * sidebar that docks and collapses, so the grid's real width swings by ~256px
 * while the viewport never moves. `xl:grid-cols-4` on a 1280px viewport with
 * the sidebar docked fires on a container that is actually ~1024px wide — four
 * 236px tiles from a class chosen for 300px ones. `@5xl/apps:` asks the only
 * question that decides whether a column fits: how wide is the box the grid is
 * in. The named container is declared on the padded column in `AppsView`.
 *
 * The steps are chosen so the TILE never drops below ~232px at any of them —
 * the width where a 1080px page scaled into it stops reading as a page and
 * starts reading as a grey rectangle. Container width -> tile width:
 *
 *   | step            | container | cols | tile    |
 *   | ---             | ---       | ---  | ---     |
 *   | (base)          | < 512px   | 1    | full    |
 *   | `@lg`  (32rem)  | 512px     | 2    | 232x131 |
 *   | `@3xl` (48rem)  | 768px     | 3    | 235x132 |
 *   | `@5xl` (64rem)  | 1024px    | 4    | 236x133 |
 *   | (cap)           | 1280px    | 4    | 300x169 |
 *
 * Four across is therefore what a docked desktop lands on, and a phone still
 * gets one column — a 170px tile is the grey rectangle again.
 *
 * Written out as one literal. Tailwind scans source text, so a class assembled
 * at runtime (`grid-cols-${n}`) never reaches the compiled stylesheet and
 * silently does nothing.
 */
export const APP_GRID_CONTAINER = '@container/apps';

/**
 * How many columns the gallery is ALLOWED to reach, as a reader's choice.
 *
 * There is a default and there is a choice, in that order. Three across is the
 * default: at the `max-w-7xl` cap that is a ~405px tile, where four is ~300px,
 * and the tile width is the only thing that decides whether the scaled-down
 * desktop page inside it reads as a page or as a swatch. Someone with twenty
 * Apps wants to see twenty Apps, so the control trades size for count — but
 * nobody has to touch it to get a sane page.
 *
 * Both ladders share every step below their cap, so switching only ever changes
 * what happens in a WIDE container. Neither drops below the ~232px tile floor
 * that turns a card into a grey rectangle.
 *
 * Written out as full literals, one per option. Tailwind scans source text, so
 * a class assembled at runtime (`grid-cols-${n}`) never reaches the compiled
 * stylesheet and silently does nothing.
 */
export type AppGridColumns = 3 | 4;

export const APP_GRID_DEFAULT_COLUMNS: AppGridColumns = 3;

export const APP_GRID_COLUMN_OPTIONS: Record<
  AppGridColumns,
  { label: string; grid: string; icon: PhosphorIcon }
> = {
  3: {
    label: 'Comfortable — up to 3 per row',
    grid: 'grid-cols-1 @lg/apps:grid-cols-2 @3xl/apps:grid-cols-3',
    icon: SquaresFourIcon,
  },
  4: {
    label: 'Compact — up to 4 per row',
    grid: 'grid-cols-1 @lg/apps:grid-cols-2 @3xl/apps:grid-cols-3 @5xl/apps:grid-cols-4',
    icon: GridNineIcon,
  },
};

function localizedAppCopy(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    {
      grid: APP_GRID_COLUMN_OPTIONS,
    },
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
}

/** Left to right in the control: biggest tile first, densest last. */
export const APP_GRID_COLUMN_ORDER = [3, 4] as const;

export const APP_GRID_COLUMNS_STORAGE_KEY = 'kortix.apps.grid-columns';

/**
 * The stored preference, or `null` for anything that is not one of ours.
 *
 * `localStorage` is a string bucket shared with every other tab and every past
 * version of this page, so the value read back is untrusted input: a count this
 * build removed, a key someone else wrote, `undefined` stringified by a bug.
 * Any of those would land in `APP_GRID_COLUMN_OPTIONS[n]` as `undefined` and
 * render a grid with no column class at all.
 */
export function parseAppGridColumns(value: string | null): AppGridColumns | null {
  if (!value) return null;
  return Object.hasOwn(APP_GRID_COLUMN_OPTIONS, value) ? (Number(value) as AppGridColumns) : null;
}

/**
 * Where the choice lives when `localStorage` will not take it.
 *
 * A browser set to block site data throws on `setItem`, and the reader who
 * clicked a density button is owed the density they clicked whether or not it
 * can outlive the tab. Module scope, so it survives a remount the way the real
 * store would.
 */
let blockedStorageColumns: AppGridColumns | null = null;

/** Same-tab subscribers. The `storage` event covers every OTHER tab, not this one. */
const columnListeners = new Set<() => void>();

export function subscribeAppGridColumns(onChange: () => void) {
  columnListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    columnListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function readAppGridColumns(): AppGridColumns {
  if (blockedStorageColumns) return blockedStorageColumns;
  try {
    return (
      parseAppGridColumns(window.localStorage.getItem(APP_GRID_COLUMNS_STORAGE_KEY)) ??
      APP_GRID_DEFAULT_COLUMNS
    );
  } catch {
    return APP_GRID_DEFAULT_COLUMNS;
  }
}

export function writeAppGridColumns(next: AppGridColumns) {
  blockedStorageColumns = next;
  try {
    window.localStorage.setItem(APP_GRID_COLUMNS_STORAGE_KEY, String(next));
  } catch {
    // Site data blocked. `blockedStorageColumns` already holds the choice for
    // this tab's lifetime, which is the whole guarantee we can make.
  }
  for (const listener of columnListeners) listener();
}

/**
 * The reader's column choice.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the server has no
 * `localStorage`, so the server snapshot is the DEFAULT and the client reads
 * the real value during hydration. An effect would paint the default first and
 * then jump, which on this page is every tile resizing one frame after load.
 */
export function useAppGridColumns(): [AppGridColumns, (next: AppGridColumns) => void] {
  const value = useSyncExternalStore(
    subscribeAppGridColumns,
    readAppGridColumns,
    () => APP_GRID_DEFAULT_COLUMNS,
  );
  const setValue = useCallback((next: AppGridColumns) => writeAppGridColumns(next), []);
  return [value, setValue];
}

/**
 * Column count, as two states of one control rather than a menu.
 *
 * A segmented `ButtonGroup` of icon buttons is the pattern this product already
 * uses for a small closed set of view choices. Two options is few enough that
 * both are visible without opening anything, and the glyphs read as the thing
 * they do: four squares, then nine, the second denser than the first.
 */
export function AppGridColumnsControl({
  value,
  onChange,
}: {
  value: AppGridColumns;
  onChange: (next: AppGridColumns) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  return (
    <ButtonGroup aria-label={tI18nComplete.raw('texte39d334ebb3c')}>
      {APP_GRID_COLUMN_ORDER.map((key) => {
        const option = appCopy.grid[key];
        const Glyph = option.icon;
        const active = value === key;
        return (
          <Hint key={key} side="bottom" label={option.label}>
            <Button
              type="button"
              variant={active ? 'secondary' : 'outline'}
              size="icon-sm"
              aria-pressed={active}
              aria-label={option.label}
              onClick={() => onChange(key)}
            >
              <Glyph className="size-4" />
            </Button>
          </Hint>
        );
      })}
    </ButtonGroup>
  );
}
