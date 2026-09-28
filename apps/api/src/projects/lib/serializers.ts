import type { ProjectSession } from '@kortix/api-contract';
import type {
  projectGitConnections,
  projectGitCredentials,
  projectSessions,
  projects,
} from '@kortix/db';
import type { Context } from 'hono';
import {
  type SecretGrant,
  mayManageSessionSharing,
  visibilityToIntent,
} from '../../connectors/share';
import { normalizeAuditClientSource } from '../../shared/audit-client-source';
import { requestClientIp } from '../../shared/client-ip';
import { isPlaceholderOpencodeTitle, runtimeRootTitleFromSnapshot } from './opencode-title';
import { hasOwn } from './validators';

export * from './secret-views';
export * from './validators';
export { serializeBuildSummary, serializeTemplate } from '../../snapshots/serializers';
export { serializeProject, publicProjectMetadata } from './project-serializer';
export {
  serializeGitHubRepo,
  serializeGitHubInstallation,
  serializeGitHubInstallations,
} from './github-serializers';

export type ProjectRow = typeof projects.$inferSelect;

export type ProjectGitConnectionRow = typeof projectGitConnections.$inferSelect;

export type ProjectGitCredentialRow = typeof projectGitCredentials.$inferSelect;

export type ProjectSessionRow = typeof projectSessions.$inferSelect;

export type RequestAuditContext = {
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
  clientReportedSource?: string | null;
};

// Session-status constants live in a dependency-free module so lean callers (the
// sandbox reaper) can import them without this heavy serializer graph. Re-exported
// here for the existing import sites. See session-status.ts for the index note.
export { ACTIVE_SESSION_STATUSES, PROVISIONING_SESSION_STATUSES } from './session-status';

/**
 * Session-metadata keys the LIST response omits.
 *
 * These are write-only from a client's point of view: they are stamped by the
 * server at create/branch/trigger time and no client — web, mobile, SDK or the
 * whitelabel demo — ever reads them back off a session (verified 2026-08-26 by
 * an exhaustive read-side sweep of apps/web, apps/mobile, packages/sdk and
 * apps/whitelabel-demo). They are also the heavy ones: on a real 60-session
 * project they are 57% of the whole list body (`initial_prompt` alone is 36%),
 * which the sidebar re-fetches several times per session open.
 *
 * The SINGLE-session read (`GET /:projectId/sessions/:sessionId`) still returns
 * metadata whole, so nothing loses access to them — only the inventory listing
 * stops shipping a copy per row. Keys clients DO read off the list —
 * `pending_prompt`, `session_name`, `last_activity_at`, `spawned_by_session`,
 * `legacy_migration`, `source`, `trigger_*`, `sandbox_slug`, `warm` — are
 * deliberately NOT here.
 */
export const LIST_OMITTED_SESSION_METADATA_KEYS = [
  'initial_prompt',
  'payload_summary',
  'session_start_timeline',
  'audit_v2',
  'remote_branch',
] as const;

function trimSessionMetadataForList(metadata: Record<string, unknown>): Record<string, unknown> {
  let trimmed: Record<string, unknown> | null = null;
  for (const key of LIST_OMITTED_SESSION_METADATA_KEYS) {
    if (!hasOwn(metadata, key)) continue;
    if (!trimmed) trimmed = { ...metadata };
    delete trimmed[key];
  }
  return trimmed ?? metadata;
}

