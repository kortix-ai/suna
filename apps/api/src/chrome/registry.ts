/**
 * The control sockets this API replica holds, and how a frame reaches one.
 *
 * A replica delivers locally when it holds the socket. Otherwise it sends
 * `pg_notify('kortix_chrome_cmd', {chromeId, frame})` and the replica that
 * holds the socket delivers it (`shared/pg-broadcast.ts`).
 */
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { CHROME_COMMAND_CHANNEL, onChromeCommand } from '../shared/pg-broadcast';

export interface ChromeSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

// replica-local: a socket lives on the replica that accepted it; other
// replicas reach it through the NOTIFY below.
const sockets = new Map<string, ChromeSocket>();

export function registerSocket(chromeId: string, ws: ChromeSocket): void {
  const previous = sockets.get(chromeId);
  sockets.set(chromeId, ws);
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
export function unregisterSocket(chromeId: string, ws: ChromeSocket): boolean {
  if (sockets.get(chromeId) !== ws) return false;
  sockets.delete(chromeId);
  return true;
}

export function hasLocalSocket(chromeId: string): boolean {
  return sockets.has(chromeId);
}

function deliverLocal(chromeId: string, frame: unknown): boolean {
  const ws = sockets.get(chromeId);
  return ws ? applyFrame(ws, frame) : false;
}

/** Send one frame to a browser, on this replica or through the NOTIFY. */
export async function sendToChrome(chromeId: string, frame: unknown): Promise<void> {
  if (deliverLocal(chromeId, frame)) return;
  const payload = JSON.stringify({ chromeId, frame });
  await db.execute(sql`select pg_notify(${CHROME_COMMAND_CHANNEL}, ${payload})`);
}

/** Close a browser's control socket, here or on another replica. */
export async function closeChrome(chromeId: string, code: number, reason: string): Promise<void> {
  await sendToChrome(chromeId, { type: '__close', code, reason });
}

function onNotify(payload: string): void {
  let parsed: { chromeId?: unknown; frame?: unknown };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (typeof parsed.chromeId !== 'string') return;
  const ws = sockets.get(parsed.chromeId);
  if (!ws) return;
  applyFrame(ws, parsed.frame);
}

/** A `__close` frame closes the socket. Any other frame is sent as JSON. */
function applyFrame(ws: ChromeSocket, frame: unknown): boolean {
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

onChromeCommand(onNotify);
