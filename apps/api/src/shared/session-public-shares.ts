import { createHash, randomUUID } from 'node:crypto';
import {
  connectorConnections,
  projectSessionConnectorBindings,
  projectSessionPublicShares,
  projectSessions,
  sessionSandboxes,
} from '@kortix/db';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from './db';
import { previewOriginFor } from '../sandbox-proxy/preview-hosts';
import { OPENCODE_PORTS } from './opencode-ports';

export { shareIdFromPublicRef } from './public-share-ref';

/**
 * What a public share names. `preview` is one app port, `file` is one
 * workspace document, `transcript` is the session conversation (read through
 * the sanitized `/v1/public/session-shares/:ref/messages` digest only).
 */
export type PublicShareResourceType = 'preview' | 'file' | 'transcript';

/** Label a transcript share gets when the caller names none. */
const TRANSCRIPT_SHARE_DEFAULT_LABEL = 'Conversation';

export const STATIC_FILE_SHARE_PORT = 3211;
// Both halves of the opencode port pair — a verified reload swaps which one is
// live, so blocking only 4096 would leave the conversation API publicly
// shareable through the other after a single reload. See shared/opencode-ports.
/**
 * The methods a view-only share permits. Shared by BOTH proxy edges — the path
 * form and the preview origin — because a share that is read-only on one and
 * writable on the other is just writable.
 */
export const PUBLIC_SHARE_VIEW_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when this share may not be written through, whatever the visitor sends.
 * Allowlist, not denylist: `mode` is a free-form string on the row, so anything
 * that is not explicitly `interactive` is read-only, and a future mode cannot
 * fail open. A FILE share is always read-only — it names one document.
 */
export function isViewOnlyShare(share: { mode?: string | null; resourceType?: string | null; filePath?: string | null }): boolean {
  if (share.resourceType === 'file' || share.resourceType === 'transcript' || share.filePath) return true;
  return share.mode !== 'interactive';
}

/**
 * True when this share names the session conversation itself. A share grants
 * exactly the resource it names: a `file` share is one document and a
 * `preview` share is one app port, so neither reads the transcript. Only a
 * `transcript` share (minted with `{ transcript: true }`) does.
 */
export function shareUnlocksTranscript(share: { resourceType?: string | null }): boolean {
  return share.resourceType === 'transcript';
}

export const PUBLIC_SHARE_BLOCKED_PORTS = new Set([
  22,
  ...OPENCODE_PORTS,
  8000,
  STATIC_FILE_SHARE_PORT,
]);

export const DEFAULT_PREVIEW_CANDIDATES = [
  { id: 'web', label: 'App preview', port: 3000, path: '/', source: 'default' },
  { id: 'vite', label: 'Frontend preview', port: 5173, path: '/', source: 'default' },
  { id: 'dev-server', label: 'Dev server', port: 8080, path: '/', source: 'default' },
  { id: 'api-docs', label: 'API docs', port: 8001, path: '/', source: 'default' },
] as const;

export type PublicShareRow = typeof projectSessionPublicShares.$inferSelect;

export interface PublicShareInput {
  /** `true` names the session conversation (a `transcript` share). */
  transcript?: unknown;
  preview_id?: unknown;
  preview?: unknown;
  file?: unknown;
  mode?: unknown;
  label?: unknown;
  expires_at?: unknown;
}

export function publicShareToken(shareId: string): string {
  return `kps_${shareId.replaceAll('-', '')}`;
}

export function publicShareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSharePath(value: unknown): string {
  const input = cleanString(value);
  if (!input) return '/';
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      return `${url.pathname || '/'}${url.search}${url.hash}`;
    } catch {
      return '/';
    }
  }
  return input.startsWith('/') ? input : `/${input}`;
}

