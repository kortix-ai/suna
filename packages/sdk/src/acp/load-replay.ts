import type { AcpStoredEnvelope } from './transcript';

// Live SSE delivers `session/load` replay notifications to AcpSession without
// echoing the client-originated load request itself. Keep an in-memory marker
// on those exact row objects so every projection of the active snapshot sees
// the same classification. Weak membership adds no serialized metadata to the
// lossless row and disappears with the session; persisted history is classified
// independently by reduce.ts's request/response scope tracking.
const LIVE_SESSION_LOAD_REPLAY_ROWS = new WeakSet<AcpStoredEnvelope>();

export function markLiveSessionLoadReplay(row: AcpStoredEnvelope): void {
  LIVE_SESSION_LOAD_REPLAY_ROWS.add(row);
}

export function isLiveSessionLoadReplay(row: AcpStoredEnvelope): boolean {
  return LIVE_SESSION_LOAD_REPLAY_ROWS.has(row);
}
