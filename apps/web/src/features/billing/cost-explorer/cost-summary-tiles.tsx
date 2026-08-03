import type { CostSummary } from '@kortix/sdk';

import { Skeleton } from '@/components/ui/skeleton';

import { cn } from '@/lib/utils';
import { formatSessionCostUsd } from '../session-cost-format';
import { CostSparkline } from './cost-sparkline';

export interface CostSummaryTile {
  label: string;
  value: string;
  /**
   * One value per day across the selected window, oldest first, for this
   * tile's own metric. Optional because a caller-supplied tile may be a figure
   * with no daily series behind it (a count, a duration) — those simply get no
   * sparkline rather than a fabricated one.
   */
  series?: number[];
}

export interface CostSummaryTilesProps {
  summary: CostSummary | undefined;
  isLoading: boolean;
  extraTiles: CostSummaryTile[];
}

export interface PeriodDelta {
  label: string;
  /** Never map to colour — a cost delta has no good/bad direction. Spending
   *  less is not inherently "good", so green-up/red-down would editorialise a
   *  fact. Kept only for callers that need the sign for non-colour purposes
   *  (e.g. an aria-label or a neutral glyph), not for styling. */
  direction: 'up' | 'down' | 'flat';
}

export function formatPeriodDelta(current: number, previous: number): PeriodDelta | null {
  // A percentage against zero is meaningless, not infinite. Show nothing.
  if (previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { label: '0%', direction: 'flat' };
  return { label: `${change > 0 ? '+' : ''}${change}%`, direction: change > 0 ? 'up' : 'down' };
}

/**
 * Grid dialect shared with session-cost-detail.tsx — the one divided-grid tile
 * treatment this product surface uses. Loading renders the same shape so the
 * layout never shifts once real figures arrive.
 *
 * The hairlines are the grid GAP, not `divide-x divide-y`. Tailwind's divide
 * utilities compile to `> * + *`, which is DOM order and knows nothing about
 * rows or columns: at three columns every tile after the first got a left
 * border AND a top border, so row one carried two stray horizontal rules and
 * the first tile of row two carried a dangling left border. A 1px gap over a
 * `bg-border` surface follows the real grid geometry instead, so there is no
 * dangling edge at any column count.
 *
 * The cost of that: an EMPTY grid track shows the container surface, i.e. a
 * block of border colour where a tile should be. `TILE_COLUMNS` and
 * `trailingFillerCount` below are what make that unreachable.
 */
const GRID_CLASS =
  'border-border bg-border grid grid-cols-3 gap-px overflow-hidden rounded-md border';

/** Each cell paints the card surface over the container's border colour —
 *  matching the `Table` and `CostModelList` panels this grid sits between. */
/**
 * `h-full flex-col` is what lets a tile's last row sit on its own bottom edge.
 *
 * Grid cells stretch to the tallest in the row, and the Total tile is tallest
 * because only it carries a delta. Without a full-height column the trailing
 * row lands directly under the value, so on the LLM and Compute tiles the
 * sparkline floats mid-tile with dead space beneath it — three lines that
 * should sit on one baseline, at three different heights.
 *
 * The alternative was absolutely positioning the sparkline into the corner.
 * That pins it correctly but takes it out of flow, so at three columns on a
 * narrow phone it would sit on top of the delta rather than beside it. Keeping
 * it in flow and pushing the row down with `mt-auto` gets the same corner
 * without the overlap.
 */
const TILE_CLASS = 'bg-popover flex h-full flex-col px-3 py-2.5';

/**
 * Three columns at every width, not `grid-cols-2 sm:grid-cols-3`.
 *
 * Two columns would leave the fixed three-tile case (Total / LLM / Compute)
 * with one empty track on mobile, which under the gap-px treatment renders as
 * a block of border colour rather than as nothing. The cells are a short label
 * over a small number, so three fit at mobile width.
 *
 * One count at every breakpoint is also what lets `trailingFillerCount` be
 * correct at all: filler is a render-time decision, and a responsive column
 * count would need a different number of fillers per breakpoint — which CSS
 * can express but this component cannot know.
 */
const TILE_COLUMNS = 3;

/**
 * How many empty cells the last row is short, so it can be filled.
 *
 * `CostSummaryTiles` renders `3 + extraTiles.length` tiles and `extraTiles` is
 * caller-supplied, so the count is not fixed at three even though no caller
 * passes any today. Four tiles at three columns leaves two empty tracks; under
 * the gap-px hairlines those are visible blocks of border colour, not blank
 * space. Painting them with the card surface makes the layout correct for
 * every tile count instead of only the counts that happen to divide evenly.
 */
export function trailingFillerCount(tileCount: number, columns: number): number {
  if (columns <= 0 || tileCount <= 0) return 0;
  return (columns - (tileCount % columns)) % columns;
}

/** The empty cells that keep the last row full. `aria-hidden` — they carry no
 *  content and exist only so no grid track shows the container surface. */
function TileFillers({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={`filler-${index}`} className={TILE_CLASS} aria-hidden="true" />
      ))}
    </>
  );
}

