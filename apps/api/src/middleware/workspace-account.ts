/**
 * The workspace resolver and the canonical id rule (design.md §3.2 C5).
 *
 * Two kinds of path name a workspace:
 *
 *   - Canonical paths (`/v1/workspaces/:workspaceId/…`,
 *     `/v1/connectors/workspaces/:workspaceId/…`, `/scim/v2/workspaces/:workspaceId/…`)
 *     take the workspace id ONLY. An account id, an unknown id or a workspace
 *     the caller cannot read answers `404 { code: 'workspace_not_found' }` on
 *     every sub-path, so a caller cannot probe which ids exist. Input uuids are
 *     case-insensitive.
 *   - Legacy paths (`/v1/accounts/:accountId/…`, `/v1/projects/:projectId/…`,
 *     `/scim/v2/accounts/:accountId/…`) keep their old tolerance forever: the
 *     account key or the workspace id, and their old status codes.
 *
 * The handlers behind the account-key families were written for the account
 * key. `resolveWorkspaceAccount` maps the path id to it and stores it under
 * `WORKSPACE_ACCOUNT_ID_VAR`, which `accountIdParam(c)` returns.
 *
 * Legacy resolution (one query, `resolveWorkspace`):
 *   - a workspace id → its account key;
 *   - an account key with one active project → itself;
 *   - an account key with 0 active projects (a dormant account) or with several
 *     (a `split_pending` legacy account, `workspace_ambiguous`) → itself, the
 *     behavior every `/v1/accounts/:accountId` route always had;
 *   - an unknown id → itself, so the handler answers its own 403/404.
 * A non-uuid segment (`/v1/accounts/me`, `/v1/accounts/tokens`) is skipped
 * without a query.
 */
import type { Context, MiddlewareHandler } from 'hono';

import { PROJECT_ACTIONS, authorize, workspaceRoleFor } from '../iam';
import { actorOf } from './actor';
import { WORKSPACE_ACCOUNT_ID_VAR } from '../shared/route-params';
import { isUuid } from '../shared/validate';
import { accountIsPaying, getWorkspace, resolveWorkspace, WorkspaceAmbiguousError } from '../workspaces/surface';

/** Set when the path id is a workspace id (`project_id`). */
export const PATH_WORKSPACE_ID_VAR = 'pathWorkspaceId';
/** True when that workspace's account still holds other active projects. */
export const PATH_WORKSPACE_SPLIT_PENDING_VAR = 'pathWorkspaceSplitPending';
/** Set once a canonical path id passed the canonical gate: `CanonicalWorkspace`. */
export const CANONICAL_WORKSPACE_VAR = 'canonicalWorkspace';

export const WORKSPACE_NOT_FOUND_CODE = 'workspace_not_found';
export const WORKSPACE_SETUP_REQUIRED_CODE = 'workspace_setup_required';
export const WORKSPACE_DELETING_CODE = 'workspace_deleting';

/** The canonical prefixes whose first segment after the prefix is a workspace id. */
const CANONICAL_PATH = /^\/(?:v1\/workspaces|v1\/connectors\/workspaces|scim\/v2\/workspaces)\/([^/]+)(?:\/|$)/;

/** The workspace id segment of a canonical path; `null` for a legacy path or the list root. */
export function canonicalWorkspacePathId(path: string): string | null {
  return CANONICAL_PATH.exec(path)?.[1] ?? null;
}

/** True for a request under a canonical workspace prefix that names a workspace. */
export function isCanonicalWorkspacePath(path: string): boolean {
  return canonicalWorkspacePathId(path) !== null;
}

export interface ResolvedPathAccount {
  accountId: string;
  /** The workspace id when the path named one, else null. */
  workspaceId: string | null;
  splitPending: boolean;
}

/** One workspace a canonical path named, as the canonical gate resolved it. */
export interface CanonicalWorkspace {
  workspaceId: string;
  accountId: string;
  /** `null` while the workspace is `setup_required` (no project row yet). */
  projectId: string | null;
  splitPending: boolean;
  lifecycle: 'active' | 'dormant' | 'closing';
  /** When a `closing` workspace is erased; null otherwise. */
  deletionScheduledFor: Date | null;
}

/**
 * A workspace id → the workspace, for canonical paths. `null` for an account
 * id, a tombstone, an unknown id, a non-uuid, and a project-less workspace
 * that does not pay (a dormant row is served only as `setup_required`, C1).
 * Lowercases the id. Reads the workspaces store (`getWorkspace`, live rows only).
 */
