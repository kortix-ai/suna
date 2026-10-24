/** Pure chart geometry for react-native-svg. No React, no theme: unit-tested under Bun. */

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  series: number;
  index: number;
  /** Below the zero line: the bar hangs down from it, so its rounded end is the bottom. */
  negative: boolean;
}

/** The value axis: `min` to `max` (the outer ticks), and the ticks between them. */
export interface ValueScale {
  min: number;
  max: number;
  ticks: number[];
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The value axis, as Recharts' default YAxis draws it on web: it spans min(0, lowest) to max(0, highest),
 * rounded out to about `count` ticks on a 1, 2, 2.5 or 5 step. 0 is always a tick, so the zero line is a
 * grid line. No data: one 0 tick on a 0..1 domain, so the plot still scales but prints no made-up max.
 */
export function valueScale(series: number[][], count = 5): ValueScale {
  const values = series.flat().map(finite);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  if (low === high) return { min: 0, max: 1, ticks: [0] };
  const raw = (high - low) / (count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  const first = Math.floor(low / step);
  const last = Math.ceil(high / step);
  // toPrecision drops float noise such as 0.30000000000000004.
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step).toPrecision(12)));
  return { min: ticks[0]!, max: ticks.at(-1)!, ticks };
}

/** The y of 0 on a plot `height` tall. */
export function zeroY({ min, max }: Pick<ValueScale, 'min' | 'max'>, height: number): number {
  return (max / (max - min)) * height;
}

/** A tick label as web formats it: Intl compact notation (1.5K, 2M). */
export function compactNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { notation: 'compact' }).format(value);
  } catch {
    return value.toLocaleString();
  }
}

/** A bar wider than this reads as a block, not a mark. */
const MAX_BAR = 48;

/**
 * Grouped bars: one group per category, one bar per series, growing up (or, below 0, down) from the zero line.
 * Each group keeps 20% of its category free and is centered in it, so groups never touch;
 * `gap` (between bars of one group) shrinks when a narrow phone has no room for it.
 */
export function barRects(
  series: number[][],
  categories: number,
  width: number,
  height: number,
  domain: Pick<ValueScale, 'min' | 'max'>,
  gap = 4,
): BarRect[] {
  if (categories === 0 || series.length === 0) return [];
  const zero = zeroY(domain, height);
  const scale = height / (domain.max - domain.min);
  const n = series.length;
  const groupWidth = width / categories;
  const room = groupWidth * 0.8;
  const between = n > 1 ? Math.min(gap, room / (2 * n)) : 0;
  const barWidth = Math.min(MAX_BAR, (room - between * (n - 1)) / n);
  const inset = (groupWidth - (n * barWidth + (n - 1) * between)) / 2;
  const rects: BarRect[] = [];
  for (let index = 0; index < categories; index++) {
    series.forEach((values, s) => {
      const value = finite(values[index]);
      const barHeight = Math.abs(value) * scale;
      rects.push({
        x: index * groupWidth + inset + s * (barWidth + between),
        y: value < 0 ? zero : zero - barHeight,
        width: barWidth,
        height: barHeight,
        series: s,
        index,
        negative: value < 0,
      });
    });
  }
  return rects;
}

/** A bar as a path: the end away from 0 rounded by up to `radius`, square where it meets the zero line. */
export function barPath({ x, y, width, height, negative }: BarRect, radius: number): string {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  const f = (n: number) => n.toFixed(2);
  const bottom = y + height;
  if (negative) {
    return `M${f(x)},${f(y)} V${f(bottom - r)} A${f(r)},${f(r)} 0 0 0 ${f(x + r)},${f(bottom)} H${f(x + width - r)} A${f(r)},${f(r)} 0 0 0 ${f(x + width)},${f(bottom - r)} V${f(y)} Z`;
  }
  return `M${f(x)},${f(bottom)} V${f(y + r)} A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)} H${f(x + width - r)} A${f(r)},${f(r)} 0 0 1 ${f(x + width)},${f(y + r)} V${f(bottom)} Z`;
}

/**
 * SVG path through `values` on `count` evenly spaced x slots across `width`
 * (one slot per x label, so a series shorter than the labels does not stretch).
 * A missing (non-finite) value is a gap, as on web: the path breaks there and the next point starts a new segment.
 */
export function linePath(
  values: number[],
  width: number,
  height: number,
  { min, max }: Pick<ValueScale, 'min' | 'max'>,
  count = values.length,
): string {
  const step = count > 1 ? width / (count - 1) : 0;
  const parts: string[] = [];
  let open = false;
  // A plain loop: forEach skips the holes of a sparse array, which would join across a gap.
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      open = false;
      continue;
    }
    const x = count > 1 ? i * step : width / 2;
    const y = ((max - value) / (max - min)) * height;
    parts.push(`${open ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`);
    open = true;
  }
  return parts.join(' ');
}

/**
 * Pie, donut, ring or half-ring slices as SVG paths centered on (r, r). Angles run clockwise from 12
 * o'clock: `start` -π/2 with `span` π is a gauge from 9 o'clock over the top to 3. `inner` 0 is a full pie.
 * A single non-zero slice of a full circle draws a whole ring.
 */
export function pieArcs(
  values: number[],
  radius: number,
  inner: number,
  start = 0,
  span = Math.PI * 2,
): { path: string; index: number }[] {
  const clean = values.map((v) => Math.max(0, finite(v)));
  const total = clean.reduce((sum, v) => sum + v, 0);
  if (total === 0) return [];
  const point = (angle: number, r: number) => [radius + r * Math.sin(angle), radius - r * Math.cos(angle)] as const;
  const arcs: { path: string; index: number }[] = [];
  let from = start;
  clean.forEach((value, index) => {
    if (value === 0) return;
    // A full circle cannot be one arc command: stop just short of 2π.
    const sweep = Math.min((value / total) * span, Math.PI * 2 - 1e-4);
    const end = from + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = point(from, radius);
    const [x1, y1] = point(end, radius);
    const [x2, y2] = point(end, inner);
    const [x3, y3] = point(from, inner);
    arcs.push({
      index,
      path: `M${x0.toFixed(2)},${y0.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`,
    });
    from = end;
  });
  return arcs;
}

export type PieVariant = 'donut' | 'focus' | 'ring' | 'treemap' | 'gauge' | 'stack';
const PIE_VARIANTS: readonly PieVariant[] = ['donut', 'focus', 'ring', 'treemap', 'gauge', 'stack'];

/** The model's layout when it names a known one; else a gauge for two slices (used against left), a donut otherwise. */
export function pieVariant(variant: unknown, slices: number): PieVariant {
  return PIE_VARIANTS.includes(variant as PieVariant) ? (variant as PieVariant) : slices === 2 ? 'gauge' : 'donut';
}

/**
 * The category a tap at `x` (plot coordinates) lands on. Bars: the group under the finger. Lines: the
 * nearest point. Taps outside the plot clamp to the first or last category.
 */
export function pickIndex(x: number, width: number, count: number, line: boolean): number {
  if (count <= 1 || width <= 0) return 0;
  const raw = line ? Math.round((x / width) * (count - 1)) : Math.floor(x / (width / count));
  return Math.min(count - 1, Math.max(0, raw));
}