function normalizeWorkspaceFilePath(value: unknown): string | null {
  const input = cleanString(value);
  if (!input || input.includes('\0') || /^https?:\/\//i.test(input)) return null;

  const withoutWorkspace = input
    .replace(/^\/workspace\/?/, '')
    .replace(/^workspace\/?/, '');
  const segments = withoutWorkspace.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return `/workspace/${segments.join('/')}`;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) || 'Shared file';
}

/** The web page a transcript share opens at. */
export function transcriptShareViewerUrl(token: string): string {
  return `${config.FRONTEND_URL.replace(/\/+$/, '')}/share/session/${token}`;
}

export function resourceProxyPath(token: string, row: Pick<PublicShareRow, 'resourceType' | 'port' | 'path'>): string {
  if (row.resourceType === 'file') return `/v1/p/public-share/${token}/file`;
  // A transcript has no sandbox port: its API read is the sanitized digest.
  if (row.resourceType === 'transcript') return `/v1/public/session-shares/${token}/messages`;
  return `/v1/p/public-share/${token}/${row.port}${row.path}`;
}

/**
 * The absolute URL a share opens at, when the deployment serves preview
 * origins. `proxy_path` stays for compatibility, but it is the PATH form —
 * under it a shared app's root-absolute links resolve against the API origin
 * and 404, and shared file content renders with the API's own principal.
 *
 * Needs the sandbox's external id, which the share row does not carry; callers
 * that have it (they joined session_sandboxes) pass it, and the rest get null
 * and the path form, exactly as before.
 */
function resourcePublicUrl(
  token: string,
  row: Pick<PublicShareRow, 'resourceType' | 'port' | 'path'>,
  externalId: string | null | undefined,
): string | null {
  // A transcript is rendered by the web app, never by the sandbox, so it has
  // a public URL whether or not a sandbox exists.
  if (row.resourceType === 'transcript') return transcriptShareViewerUrl(token);
  if (!externalId) return null;
  if (row.resourceType === 'file') {
    const origin = previewOriginFor(externalId, STATIC_FILE_SHARE_PORT);
    return origin ? `${origin}/open?public_share=${encodeURIComponent(token)}` : null;
  }
  if (!row.port) return null;
  const origin = previewOriginFor(externalId, row.port);
  if (!origin) return null;
  const path = row.path && row.path.startsWith('/') ? row.path : `/${row.path || ''}`;
  return `${origin}${path}?public_share=${encodeURIComponent(token)}`;
}

export function serializePublicShare(
  row: PublicShareRow,
  token?: string,
  externalId?: string | null,
) {
  const publicToken = token ?? publicShareToken(row.shareId);
  return {
    share_id: row.shareId,
    session_id: row.sessionId,
    project_id: row.projectId,
    resource_type: row.resourceType as PublicShareResourceType,
    label: row.label,
    port: row.port,
    path: row.path,
    file_path: row.filePath,
    mode: row.mode,
    allow_websocket: row.allowWebsocket,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    public_token: publicToken,
    public_path: `/share/session/${publicToken}`,
    proxy_path: resourceProxyPath(publicToken, row),
    public_url: resourcePublicUrl(publicToken, row, externalId),
  };
}

export async function listPublicSharesForSession(sessionId: string) {
  const rows = await db
    .select()
    .from(projectSessionPublicShares)
    .where(eq(projectSessionPublicShares.sessionId, sessionId))
    .orderBy(desc(projectSessionPublicShares.createdAt));
  // One lookup for the whole list: every share of a session names the same
  // sandbox, and without the external id every row would fall back to the path
  // form (see resourcePublicUrl).
  const externalId = await sessionSandboxExternalId(sessionId);
  return rows.map((row) => serializePublicShare(row, undefined, externalId));
}

/** The live sandbox external id for a session, or null when none is bound. */
export async function sessionSandboxExternalId(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .orderBy(desc(sessionSandboxes.updatedAt))
    .limit(1);
  return row?.externalId ?? null;
}