export async function resolveCanonicalPathWorkspace(id: string): Promise<CanonicalWorkspace | null> {
  if (!isUuid(id)) return null;
  const ws = await getWorkspace(id.toLowerCase());
  if (!ws) return null;
  if (ws.lifecycle === 'dormant' && !(await accountIsPaying(ws.accountId))) return null;
  return {
    workspaceId: ws.workspaceId.toLowerCase(),
    accountId: ws.accountId,
    projectId: ws.projectId,
    splitPending: ws.splitPending,
    lifecycle: ws.lifecycle,
    deletionScheduledFor: ws.deletionScheduledFor,
  };
}

/** Map one LEGACY path id to the account key. Exported for tests. */
export async function resolvePathAccount(id: string): Promise<ResolvedPathAccount> {
  try {
    const ws = await resolveWorkspace(id);
    if (!ws) return { accountId: id, workspaceId: null, splitPending: false };
    const namedWorkspace = ws.workspaceId.toLowerCase() === id.toLowerCase();
    return {
      accountId: ws.accountId,
      workspaceId: namedWorkspace ? ws.workspaceId : null,
      splitPending: ws.splitPending,
    };
  } catch (err) {
    if (err instanceof WorkspaceAmbiguousError) return { accountId: id, workspaceId: null, splitPending: true };
    throw err;
  }
}

function setVar(c: Context, key: string, value: unknown): void {
  (c as unknown as { set(k: string, v: unknown): void }).set(key, value);
}

function getVar(c: Context, key: string): unknown {
  return (c as unknown as { get(k: string): unknown }).get(key);
}

/** `404 workspace_not_found`: the one answer for every id a canonical path does not serve. */
export function workspaceNotFound(c: Context): Response {
  return c.json({ error: 'Workspace not found', code: WORKSPACE_NOT_FOUND_CODE }, 404);
}

/** Denials the handler answers itself with a coded 403 the client acts on (step-up, SSO). */
const ACTIONABLE_DENIALS = new Set(['account_mfa_required', 'sso_required']);

/**
 * The canonical decision for one request: `null` lets it through (and stores
 * the workspace under `CANONICAL_WORKSPACE_VAR`), a Response answers it.
 *
 * - The id is not a workspace id (account id, unknown, tombstone) → 404.
 * - An actor exists (auth ran) and may not read the workspace → 404. A denial
 *   the caller can act on (MFA step-up, SSO) passes through to the handler's
 *   coded 403. A request without an actor (SCIM, whose bearer is judged after
 *   this) is not judged here.
 * - A `closing` workspace: owners only, and only the reads C3 keeps; others 404.
 * - `projectBacked` and the workspace has no project yet → 409 workspace_setup_required.
 */
export async function canonicalWorkspaceDecision(
  c: Context,
  rawId: string,
  opts: { projectBacked: boolean; outsiderAllowed?: boolean },
): Promise<Response | null> {
  const known = getVar(c, CANONICAL_WORKSPACE_VAR) as CanonicalWorkspace | undefined;
  if (known && known.workspaceId === rawId.toLowerCase()) return null;
  const ws = await resolveCanonicalPathWorkspace(rawId);
  if (!ws) return workspaceNotFound(c);

  const userId = getVar(c, 'userId');
  const signedIn = typeof userId === 'string' && userId.length > 0;
  const actor = signedIn ? await actorOf(c, ws.accountId) : null;
  if (actor && !opts.outsiderAllowed) {
    const verdict = await authorize(actor, PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: ws.projectId ?? ws.workspaceId,
    });
    // A project-less (`setup_required`) workspace has no project to read: its members reach it (C3).
    const reachable =
      verdict.allowed ||
      ACTIONABLE_DENIALS.has(verdict.reason) ||
      (ws.projectId === null && (await workspaceRoleFor(actor, ws.workspaceId)) !== null);
    if (!reachable) return workspaceNotFound(c);
  }

  if (ws.lifecycle === 'closing') {
    // Owners keep the record read and restore (C3); everyone else sees nothing.
    const role = actor ? await workspaceRoleFor(actor, ws.workspaceId) : null;
    const ownerRead = c.req.method === 'GET' && canonicalTail(c.req.path) === '';
    const restore = c.req.method === 'POST' && canonicalTail(c.req.path) === 'restore';
    if (role !== 'owner') return workspaceNotFound(c);
    if (!ownerRead && !restore) {
      return c.json({ error: 'This workspace is being deleted. Restore it first.', code: WORKSPACE_DELETING_CODE }, 409);
    }
  }

  if (opts.projectBacked && ws.projectId === null) {
    return c.json(
      { error: 'Set up this workspace before you use it.', code: WORKSPACE_SETUP_REQUIRED_CODE, workspace_id: ws.workspaceId },
      409,
    );
  }

  setVar(c, CANONICAL_WORKSPACE_VAR, ws);
  return null;
}

