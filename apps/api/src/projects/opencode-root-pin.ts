/**
 * WHICH ROOT SESSION A RUNTIME'S TRANSCRIPT LIVES UNDER.
 *
 * For an OpenCode box the answer has to be discovered: the daemon owns its own
 * session ids, so the control plane lists `GET /session` and pins one.
 *
 * FOR A CELL IT MUST NOT BE. A cell is addressed BY the session — the worker
 * reads it from `?c=` or from the path (`/session/:id/...`) — so the root is the
 * Kortix session id by construction, and asking the box which sessions it has
 * is both unnecessary and, on a shared host, WRONG.
 *
 * MEASURED on dev 2026-09-08, with one cell sandbox serving a project's
 * sessions (KORTIX_CELL_SHARED_HOST_ENABLED): `GET /session` carries no session
 * anywhere in the request, so it fell through to the worker's default cell, and
 * every session pinned that same root —
 *
 *   session_id                            opencode_session_id
 *   39a93b79-eef4-49f0-9175-af8e102ab15d  b673ad47-4365-4ab4-951d-0b592f9b9423
 *   40c2f0db-2b3f-49ac-8f68-9acf43749f4d  b673ad47-4365-4ab4-951d-0b592f9b9423
 *   001d2d4d-d330-4e84-9a75-ef79d5308b91  b673ad47-4365-4ab4-951d-0b592f9b9423
 *
 * — so three sessions that had each sent ONE prompt every showed the same ten
 * user/assistant pairs. Sessions in a project were reading each other's
 * conversations. It also made every session look instant, because a new one
 * found somebody else's answer already there; a "542 ms end to end" measurement
 * taken that way was reading the leak, not the session.
 *
 * `cell-host-platinum.ts` fixed addressing for the routes that carry an id.
 * This is the step that has none to carry.
 *
 * For a cell that is NOT shared this changes nothing: the box is named for its
 * session, so discovery already returned exactly this id — it just cost a round
 * trip to learn it.
 */

/**
 * The root to pin without asking the box, or null when it must be discovered.
 *
 * Pure, so both branches are asserted rather than reproduced with two sessions
 * on one sandbox.
 */
export function rootPinWithoutDiscovery(
  runtime: string | null | undefined,
  sessionId: string,
): string | null {
  if (String(runtime ?? '').toLowerCase() !== 'cell') return null;
  const id = sessionId?.trim();
  return id ? id : null;
}
