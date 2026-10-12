/**
 * The control sockets this API replica holds, and how a frame reaches one.
 *
 * A replica delivers locally when it holds the socket. Otherwise it sends
 * `pg_notify('kortix_browser_cmd', {browserId, frame})` and the replica that
 * holds the socket delivers it (`shared/pg-broadcast.ts`).
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { BROWSER_COMMAND_CHANNEL, onBrowserCommand } from '../shared/pg-broadcast';

export interface BrowserSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

// replica-local: a socket lives on the replica that accepted it; other
// replicas reach it through the NOTIFY below.
const sockets = new Map<string, BrowserSocket>();

export function registerSocket(browserId: string, ws: BrowserSocket): void {
  const previous = sockets.get(browserId);
  sockets.set(browserId, ws);
  // One control socket per browser. The newest connection wins.
  if (previous && previous !== ws) {
    try {
      previous.close(4000, 'replaced by a newer connection');
    } catch {
      // Already closed.
    }
  }
}

/** Remove the entry, but only if `ws` is still the registered socket. */
/** True when `ws` was the browser's current socket here (not one a reconnect already replaced). */
export function unregisterSocket(browserId: string, ws: BrowserSocket): boolean {
  if (sockets.get(browserId) !== ws) return false;
  sockets.delete(browserId);
  return true;
}

export function hasLocalSocket(browserId: string): boolean {
  return sockets.has(browserId);
}

function deliverLocal(browserId: string, frame: unknown): boolean {
  const ws = sockets.get(browserId);
  return ws ? applyFrame(ws, frame) : false;
}

/** Send one frame to a browser, on this replica or through the NOTIFY. */
export async function sendToBrowser(browserId: string, frame: unknown): Promise<void> {
  if (deliverLocal(browserId, frame)) return;
  const payload = JSON.stringify({ browserId, frame });
  await db.execute(sql`select pg_notify(${BROWSER_COMMAND_CHANNEL}, ${payload})`);
}

/** Close a browser's control socket, here or on another replica. */
export async function closeBrowser(browserId: string, code: number, reason: string): Promise<void> {
  await sendToBrowser(browserId, { type: '__close', code, reason });
}

function onNotify(payload: string): void {
  let parsed: { browserId?: unknown; frame?: unknown };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (typeof parsed.browserId !== 'string') return;
  const ws = sockets.get(parsed.browserId);
  if (!ws) return;
  applyFrame(ws, parsed.frame);
}

/** A `__close` frame closes the socket. Any other frame is sent as JSON. */
function applyFrame(ws: BrowserSocket, frame: unknown): boolean {
  const f = frame as { type?: string; code?: number; reason?: string } | null;
  try {
    if (f?.type === '__close') ws.close(f.code ?? 1000, f.reason ?? '');
    else ws.send(JSON.stringify(frame));
    return true;
  } catch {
    // The socket closed between lookup and send.
    return false;
  }
}

onBrowserCommand(onNotify);
