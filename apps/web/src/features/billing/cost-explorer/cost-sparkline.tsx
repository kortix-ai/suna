import { cn } from '@/lib/utils';

/** Which way spend moved across the window the sparkline draws. */
export type SparklineTrend = 'up' | 'down' | 'flat';

/** Rendered size. Deliberately small — it sits in the corner of a tile as
 *  context for the figure, not as a chart competing with it. */
const WIDTH = 44;
const HEIGHT = 14;

/**
 * The direction of a series, from the mean of its first half against the mean
 * of its second half.
 *
 * Not first-point-against-last: a single quiet day at either end would then
 * decide the trend for the whole window, and daily spend is spiky (one long
 * session dominates a day). Halves average that noise out.
 *
 * `flat` is a real answer, not a fallback — an unchanged spend line should read
 * as neither good nor bad, so it stays uncoloured.
 */
export function seriesTrend(values: number[]): SparklineTrend {
  if (values.length < 2) return 'flat';

  const mid = Math.floor(values.length / 2);
  const mean = (slice: number[]) =>
    slice.length === 0 ? 0 : slice.reduce((sum, n) => sum + n, 0) / slice.length;

  const first = mean(values.slice(0, mid));
  const second = mean(values.slice(mid));

  // Equal means are flat, and so is any difference too small to be a real
  // movement — floating-point sums of money rarely land exactly equal.
  const spread = Math.max(Math.abs(first), Math.abs(second));
  if (spread === 0) return 'flat';
  const change = (second - first) / spread;
  if (Math.abs(change) < 0.01) return 'flat';

  return change > 0 ? 'up' : 'down';
}

/**
 * A smooth SVG path through the series, normalised into a WIDTH x HEIGHT box.
 *
 * The curve is Catmull-Rom rendered as cubic Béziers: each segment's control
 * points are derived from the neighbouring points, so the line passes through
 * every data point exactly rather than being approximated near them. A
 * spend figure the curve misses would be a chart that lies.
 *
 * Control-point Y is clamped to the box. Catmull-Rom overshoots around a sharp
 * peak — a spike day would bow the curve above the window's real maximum,
 * drawing spend that was never billed. Clamping costs a little smoothness at
 * the extremes and buys a line that never claims more than the data.
 *
 * A flat series is drawn along the vertical middle rather than at y=0: a line
 * pinned to the top edge would read as "at maximum" when it means "never varied".
 */
export function sparklinePath(values: number[], width = WIDTH, height = HEIGHT): string {
  if (values.length < 2) return '';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = width / (values.length - 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  const clampY = (y: number) => Math.max(0, Math.min(height, y));

  const points = values.map((value, index) => ({
    x: index * step,
    // SVG y grows downward, so a high value needs a small y.
    y: span === 0 ? height / 2 : height - ((value - min) / span) * height,
  }));

  let path = `M ${round(points[0].x)},${round(points[0].y)}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const previous = points[i - 1] ?? points[i];
    const start = points[i];
    const end = points[i + 1];
    const following = points[i + 2] ?? end;

    // Catmull-Rom -> cubic Bézier: the 1/6 factor is what makes the converted
    // curve pass through `start` and `end` rather than merely near them.
    const control1 = {
      x: start.x + (end.x - previous.x) / 6,
      y: clampY(start.y + (end.y - previous.y) / 6),
    };
    const control2 = {
      x: end.x - (following.x - start.x) / 6,
      y: clampY(end.y - (following.y - start.y) / 6),
    };

    path += ` C ${round(control1.x)},${round(control1.y)} ${round(control2.x)},${round(control2.y)} ${round(end.x)},${round(end.y)}`;
  }

  return path;
}

/**
 * Colour carries cost semantics, which are the inverse of a revenue chart:
 * **rising spend is the alarming direction.** A FinOps reader is trying to
 * push this line down, so up is `kortix-red` and down is `kortix-green`.
 *
 * This is the only coloured element on a tile. The figure and its delta stay
 * neutral, so the tile spends its accent once — on the one element whose whole
 * job is to show direction.
 */
const TREND_STROKE: Record<SparklineTrend, string> = {
  up: 'text-kortix-red',
  down: 'text-kortix-green',
  flat: 'text-muted-foreground/60',
};

const TREND_DESCRIPTION: Record<SparklineTrend, string> = {
  up: 'trending up',
  down: 'trending down',
  flat: 'flat',
};

export interface CostSparklineProps {
  /** One value per day across the selected window, oldest first. */
  values: number[];
  /** Names the metric in the accessible description, e.g. "LLM". */
  label: string;
}

export function CostSparkline({ values, label }: CostSparklineProps) {
  // Two points is the minimum that can show a direction. One point is a dot
  // pretending to be a trend — the spend chart applies the same floor.
  const path = sparklinePath(values);
  if (!path) return null;

  const trend = seriesTrend(values);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      // Not decoration — it is the only trend signal on the LLM and Compute
      // tiles, so it gets a real accessible name. `role="img"` is what makes
      // `aria-label` reliably exposed here; on a bare element it is not.
      role="img"
      aria-label={`${label} spend ${TREND_DESCRIPTION[trend]} over the selected range`}
      className={cn('shrink-0 overflow-visible scale-125 origin-bottom-right', TREND_STROKE[trend])}
      preserveAspectRatio="none"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Keeps the stroke an even 1.5px after `preserveAspectRatio="none"`
        // stretches the box — without it the line thins horizontally and
        // thickens vertically.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