/** The path after the workspace id: `''` for the record itself, `sessions/…` for a sub-path. */
function canonicalTail(path: string): string {
  const m = CANONICAL_PATH.exec(path);
  return m ? path.slice(m[0].length).replace(/^\/+/, '') : '';
}

/** Sub-paths a workspace with no project yet (`setup_required`) still answers: the record, restore, setup. */
const NOT_PROJECT_BACKED = new Set(['', 'restore', 'setup']);

/**
 * `POST /v1/workspaces/:id/access-requests`: a person who cannot read the
 * workspace asks for access. The route answers for itself (it reveals no more
 * than the share link the person already holds).
 */
function outsiderAllowed(method: string, tail: string): boolean {
  return method === 'POST' && tail === 'access-requests';
}

/**
 * The canonical gate as middleware, for `/v1/workspaces/:workspaceId[/…]` and
 * `/v1/connectors/workspaces/:workspaceId/…`. Mount AFTER the auth
 * middleware. A non-uuid segment (`current`, a static route) passes
 * untouched. Every sub-path except the record, `restore` and `setup` is
 * project-backed.
 */
export function canonicalWorkspaceGate(): MiddlewareHandler {
  return async (c, next) => {
    const raw = canonicalWorkspacePathId(c.req.path);
    if (raw && isUuid(raw)) {
      const tail = canonicalTail(c.req.path);
      const refused = await canonicalWorkspaceDecision(c, raw, {
        projectBacked: !NOT_PROJECT_BACKED.has(tail),
        outsiderAllowed: outsiderAllowed(c.req.method, tail),
      });
      if (refused) return refused;
    }
    await next();
  };
}

/**
 * `id` reads the path id; the default reads `:workspaceId`. Runs once per
 * request: a second mount of the same chain finds the var already set.
 *
 * On a canonical path the id must be a workspace id (see the file header);
 * the account families are not project-backed, so a `setup_required`
 * workspace still answers them.
 */
export function resolveWorkspaceAccount(
  id: (c: Context) => string | undefined = (c) => c.req.param('workspaceId'),
): MiddlewareHandler {
  return async (c, next) => {
    const raw = id(c);
    const known = getVar(c, WORKSPACE_ACCOUNT_ID_VAR);
    if (raw && !known && isUuid(raw)) {
      if (isCanonicalWorkspacePath(c.req.path)) {
        const refused = await canonicalWorkspaceDecision(c, raw, { projectBacked: false });
        if (refused) return refused;
        const ws = getVar(c, CANONICAL_WORKSPACE_VAR) as CanonicalWorkspace;
        setVar(c, WORKSPACE_ACCOUNT_ID_VAR, ws.accountId);
        setVar(c, PATH_WORKSPACE_ID_VAR, ws.workspaceId);
        setVar(c, PATH_WORKSPACE_SPLIT_PENDING_VAR, ws.splitPending);
      } else {
        const resolved = await resolvePathAccount(raw);
        setVar(c, WORKSPACE_ACCOUNT_ID_VAR, resolved.accountId);
        if (resolved.workspaceId) {
          setVar(c, PATH_WORKSPACE_ID_VAR, resolved.workspaceId);
          setVar(c, PATH_WORKSPACE_SPLIT_PENDING_VAR, resolved.splitPending);
        }
      }
    }
    await next();
  };
}

/** The path id of a request under `/v1/accounts/<id>` or `/v1/workspaces/<id>`, for a `/*` middleware. */
export function workspacePathSegment(c: Context): string | undefined {
  const parts = c.req.path.split('/');
  return parts[1] === 'v1' && (parts[2] === 'accounts' || parts[2] === 'workspaces') ? parts[3] : undefined;
}
