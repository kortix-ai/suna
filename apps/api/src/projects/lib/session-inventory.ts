import {
  isProjectSessionVisibleTo,
  type SecretGrant,
  type ShareSubject,
} from '../../connectors/share';
import type { projectSessions, sessionSandboxes } from '@kortix/db';
import { isWarmProjectSession } from './warm-sessions';

type ProjectSessionRow = typeof projectSessions.$inferSelect;
type RuntimeStatus = typeof sessionSandboxes.$inferSelect.status;

export type ProjectSessionListScope = 'visible' | 'project';

export interface SessionInventoryItem {
  row: ProjectSessionRow;
  canAccess: boolean;
  runtimeStatus: RuntimeStatus | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface SessionOwnerIdentity {
  type: 'user' | 'service_account' | 'unknown';
  name: string | null;
  email: string | null;
}

export function mergeSessionOwnerIdentities(input: {
  ownerIds: string[];
  users: Map<
    string,
    { exists: boolean; email: string | null; displayName?: string | null }
  >;
  serviceAccounts: Array<{
    serviceAccountId: string;
    name: string;
    agentName: string | null;
  }>;
}): Map<string, SessionOwnerIdentity> {
  const serviceAccounts = new Map(
    input.serviceAccounts.map((identity) => [
      identity.serviceAccountId,
      identity,
    ]),
  );
  const result = new Map<string, SessionOwnerIdentity>();

  for (const ownerId of input.ownerIds) {
    const user = input.users.get(ownerId);
    if (user?.exists) {
      result.set(ownerId, {
        type: 'user',
        name: user.displayName || user.email,
        email: user.email,
      });
      continue;
    }

    const serviceAccount = serviceAccounts.get(ownerId);
    if (serviceAccount) {
      result.set(ownerId, {
        type: 'service_account',
        name: serviceAccount.agentName || serviceAccount.name,
        email: null,
      });
      continue;
    }

    result.set(ownerId, { type: 'unknown', name: null, email: null });
  }

  return result;
}

export function selectSessionRowsForViewer(input: {
  rows: ProjectSessionRow[];
  scope: ProjectSessionListScope;
  canManageProject: boolean;
  subject: ShareSubject;
  /** The caller's own session when the credential is bound to one (sandbox
   *  token). Stops a sandbox listing SIBLING backend sessions, which all share
   *  one `created_by`. */
  callerSessionId: string | null;
  /** The caller's AGENT/SANDBOX token binding (`callerKortixSessionId(c)`).
   *  Only the trigger-session manager override reads it — see share.ts. */
  boundCredentialSessionId: string | null;
  grantsBySession: Map<string, SecretGrant[]>;
  runtimeStatusBySession: Map<string, RuntimeStatus>;
}): { authorized: boolean; items: SessionInventoryItem[] } {
  if (input.scope === 'project' && !input.canManageProject) {
    return { authorized: false, items: [] };
  }

  const items = input.rows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const deletedAt =
      typeof metadata.deletedAt === 'string' ? metadata.deletedAt : null;
    const deletedBy =
      typeof metadata.deletedBy === 'string' ? metadata.deletedBy : null;
    const runtimeStatus =
      input.runtimeStatusBySession.get(row.sessionId) ?? null;
    const canAccess = isProjectSessionVisibleTo(
      row.visibility as 'private' | 'project' | 'restricted',
      row.createdBy,
      input.grantsBySession.get(row.sessionId) ?? [],
      input.subject,
      {
        origin: row.origin ?? null,
        sessionId: row.sessionId,
        callerSessionId: input.callerSessionId,
        boundCredentialSessionId: input.boundCredentialSessionId,
      },
      { metadata: row.metadata, canManageProject: input.canManageProject },
    );
    return { row, canAccess, runtimeStatus, deletedAt, deletedBy };
  });

  if (input.scope === 'project') {
    // A list row is a disclosure. Keep manager-only lifecycle coverage for
    // sessions the manager can open, including warm and soft-deleted rows, but
    // never return an inaccessible session as a redacted breadcrumb.
    return { authorized: true, items: items.filter((item) => item.canAccess) };
  }

  return {
    authorized: true,
    items: items.filter((item) => {
      if (item.deletedAt) return false;
      if (!item.canAccess) return false;
      // A warm session the user never prompted holds no work of theirs, so
      // listing it is noise: they would see a session in the sidebar they never
      // started. The marker is dropped by the first prompt, and from that moment
      // the row lists like any other session. See lib/warm-sessions.ts.
      //
      // `visible` scope only. The `project` scope keeps accessible warm rows for
      // lifecycle inspection, but it also applies the access filter above.
      if (isWarmProjectSession(item.row.metadata)) return false;
      return item.row.status !== 'stopped' || item.runtimeStatus === 'stopped';
    }),
  };
}

/**
 * ─── Paging ────────────────────────────────────────────────────────────────
 *
 * `GET /:projectId/sessions` used to return EVERY session row the viewer could
 * see, with no bound. On a project that had accumulated 12,617 sessions that is
 * a multi-megabyte JSON body — and the sidebar re-fetches it every 5s for as
 * long as any one row sits in `queued`/`branching`/`provisioning`, which over
 * twelve thousand rows is effectively always. The browser paid for it twice:
 * once parsing the body, once letting react-query structurally share 12k
 * objects into a list that then re-sorted and re-grouped them.
 *
 * The list is now a keyset page over `(updated_at DESC, session_id DESC)`.
 * Keyset, not OFFSET: sessions are written constantly, so an offset page would
 * skip and repeat rows between requests, and `OFFSET 12000` still makes
 * Postgres walk the first 12,000. The tuple is unique because `session_id` is
 * the primary key, which is what makes the comparison total and the page
 * boundary exact.
 */

/** One row's position in the `(updated_at DESC, session_id DESC)` order. */
export interface SessionListCursor {
  updatedAt: Date;
  sessionId: string;
}

/**
 * Opaque, URL-safe cursor. Opaque ON PURPOSE: the encoding is this module's
 * business, so the ordering key can change without breaking a client that
 * round-trips the string it was handed. It is not a secret and not signed — it
 * only names a position, and every row behind it still goes through the same
 * visibility fold, so a forged cursor can skip a page but never widen access.
 */
export function encodeSessionCursor(cursor: SessionListCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.sessionId}`, 'utf8').toString(
    'base64url',
  );
}

/** Null for anything that is not a cursor this module wrote — a bad cursor
 *  starts from the top rather than failing the request. */
export function decodeSessionCursor(raw: string | null | undefined): SessionListCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf('|');
  if (separator <= 0) return null;
  const updatedAt = new Date(decoded.slice(0, separator));
  const sessionId = decoded.slice(separator + 1);
  if (!sessionId || Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, sessionId };
}

/** The cursor that resumes AFTER this row. */
export function cursorForRow(row: Pick<ProjectSessionRow, 'updatedAt' | 'sessionId'>): string {
  return encodeSessionCursor({ updatedAt: row.updatedAt, sessionId: row.sessionId });
}

/** Default page size for the session list, and the ceiling a caller may ask
 *  for. The default is what the sidebar renders before you scroll; the ceiling
 *  exists so no caller can re-create the unbounded read this replaced. */
export const SESSION_PAGE_DEFAULT_LIMIT = 50;
export const SESSION_PAGE_MAX_LIMIT = 200;