export function buildPublicShareInsert(input: PublicShareInput, ctx: {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
}) {
  const file = typeof input.file === 'object' && input.file ? input.file as Record<string, unknown> : null;
  if (input.transcript === true) {
    if (file || input.preview || input.preview_id) {
      return { ok: false as const, status: 400, error: 'A public share names one resource' };
    }
    const expiresAt = parseExpiresAt(input.expires_at);
    if (expiresAt === false) return { ok: false as const, status: 400, error: 'expires_at must be an ISO timestamp' };
    return {
      ok: true as const,
      values: {
        resourceType: 'transcript',
        label: cleanString(input.label) ?? TRANSCRIPT_SHARE_DEFAULT_LABEL,
        port: null,
        path: '/',
        filePath: null,
        mode: 'view',
        allowWebsocket: false,
        expiresAt,
        ...ctx,
      },
    };
  }
  if (file) {
    const filePath = normalizeWorkspaceFilePath(file.path ?? file.file_path);
    if (!filePath) return { ok: false as const, status: 400, error: 'File path cannot be shared' };
    const expiresAt = parseExpiresAt(input.expires_at);
    if (expiresAt === false) return { ok: false as const, status: 400, error: 'expires_at must be an ISO timestamp' };
    return {
      ok: true as const,
      values: {
        resourceType: 'file',
        label: cleanString(input.label ?? file.label) ?? basename(filePath),
        port: null,
        path: '/',
        filePath,
        mode: 'view',
        allowWebsocket: false,
        expiresAt,
        ...ctx,
      },
    };
  }

  const activePreview = typeof input.preview === 'object' && input.preview
    ? input.preview as Record<string, unknown>
    : null;
  const requestedCandidate = typeof input.preview_id === 'string'
    ? DEFAULT_PREVIEW_CANDIDATES.find((candidate) => candidate.id === input.preview_id)
    : null;
  const port = Number(activePreview?.port ?? requestedCandidate?.port ?? DEFAULT_PREVIEW_CANDIDATES[0].port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || PUBLIC_SHARE_BLOCKED_PORTS.has(port)) {
    return { ok: false as const, status: 400, error: 'Preview cannot be shared on this port' };
  }
  const expiresAt = parseExpiresAt(input.expires_at);
  if (expiresAt === false) return { ok: false as const, status: 400, error: 'expires_at must be an ISO timestamp' };
  const mode = input.mode === 'interactive' ? 'interactive' : 'view';
  return {
    ok: true as const,
    values: {
      resourceType: 'preview',
      label: cleanString(activePreview?.label ?? input.label ?? requestedCandidate?.label) ?? 'App preview',
      port,
      path: normalizeSharePath(activePreview?.path ?? activePreview?.url ?? requestedCandidate?.path ?? '/'),
      filePath: null,
      mode,
      allowWebsocket: mode === 'interactive',
      expiresAt,
      ...ctx,
    },
  };
}

function parseExpiresAt(value: unknown): Date | null | false {
  if (typeof value !== 'string' || !value) return null;
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? false : expiresAt;
}

export async function createPublicShare(input: PublicShareInput, ctx: {
  sessionId: string;
  projectId: string;
  accountId: string;
  userId: string;
}) {
  const built = buildPublicShareInsert(input, ctx);
  if (!built.ok) return built;

  if (built.values.resourceType === 'transcript') {
    return createOrReuseTranscriptShare(built.values);
  }

  const shareId = randomUUID();
  const token = publicShareToken(shareId);
  const [row] = await db
    .insert(projectSessionPublicShares)
    .values({
      shareId,
      tokenHash: publicShareTokenHash(token),
      sessionId: built.values.sessionId,
      projectId: built.values.projectId,
      accountId: built.values.accountId,
      createdBy: built.values.userId,
      resourceType: built.values.resourceType,
      label: built.values.label,
      port: built.values.port,
      path: built.values.path,
      filePath: built.values.filePath,
      mode: built.values.mode,
      allowWebsocket: built.values.allowWebsocket,
      expiresAt: built.values.expiresAt,
    })
    .returning();

  return {
    ok: true as const,
    created: true,
    share: serializePublicShare(row, token, await sessionSandboxExternalId(row.sessionId)),
  };
}

