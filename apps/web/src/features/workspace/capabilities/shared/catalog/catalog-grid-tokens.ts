/**
 * Layout tokens shared by the catalog grid and its loading skeleton.
 *
 * A `.ts` sibling of `catalog-grid.tsx` rather than two more exports on it:
 * React Fast Refresh only hot-swaps a module whose every export is a component,
 * so a single exported string here would make editing the grid reload the whole
 * page. Named `-tokens` (not `catalog-grid.ts`) because a `.ts`/`.tsx` pair
 * sharing one basename is ambiguous to module resolution.
 */

/**
 * Shared by the loading skeleton and the real grid so the two class strings
 * cannot drift apart. Two independently hand-typed copies of the same
 * breakpoint is what caused this class of grid to drift out of sync before.
 *
 * `sm:grid-cols-2 xl:grid-cols-3` (not `lg:grid-cols-3`) is deliberate: at the
 * `lg` breakpoint (1024-1279px) a 3-up card does not have room for a title, a
 * description line, and a trailing slot without truncating hard.
 */
export const GRID_CLASSNAME = 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3';

/**
 * Height of a real `CatalogCard`, sized to the common two-line-description
 * case so the loading skeleton and the settled card never reflow vertically.
 *
 * Measured against the running app's compiled stylesheet: **83.42px** for a
 * two-line description. The math below reproduces that to within a
 * sub-pixel-rounding fraction — it must use this repo's actual spacing
 * token, `--spacing: 0.23rem` (`globals.css:670`), not Tailwind's framework
 * default of `0.25rem`, and it must count the button's own 1px top + 1px
 * bottom border, which is easy to forget because it isn't a `padding` line:
 *
 *   border (button, 1px top + 1px bottom)                       =  2.00px
 * + py-3.5 (2 x 3.5 x 0.23rem x 16px/rem)                        = 25.76px
 * + max(
 *     leading tile (size-9 = 9 x 0.23rem x 16px/rem)             = 33.12px,
 *     title row (text-sm line-height, 20px)
 *       + space-y-1 gap (1 x 0.23rem x 16px/rem)                 =  3.68px
 *       + two clamped description lines (text-xs, 16px each)     = 32.00px
 *                                                           total = 55.68px,
 *   )
 * = 2.00 + 25.76 + 55.68 = 83.44px  (measured: 83.42px; the ~0.02px gap is
 *   the browser's own sub-pixel layout rounding, not an error in this math)
 *
 * Rounded up to 84px so the skeleton is never a hair shorter than the real
 * card.
 */
export const CATALOG_CARD_HEIGHT_CLASSNAME = 'h-[84px]';
