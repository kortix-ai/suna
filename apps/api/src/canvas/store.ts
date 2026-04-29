/**
 * In-memory canvas event store.
 *
 * Canvas events (pr_summary, table, doc, etc.) are stored here keyed by
 * session_id. The frontend polls GET /v1/canvas/:sessionId or subscribes
 * to the SSE stream at GET /v1/canvas/:sessionId/stream to render cards.
 *
 * Events are capped at 100 per session (oldest evicted) to bound memory.
 */

import type { CanvasMessage } from './types';

const MAX_EVENTS_PER_SESSION = 100;

// Map<sessionId, CanvasMessage[]>
const store = new Map<string, CanvasMessage[]>();

export function storeCanvasEvent(sessionId: string, message: CanvasMessage): void {
  const events = store.get(sessionId) ?? [];
  events.push(message);
  if (events.length > MAX_EVENTS_PER_SESSION) {
    events.shift(); // evict oldest
  }
  store.set(sessionId, events);
}

export function getCanvasEvents(sessionId: string): CanvasMessage[] {
  return store.get(sessionId) ?? [];
}

export function clearCanvasEvents(sessionId: string): void {
  store.delete(sessionId);
}
