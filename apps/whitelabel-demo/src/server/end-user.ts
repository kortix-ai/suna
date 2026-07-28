/**
 * Kortix-as-a-Backend: vouching for Lumen's own end-user.
 *
 * In wrapper mode every upstream call is made with ONE credential — the
 * wrapper's `KORTIX_API_KEY` — so upstream cannot tell Lumen's users apart on
 * its own. `end_user_ref` is how we tell it, and it drives per-end-user usage
 * attribution, idempotency-replay protection, and the optional per-end-user
 * concurrency cap.
 *
 * It is injected HERE, server-side, from the authenticated session — never
 * accepted from the browser. A client that could set it could bill another
 * user, or replay their session through a shared Idempotency-Key.
 */

/** `POST /projects/{projectId}/sessions` — the only call that opens a session. */
const SESSION_CREATE = /^projects\/[^/]+\/sessions\/?$/;

export function isSessionCreate(method: string, upstreamPath: string): boolean {
  return method.toUpperCase() === 'POST' && SESSION_CREATE.test(upstreamPath);
}

export type EndUserInjection =
  | { action: 'inject'; body: Record<string, unknown> }
  | { action: 'reject'; reason: string }
  | { action: 'passthrough' };

/**
 * Decide what to send upstream for a session create.
 *
 * A browser-supplied `end_user_ref` (or its deprecated `origin_ref` alias) that
 * disagrees with the signed-in user is REJECTED rather than overwritten: it
 * means the client is trying to act as somebody else, and silently correcting it
 * would hide an attack rather than surface it. Agreeing values pass through, so
 * a client that echoes its own id is not punished for it.
 */
export function injectEndUserRef(
  body: unknown,
  userId: string,
): EndUserInjection {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { action: 'passthrough' };
  }
  const record = body as Record<string, unknown>;
  const claimed = [record.end_user_ref, record.origin_ref].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (typeof claimed === 'string' && claimed.trim() !== userId) {
    return {
      action: 'reject',
      reason: 'end_user_ref must not be set by the client — it is derived from your session',
    };
  }
  return {
    action: 'inject',
    // Drop the legacy alias so upstream never sees both spellings and has to
    // adjudicate; we send exactly one, canonical value.
    body: { ...record, end_user_ref: userId, origin_ref: undefined },
  };
}
