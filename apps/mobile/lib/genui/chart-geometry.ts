/** Pure chart geometry for react-native-svg. No React, no theme: unit-tested under Bun. */

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  series: number;
  index: number;
}

const finite = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Upper bound of the value axis: the largest value, never 0 (an all-zero chart still draws an axis). */
export function axisMax(series: number[][]): number {
  const max = Math.max(0, ...series.flat().map(finite));
  return max > 0 ? max : 1;
}

/** A bar wider than this reads as a block, not a mark. */
const MAX_BAR = 48;

/**
 * Grouped bars: one group per category, one bar per series, bottom-aligned to `height`.
 * Each group keeps 20% of its category free and is centered in it, so groups never touch;
 * `gap` (between bars of one group) shrinks when a narrow phone has no room for it.
 */
export function barRects(series: number[][], categories: number, width: number, height: number, gap = 4): BarRect[] {
  if (categories === 0 || series.length === 0) return [];
  const max = axisMax(series);
  const n = series.length;
  const groupWidth = width / categories;
  const room = groupWidth * 0.8;
  const between = n > 1 ? Math.min(gap, room / (2 * n)) : 0;
  const barWidth = Math.min(MAX_BAR, (room - between * (n - 1)) / n);
  const inset = (groupWidth - (n * barWidth + (n - 1) * between)) / 2;
  const rects: BarRect[] = [];
  for (let index = 0; index < categories; index++) {
    series.forEach((values, s) => {
      const value = Math.max(0, finite(values[index]));
      const barHeight = (value / max) * height;
      rects.push({
        x: index * groupWidth + inset + s * (barWidth + between),
        y: height - barHeight,
        width: barWidth,
        height: barHeight,
        series: s,
        index,
      });
    });
  }
  return rects;
}

/** A bar as a path: top corners rounded by up to `radius`, square where it meets the baseline. */
export function barPath({ x, y, width, height }: BarRect, radius: number): string {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  const f = (n: number) => n.toFixed(2);
  const bottom = y + height;
  return `M${f(x)},${f(bottom)} V${f(y + r)} A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)} H${f(x + width - r)} A${f(r)},${f(r)} 0 0 1 ${f(x + width)},${f(y + r)} V${f(bottom)} Z`;
}

/**
 * SVG path through `values` on `count` evenly spaced x slots across `width`
 * (one slot per x label, so a series shorter than the labels does not stretch).
 */
export function linePath(values: number[], width: number, height: number, max: number, count = values.length): string {
  if (values.length === 0) return '';
  const step = count > 1 ? width / (count - 1) : 0;
  return values
    .map((value, i) => {
      const x = count > 1 ? i * step : width / 2;
      const y = height - (Math.max(0, finite(value)) / max) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Donut slices as SVG paths centered on (r, r). A single non-zero slice draws a full ring. */
export function pieArcs(values: number[], radius: number, inner: number): { path: string; index: number }[] {
  const clean = values.map((v) => Math.max(0, finite(v)));
  const total = clean.reduce((sum, v) => sum + v, 0);
  if (total === 0) return [];
  const point = (angle: number, r: number) => [radius + r * Math.sin(angle), radius - r * Math.cos(angle)] as const;
  const arcs: { path: string; index: number }[] = [];
  let start = 0;
  clean.forEach((value, index) => {
    if (value === 0) return;
    // A full circle cannot be one arc command: stop just short of 2π.
    const sweep = Math.min((value / total) * Math.PI * 2, Math.PI * 2 - 1e-4);
    const end = start + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = point(start, radius);
    const [x1, y1] = point(end, radius);
    const [x2, y2] = point(end, inner);
    const [x3, y3] = point(start, inner);
    arcs.push({
      index,
      path: `M${x0.toFixed(2)},${y0.toFixed(2)} A${radius},${radius} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${inner},${inner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`,
    });
    start = end;
  });
  return arcs;
}