export function CostSummaryTiles({ summary, isLoading, extraTiles }: CostSummaryTilesProps) {
  if (isLoading || !summary) {
    const tileCount = 3 + extraTiles.length;
    return (
      <div className={GRID_CLASS} aria-label="Loading cost summary">
        {Array.from({ length: tileCount }).map((_, index) => (
          <div key={index} className={TILE_CLASS}>
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-2 h-5 w-16" />
          </div>
        ))}
        <TileFillers count={trailingFillerCount(tileCount, TILE_COLUMNS)} />
      </div>
    );
  }

  const delta = formatPeriodDelta(summary.totals.total_cost, summary.previous.total_cost);

  // Each tile draws its OWN metric's daily line, not a shared one. A Compute
  // tile showing the total's shape would be a chart that lies.
  const tiles: (CostSummaryTile & { delta?: PeriodDelta | null })[] = [
    {
      label: 'Total',
      value: formatSessionCostUsd(summary.totals.total_cost),
      delta,
      series: summary.series.map((point) => point.total_cost),
    },
    {
      label: 'LLM',
      value: formatSessionCostUsd(summary.totals.llm_cost),
      series: summary.series.map((point) => point.llm_cost),
    },
    {
      label: 'Compute',
      value: formatSessionCostUsd(summary.totals.compute_cost),
      series: summary.series.map((point) => point.compute_cost),
    },
    ...extraTiles,
  ];

  return (
    <div className={GRID_CLASS}>
      {tiles.map((tile) => (
        <div key={tile.label} className={cn('relative', TILE_CLASS)}>
          <p className="text-muted-foreground text-xs">{tile.label}</p>
          <p className="mt-0.5 font-mono text-sm font-medium tabular-nums">{tile.value}</p>
          {/* Delta and sparkline share one row rather than stacking, so the
              tile is three lines instead of four and the corner space carries
              the line. `items-end` is what anchors the sparkline to the
              bottom-right; `ml-auto` keeps it there on the LLM and Compute
              tiles, which have no delta beside it.

              "vs prior period" is dropped from the visible label — under a
              total, inside a range-scoped explorer, the comparison is the only
              thing a percentage could mean. It survives on the accessible
              name, where it costs no space.

              `tile.delta.direction` is still never read for styling, per the
              field's own doc comment. Direction becomes colour once per tile,
              on the sparkline, driven by that line's own series — the delta is
              a different measurement (this window against the one before it,
              not the shape within it) and the two can legitimately disagree,
              so tinting the number to agree with the line would assert
              something neither of them checked. */}
          {tile.delta || tile.series ? (
            // `mt-auto` drops this row onto the tile's bottom edge, so all
            // three sparklines share one baseline whatever sits above them.
            // `ml-auto` on the line is the only thing doing the right-align —
            // `justify-between` alongside it would be a second mechanism for
            // one job, and would left-align the line on the tiles that have no
            // delta beside it. Wrapping is the narrow-tile escape: at three
            // columns on a phone the delta and the line together exceed the
            // content width, and dropping to a second line degrades better
            // than overflowing the tile.
            <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1 pt-1.5">
              {tile.delta ? (
                <p
                  className="text-muted-foreground text-xs tabular-nums"
                  aria-label={`${tile.delta.label} versus the prior period`}
                >
                  {tile.delta.label}
                </p>
              ) : null}
              {tile.series ? (
                <span className="ml-auto absolute bottom-px right-px">
                  <CostSparkline values={tile.series} label={tile.label} />
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      <TileFillers count={trailingFillerCount(tiles.length, TILE_COLUMNS)} />
    </div>
  );
}
