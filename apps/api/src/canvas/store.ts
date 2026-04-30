/**
 * In-memory canvas event store.
 * Keyed by session_id. Capped at 100 events per session (FIFO eviction).
 */

import type { CanvasMessage } from './types';

const MAX_EVENTS_PER_SESSION = 100;
const store = new Map<string, CanvasMessage[]>();

export function storeCanvasEvent(sessionId: string, message: CanvasMessage): void {
  const events = store.get(sessionId) ?? [];
  events.push(message);
  if (events.length > MAX_EVENTS_PER_SESSION) events.shift();
  store.set(sessionId, events);
}

export function getCanvasEvents(sessionId: string): CanvasMessage[] {
  return store.get(sessionId) ?? [];
}

export function clearCanvasEvents(sessionId: string): void {
  store.delete(sessionId);
}
