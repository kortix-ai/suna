import type { CaptureDevice } from '@kortix/sdk';

/** A piece of a search snippet. The API wraps matches in `<b>…</b>`; the rest is plain text. */
export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Splits a snippet into text and matches. Frame text comes from a screen, so
 * the snippet is never rendered as HTML: every part is a React text node.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  for (const piece of snippet.split(/(<b>[\s\S]*?<\/b>)/)) {
    if (!piece) continue;
    const match = piece.startsWith('<b>') && piece.endsWith('</b>');
    parts.push({ text: match ? piece.slice(3, -4) : piece, match });
  }
  return parts;
}

/** `YYYY-MM-DD` in the local time zone. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local-day bounds [from, to) of a `YYYY-MM-DD` string, as ISO instants. */
export function dayBounds(day: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number);
  return {
    from: new Date(y, m - 1, d).toISOString(),
    to: new Date(y, m - 1, d + 1).toISOString(),
  };
}

/** Where a chunk sits on a 24 h track, in percent. Clipped to the day. */
export function chunkSpan(
  chunk: { started_at: string; ended_at: string },
  day: string,
): { left: number; width: number } {
  const { from, to } = dayBounds(day);
  const start = Date.parse(from);
  const length = Date.parse(to) - start;
  const left = Math.max(0, (Date.parse(chunk.started_at) - start) / length);
  const right = Math.min(1, (Date.parse(chunk.ended_at) - start) / length);
  return { left: left * 100, width: Math.max(0.4, (right - left) * 100) };
}

/** Whether the recorder on this device is paused right now. */
export function isPaused(device: Pick<CaptureDevice, 'paused_until'>, now = Date.now()): boolean {
  return device.paused_until !== null && Date.parse(device.paused_until) > now;
}

export type DeviceStatus = 'recording' | 'paused' | 'off' | 'workspace_off';

export function deviceStatus(
  device: Pick<CaptureDevice, 'enabled' | 'paused_until' | 'account_enabled'>,
  now = Date.now(),
): DeviceStatus {
  if (!device.account_enabled) return 'workspace_off';
  if (!device.enabled) return 'off';
  return isPaused(device, now) ? 'paused' : 'recording';
}

/** Owners and admins manage a workspace; members do not. */
export function isManagerRole(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