type BuiltShareValues = Extract<ReturnType<typeof buildPublicShareInsert>, { ok: true }>['values'];

/**
 * A session has at most one live transcript link. Minting again returns the
 * live one (`created: false`) instead of a second URL to the same
 * conversation, so "copy link" is idempotent and one revoke ends public
 * access. A transaction-scoped advisory lock on the session id serializes two
 * concurrent mints; a revoked or expired link does not count as live.
 */
async function createOrReuseTranscriptShare(values: BuiltShareValues) {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`public-transcript-share:${values.sessionId}`}, 0))`,
    );
    const [live] = await tx
      .select()
      .from(projectSessionPublicShares)
      .where(and(
        eq(projectSessionPublicShares.sessionId, values.sessionId),
        eq(projectSessionPublicShares.resourceType, 'transcript'),
        isNull(projectSessionPublicShares.revokedAt),
        or(
          isNull(projectSessionPublicShares.expiresAt),
          gt(projectSessionPublicShares.expiresAt, new Date()),
        ),
      ))
      .orderBy(desc(projectSessionPublicShares.createdAt))
      .limit(1);
    if (live) return { row: live, created: false };

    const shareId = randomUUID();
    const [row] = await tx
      .insert(projectSessionPublicShares)
      .values({
        shareId,
        tokenHash: publicShareTokenHash(publicShareToken(shareId)),
        sessionId: values.sessionId,
        projectId: values.projectId,
        accountId: values.accountId,
        createdBy: values.userId,
        resourceType: values.resourceType,
        label: values.label,
        port: values.port,
        path: values.path,
        filePath: values.filePath,
        mode: values.mode,
        allowWebsocket: values.allowWebsocket,
        expiresAt: values.expiresAt,
      })
      .returning();
    return { row, created: true };
  });

  return {
    ok: true as const,
    created: result.created,
    share: serializePublicShare(result.row, undefined, await sessionSandboxExternalId(result.row.sessionId)),
  };
}

/** Revoke every live public share of a session (the session delete path). */
export async function revokeAllPublicSharesForSession(sessionId: string, at: Date = new Date()): Promise<number> {
  const rows = await db
    .update(projectSessionPublicShares)
    .set({ revokedAt: at, updatedAt: at })
    .where(and(
      eq(projectSessionPublicShares.sessionId, sessionId),
      isNull(projectSessionPublicShares.revokedAt),
    ))
    .returning({ shareId: projectSessionPublicShares.shareId });
  return rows.length;
}

export async function revokePublicShare(sessionId: string, shareId: string) {
  const [row] = await db
    .update(projectSessionPublicShares)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(projectSessionPublicShares.shareId, shareId),
      eq(projectSessionPublicShares.sessionId, sessionId),
    ))
    .returning();
  return row ? serializePublicShare(row, undefined, await sessionSandboxExternalId(row.sessionId)) : null;
}

export async function touchPublicShare(shareId: string) {
  await db
    .update(projectSessionPublicShares)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectSessionPublicShares.shareId, shareId));
}

export async function resolvePublicShare(
  token: string,
  opts: {
    /** Refuse (404) a share that does not name the conversation, before any
     *  sandbox-readiness answer: the transcript route must not report the
     *  sandbox state of a share it will never serve. */
    requireTranscript?: boolean;
  } = {},
) {
  // LEFT JOIN, not INNER: a session that was created but never started (or
  // whose sandbox hasn't been provisioned yet) has no `session_sandboxes` row
  // at all. An INNER JOIN made that case fall straight into `!row` → 404
  // ("not found"), which is a lie — the share link IS valid, its sandbox just
  // isn't up yet. The LEFT JOIN lets a real, non-revoked, non-expired token
  // reach the `!row.externalId` branch below and report the truthful 503
  // ("Sandbox is not ready") instead of a false 404. `sessionId` is unique on
  // `session_sandboxes` (one row per session), so this never fans out.
  const [row] = await db
    .select({
      shareId: projectSessionPublicShares.shareId,
      sessionId: projectSessionPublicShares.sessionId,
      projectId: projectSessionPublicShares.projectId,
      accountId: projectSessionPublicShares.accountId,
      resourceType: projectSessionPublicShares.resourceType,
      label: projectSessionPublicShares.label,
      port: projectSessionPublicShares.port,
      path: projectSessionPublicShares.path,
      filePath: projectSessionPublicShares.filePath,
      mode: projectSessionPublicShares.mode,
      allowWebsocket: projectSessionPublicShares.allowWebsocket,
      expiresAt: projectSessionPublicShares.expiresAt,
      revokedAt: projectSessionPublicShares.revokedAt,
      externalId: sessionSandboxes.externalId,
      sandboxStatus: sessionSandboxes.status,
      sessionMetadata: projectSessions.metadata,
    })
    .from(projectSessionPublicShares)
    .leftJoin(sessionSandboxes, eq(sessionSandboxes.sessionId, projectSessionPublicShares.sessionId))
    .leftJoin(projectSessions, eq(projectSessions.sessionId, projectSessionPublicShares.sessionId))
    .where(eq(projectSessionPublicShares.tokenHash, publicShareTokenHash(token)))
    .limit(1);

  if (!row) return { ok: false as const, status: 404, error: 'Share link not found' };
  if (row.revokedAt) return { ok: false as const, status: 410, error: 'Share link revoked' };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false as const, status: 410, error: 'Share link expired' };
  }
  // A deleted session keeps its row (soft delete stamps `metadata.deletedAt`,
  // the predicate `sessionIsTombstoned` in projects/lib/access.ts reads) and
  // its saved transcript. Its links must end with it, even one the delete path
  // failed to revoke.
  if (typeof (row.sessionMetadata as Record<string, unknown> | null)?.deletedAt === 'string') {
    return { ok: false as const, status: 410, error: 'Share link revoked' };
  }
  // Fail closed for links created before personal-connection sharing was
  // prohibited. A public preview/file link delegates access to the same fixed
  // session runtime token, so it must never indirectly delegate a member's
  // private connector credentials.
  const [personalBinding] = await db
    .select({ connectionId: projectSessionConnectorBindings.connectionId })
    .from(projectSessionConnectorBindings)
    .innerJoin(
      connectorConnections,
      eq(connectorConnections.connectionId, projectSessionConnectorBindings.connectionId),
    )
    .where(
      and(
        eq(projectSessionConnectorBindings.sessionId, row.sessionId),
        eq(connectorConnections.ownerType, 'member'),
      ),
    )
    .limit(1);
  if (personalBinding) {
    return {
      ok: false as const,
      status: 403,
      error: 'Sessions using a personal connection cannot be shared publicly',
    };
  }
  if (opts.requireTranscript && !shareUnlocksTranscript(row)) {
    return { ok: false as const, status: 404, error: 'This share does not include the conversation' };
  }
  // A transcript share needs no sandbox: its reader falls back to the saved
  // transcript when no box is up (public-session-share-view.ts).
  if (!row.externalId && row.resourceType !== 'transcript') {
    return { ok: false as const, status: 503, error: 'Sandbox is not ready' };
  }
  if (row.resourceType === 'preview' && (!row.port || PUBLIC_SHARE_BLOCKED_PORTS.has(row.port))) {
    return { ok: false as const, status: 403, error: 'This service cannot be shared publicly' };
  }
  if (row.resourceType === 'file' && !row.filePath) {
    return { ok: false as const, status: 400, error: 'Shared file path is missing' };
  }
  return { ok: true as const, row };
}
