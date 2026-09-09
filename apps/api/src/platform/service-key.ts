import { eq } from 'drizzle-orm';
import { sandboxes, sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';

/**
 * The serviceKey == the sandbox's KORTIX_TOKEN — the bearer the daemon's
 * `/kortix/*` control routes (e.g. git/commit-push) authenticate against.
 *
 * Product sandboxes persist it in `sandboxes.config`; project-session
 * sandboxes persist it in `session_sandboxes.config`. resolveEndpoint must
 * check BOTH, or daemon control calls for session boxes 401 (which silently
 * dropped the working-tree flush on provider migration).
 */
/**
 * THE SERVICE KEY OF ONE SESSION, not of whatever box it happens to share.
 *
 * `serviceKeyForExternalId` answers "a key that reaches this box", which was the
 * same question until a cell sandbox started carrying several sessions. It is
 * not any more: it matches on `external_id` and takes the first row, so on a
 * shared cell host every session is handed the token of whichever session
 * created the box.
 *
 * MEASURED on dev 2026-09-09. A cell relayed its turn end with that token and
 * the control plane refused it —
 *
 *   POST /v1/projects/<id>/turn-stream  403  {"kind":"turn_end"}
 *
 * — because the route requires a sandbox token bound to the session it speaks
 * for. The ledger record then never closed: the cell reported
 * `turn_in_flight:false, turn_end:"completed"` while the API still held that
 * turn `active`, so the next prompt sat behind `turn_active` and the session
 * appeared to hang forever. That is the shape a user reports as "it takes
 * business days to load".
 *
 * Session-scoped, so a session always speaks with its own authority.
 */
export async function serviceKeyForSession(sessionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  return (row?.config as Record<string, unknown> | undefined)?.serviceKey as string | undefined;
}

export async function serviceKeyForExternalId(externalId: string): Promise<string | undefined> {
  const [sb] = await db
    .select({ config: sandboxes.config })
    .from(sandboxes)
    .where(eq(sandboxes.externalId, externalId))
    .limit(1);
  const fromSandboxes = (sb?.config as Record<string, unknown> | undefined)?.serviceKey as string | undefined;
  if (fromSandboxes) return fromSandboxes;

  const [ss] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  return (ss?.config as Record<string, unknown> | undefined)?.serviceKey as string | undefined;
}
