/**
 * "The box behind this runtime URL no longer exists."
 *
 * The runtime proxy answers `404 {"error":"sandbox not found"}` when no
 * session row carries the external id in the URL any more. For a session whose
 * box was replaced (a stop that deleted it, then a wake that booted a new one)
 * that is a definitive answer, not a transport blip: no retry of the same URL
 * can ever succeed, and only `/start` knows the new box. The health poller
 * reports it here; `useSession` refetches `/start` when it hears it.
 *
 * Framework-free, and not part of the public surface.
 */

type Listener = (runtimeUrl: string) => void;

const listeners = new Set<Listener>();

/** Whether a proxy response says the sandbox behind the URL is gone. */
export function isRuntimeGoneResponse(status: number, body: string): boolean {
  return status === 404 && /sandbox not found/i.test(body);
}

export function noteRuntimeGone(runtimeUrl: string): void {
  for (const listener of listeners) listener(runtimeUrl);
}

export function onRuntimeGone(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