export function serializeSession(
  row: ProjectSessionRow,
  ctx?: {
    /** The grants on this session (for restricted visibility). */
    grants?: SecretGrant[];
    /** The viewing user, to compute is_owner / can_manage_*. */
    viewerId?: string;
    /** Viewer can manage the project (account owner/admin, or a project manager). */
    canManageProject?: boolean;
    /**
     * True when `created_by` names a service account (a trigger/agent run) or
     * nobody at all — the one case where a project manager, not the owner,
     * governs sharing. See mayManageSessionSharing.
     */
    ownerIsMachine?: boolean;
    /** Resolved email of the session owner, for "shared by X" display. */
    ownerEmail?: string | null;
    /** Resolved human or service-account display name. */
    ownerName?: string | null;
    /** Whether created_by identifies a human, service account, or stale principal. */
    ownerType?: 'user' | 'service_account' | 'unknown' | null;
    /** Whether the viewer may read/open the session, independent of inventory visibility. */
    canAccess?: boolean;
    /** Exact state of the backing runtime resource, if one still exists. */
    runtimeStatus?: 'provisioning' | 'active' | 'stopped' | 'error' | 'archived' | null;
    /** Server-managed soft-deletion audit fields. */
    deletedAt?: string | null;
    deletedBy?: string | null;
    /**
     * Drop the write-only heavy metadata keys (see
     * LIST_OMITTED_SESSION_METADATA_KEYS). Set by the inventory LIST only; the
     * single-session read keeps metadata whole.
     */
    trimListMetadata?: boolean;
  },
): ProjectSession {
  // Computed BEFORE the metadata-derived fields below, because name,
  // custom_name and opencode_sessions are all derived FROM metadata — redacting
  // the metadata object alone would still have leaked the OpenCode-synced title
  // (which summarises the conversation) and the conversation-tree snapshot.
  const canAccess = ctx?.canAccess ?? true;
  const opencodeSessions =
    canAccess && Array.isArray(row.metadata?.opencode_sessions)
      ? row.metadata.opencode_sessions
      : [];
  const isOwner = ctx?.viewerId ? row.createdBy === ctx.viewerId : false;
  // A user-set name (metadata.custom_name) is authoritative and ALWAYS wins
  // over the auto title (metadata.name) mirrored from OpenCode server-side
  // during session reads. `name` is the resolved display value;
  // `custom_name` is exposed separately so clients can tell an override apart
  // from the auto title.
  const customName =
    canAccess && typeof row.metadata?.custom_name === 'string' ? row.metadata.custom_name : null;
  // Historic rows may carry OpenCode's frozen placeholder ("New session - …")
  // in metadata.name — expose it as untitled so clients fall back to their own
  // display chain instead of a junk title (heals old rows with no backfill).
  const rawAutoName =
    canAccess && typeof row.metadata?.name === 'string' ? row.metadata.name : null;
  const autoName = isPlaceholderOpencodeTitle(rawAutoName) ? null : rawAutoName;
  // The runtime's own root-conversation title (already access-gated: the
  // snapshot above is [] when canAccess is false). It outranks the generated
  // auto title so list reads resolve the SAME string the session header shows
  // live, but never a user rename.
  const runtimeTitle = runtimeRootTitleFromSnapshot(opencodeSessions, row.opencodeSessionId);
  return {
    session_id: row.sessionId,
    account_id: row.accountId,
    project_id: row.projectId,
    branch_name: row.branchName,
    base_ref: row.baseRef,
    sandbox_provider: row.sandboxProvider,
    sandbox_id: row.sandboxId,
    sandbox_url: row.sandboxUrl,
    opencode_session_id: row.opencodeSessionId,
    name: customName ?? runtimeTitle ?? autoName,
    custom_name: customName,
    agent_name: row.agentName,
    status: row.status,
    error: row.error,
    // Inventory filters inaccessible rows. Keep this boundary fail-closed for
    // other callers that serialize with canAccess=false. Metadata holds
    // initial_prompt — the literal text an end-user typed.
    metadata: canAccess
      ? ctx?.trimListMetadata
        ? trimSessionMetadataForList(row.metadata ?? {})
        : (row.metadata ?? {})
      : {},
    opencode_sessions: opencodeSessions,
    // Ownership + org-visibility (Phase 2 session sharing).
    created_by: row.createdBy,
    owner_email: ctx?.ownerEmail ?? null,
    owner_name: ctx?.ownerName ?? null,
    owner_type: ctx?.ownerType ?? (row.createdBy ? 'unknown' : null),
    visibility: row.visibility,
    origin: row.origin,
    secrets_allowlist: canAccess ? (row.secretsAllowlist ?? null) : null,
    sharing: visibilityToIntent(
      row.visibility as 'private' | 'project' | 'restricted',
      ctx?.grants ?? [],
    ),
    is_owner: isOwner,
    // Two different questions, deliberately not one flag: changing WHO CAN OPEN
    // a session is the owner's call, while stopping/restarting/deleting it
    // stays manager-tier. Collapsing them let a manager rewrite the visibility
    // of a private session they could not read.
    can_manage_sharing: mayManageSessionSharing({
      isOwner,
      canManageProject: Boolean(ctx?.canManageProject),
      ownerIsMachine: ctx?.ownerIsMachine ?? !row.createdBy,
    }),
    can_manage_lifecycle: isOwner || Boolean(ctx?.canManageProject),
    can_access: canAccess,
    runtime_status: ctx?.runtimeStatus ?? null,
    deleted_at: ctx?.deletedAt ?? null,
    deleted_by: ctx?.deletedBy ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Load a session and enforce that the viewer can SEE it (owner, project-wide,
 * or in the allow-list). Returns null for both not-found and not-visible so we
 * never reveal the existence of a private session. Also reports whether the
 * viewer may manage its sharing (account owner/admin, or a project manager).
 */

/** True when a GitHub repo-create error is a name collision (HTTP 422). On
 *  POST /user/repos a 422 is, in practice, always "name already exists". */
export function isRepoNameTakenError(error: unknown): boolean {
  const m = ((error as Error)?.message ?? '').toLowerCase();
  return m.includes('already exists') || m.includes('name already') || m.includes('(422)');
}

export function serializeProjectGitConnection(row: ProjectGitConnectionRow | null) {
  if (!row) return null;
  return {
    connection_id: row.connectionId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.provider,
    repo_url: row.repoUrl,
    repo_owner: row.repoOwner,
    repo_name: row.repoName,
    external_repo_id: row.externalRepoId,
    default_branch: row.defaultBranch,
    auth_method: row.authMethod,
    installation_id: row.installationId,
    // The flag the web's repo-access section keys on. It used to be read off
    // `metadata.git.managed`, which is empty once the connection lives in
    // this table — every managed repo then read as "Kortix did not create it".
    managed: row.managed ?? false,
    credential_ref: row.credentialRef,
    permissions: row.permissions ?? {},
    visibility: row.visibility,
    webhook_id: row.webhookId,
    status: row.status,
    last_validated_at: row.lastValidatedAt?.toISOString() ?? null,
    last_error_code: row.lastErrorCode,
    last_error_message: row.lastErrorMessage,
    metadata: row.metadata ?? {},
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function requestAuditContext(c: Context): RequestAuditContext {
  return {
    method: c.req.method,
    path: c.req.path,
    ip: requestClientIp(c),
    userAgent: c.req.header('user-agent') || null,
    clientReportedSource: normalizeAuditClientSource(c.req.header('x-kortix-client')),
  };
}

export function serializeSessionSandboxConfig(
  configValue: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const config = { ...(configValue ?? {}) };
  // biome-ignore lint/performance/noDelete: The key must be absent from the public response, not undefined.
  delete config.serviceKey;
  return config;
}
