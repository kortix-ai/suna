import { createContext } from 'react';

import { track } from '@/lib/track';

import type { GenuiBlockEvent } from './sdk';

/**
 * `genui_block` telemetry, outside the lazy block chunk. The markdown code renderer imports this
 * module statically, so a block counts as watched even when its chunk loads after the turn ends.
 */

/** The turn a block belongs to. The session transcript provides it once per turn. */
export interface GenuiTelemetryScope {
  /** Stable per turn: the streaming render and the settled render share it. */
  scope: string;
  /** The model that wrote the turn, when the message says. */
  model?: string;
}

export const GenuiTelemetryContext = createContext<GenuiTelemetryScope | null>(null);

// ponytail: per-tab sets that only grow, a few bytes per turn and per block; no eviction needed.
const watched = new Set<string>();
const reported = new Set<string>();

/** The viewer saw this turn stream. Only blocks of watched turns report: history loads do not. */
export function markGenuiWatched(scope: string): void {
  watched.add(scope);
}

/** FNV-1a: a short dedupe key for a block body (up to 64 KB). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * One `genui_block` event per block of a watched turn. The settled block reports, whichever render
 * of it settles first: the streaming one when its fence closes, or the one the host mounts after
 * the turn ends. Dedupe key: turn + block body. Never sends content.
 */
export function reportGenuiBlock(
  telemetry: GenuiTelemetryScope | null,
  code: string,
  event: GenuiBlockEvent,
  cutOff: boolean,
): void {
  if (!telemetry || !watched.has(telemetry.scope)) return;
  const key = `${telemetry.scope}:${hash(code.trim())}`;
  if (reported.has(key)) return;
  reported.add(key);
  track('genui_block', {
    outcome: event.outcome,
    components: event.components.join(','),
    ms_to_first_paint: event.msToFirstPaint ?? -1,
    issue_count: event.issueCount,
    cut_off: cutOff,
    platform: 'web',
    ...(telemetry.model ? { model: telemetry.model } : {}),
  });
}
