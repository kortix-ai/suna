// How the agent cursor moves (protocol.md §7, "Visible state"). Pure, so the
// unit tests pin the motion without a page. Points are viewport CSS pixels,
// the same frame as Input.dispatchMouseEvent x/y.
export type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };

/** The shortest and the longest glide. A longer trip takes longer, like a hand. */
export const GLIDE_MIN_MS = 180;
export const GLIDE_MAX_MS = 650;
const MS_PER_PX = 0.4;
/** Below this distance the cursor jumps: a re-sent point or a drag step. */
const JUMP_PX = 3;
/** How far the arc bows off the straight line, as a share of the trip, and its cap. */
const BOW = 0.12;
const BOW_MAX_PX = 60;

export function glideMs(from: Point, to: Point): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d < JUMP_PX ? 0 : Math.round(Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + d * MS_PER_PX));
}

const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** The point at progress t (0 to 1): a shallow arc, eased in and out. */
export function glidePoint(from: Point, to: Point, t: number): Point {
  const e = ease(Math.min(1, Math.max(0, t)));
  if (e === 1) return to;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = Math.min(BOW * len, BOW_MAX_PX);
  // The control point is the midpoint, pushed to the left of the direction of travel.
  const cx = from.x + dx / 2 + (dy / len) * bow, cy = from.y + dy / 2 - (dx / len) * bow;
  const u = 1 - e;
  return { x: u * u * from.x + 2 * u * e * cx + e * e * to.x, y: u * u * from.y + 2 * u * e * cy + e * e * to.y };
}

/** A client can click a point outside the viewport: draw the cursor at the nearest edge. */
export const clampPoint = (p: Point, width: number, height: number): Point => ({
  x: Math.min(Math.max(p.x, 0), Math.max(0, width - 1)),
  y: Math.min(Math.max(p.y, 0), Math.max(0, height - 1)),
});

/** Where the cursor rests to type into a field: inside it, on the start of the first line. */
export function typingPoint(box: Box, width: number, height: number): Point | undefined {
  if (box.width <= 0 || box.height <= 0) return undefined;
  if (box.left + box.width <= 0 || box.top + box.height <= 0 || box.left >= width || box.top >= height) return undefined;
  return clampPoint({ x: box.left + Math.min(16, box.width / 2), y: box.top + Math.min(box.height / 2, 18) }, width, height);
}

export const inside = (p: Point, box: Box, margin = 4) =>
  p.x >= box.left - margin && p.x <= box.left + box.width + margin && p.y >= box.top - margin && p.y <= box.top + box.height + margin;
