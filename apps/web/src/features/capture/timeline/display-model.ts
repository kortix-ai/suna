/**
 * Displays and Live on the device timeline, as pure functions: which display
 * is active at the playhead, whether the playhead sits in a recording, what
 * Live says, and how all displays lay out side by side. No DOM here.
 *
 * Times are epoch ms.
 */
import type { DeviceStatusKey } from '../devices/device-status';

/** A focus span: `display_id` held the focused window from `s` to `e`. */
export interface FocusSpan {
  display_id: number;
  s: number;
  e: number;
}

/** A screen item (one per display): the time it covers. `display_id` is null from a one-display device. */
export interface ScreenItem {
  display_id: number | null;
  s: number;
  e: number;
}

/**
 * The display that held the focused window at `T`: the span holding `T`
 * (its end padded by one capture interval), else the last span before `T`.
 * Null before the first span.
 */
export function activeDisplayAt(
  focus: readonly FocusSpan[],
  T: number,
  pad: number,
): number | null {
  let last: FocusSpan | null = null;
  for (const span of focus) {
    if (span.s > T) break;
    last = span;
    if (T <= span.e + pad) return span.display_id;
  }
  return last?.display_id ?? null;
}

/**
 * Whether `T` is recorded on `displayId` (any display when null): inside a
 * screen item. A still screen writes no new frames, so "no frame near the
 * playhead" does not mean "not recorded"; the item's span does.
 */
export function coveredAt(
  items: readonly ScreenItem[],
  T: number,
  displayId: number | null,
): boolean {
  return items.some(
    (item) => (displayId === null || item.display_id === displayId) && item.s <= T && T <= item.e,
  );
}

/**
 * A still display writes a keep-alive frame every 30 s; the recorder ticks
 * every 2 s. A display is recorded from a frame until its next frame, for at
 * most this long.
 */
export const KEEPALIVE_MS = 32_000;

/** Whether `T` is recorded by the frame at `frameTs` (the last frame at or before `T`). */
export function recordedSince(frameTs: number | null, T: number): boolean {
  return frameTs !== null && T >= frameTs && T - frameTs <= KEEPALIVE_MS;
}

/** Behind the device by more than this, Live says it is uploading. */
export const LIVE_SLACK_MS = 15_000;

export type LiveState =
  | { kind: 'live' | 'uploading'; behindMs: number }
  | { kind: Exclude<DeviceStatusKey, 'recording'>; behindMs: number | null };

/**
 * What Live shows: the device's own status when it does not record (paused,
 * offline, a missing permission, …); while it records, `uploading` when the
 * newest indexed moment is behind the device's last frame, else `live`.
 */
export function liveState({
  status,
  lastFrameMs,
  newestIndexedMs,
  now,
}: {
  status: DeviceStatusKey;
  lastFrameMs: number | null;
  newestIndexedMs: number | null;
  now: number;
}): LiveState {
  const behindMs = newestIndexedMs === null ? null : Math.max(0, now - newestIndexedMs);
  if (status !== 'recording') return { kind: status, behindMs };
  if (newestIndexedMs === null) return { kind: 'uploading', behindMs: Number.POSITIVE_INFINITY };
  const deviceAhead = (lastFrameMs ?? now) - newestIndexedMs > LIVE_SLACK_MS;
  return { kind: deviceAhead ? 'uploading' : 'live', behindMs: behindMs ?? 0 };
}

export interface DisplayRect {
  id: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Every display in a `W` × `H` box, where they sit relative to each other
 * (points, global desktop space), scaled to fit and centred.
 */
export function displayLayout(
  displays: readonly { id: number; x: number; y: number; w: number; h: number }[],
  W: number,
  H: number,
): DisplayRect[] {
  if (!displays.length) return [];
  const minX = Math.min(...displays.map((d) => d.x));
  const minY = Math.min(...displays.map((d) => d.y));
  const spanW = Math.max(...displays.map((d) => d.x + d.w)) - minX;
  const spanH = Math.max(...displays.map((d) => d.y + d.h)) - minY;
  const scale = Math.min(W / spanW, H / spanH);
  const offX = (W - spanW * scale) / 2;
  const offY = (H - spanH * scale) / 2;
  return displays.map((d) => ({
    id: d.id,
    left: Math.round(offX + (d.x - minX) * scale),
    top: Math.round(offY + (d.y - minY) * scale),
    width: Math.round(d.w * scale),
    height: Math.round(d.h * scale),
  }));
}
