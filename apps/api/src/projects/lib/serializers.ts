import { config } from '../../config';
import { isSecretUsableBy, loadGrants, scopeToIntent, type SecretGrant, type ShareSubject, visibilityToIntent } from '../../executor/share';
import { resolveWarmConfig, warmPoolEnabled } from '../../platform/services/warm-pool';
import { db } from '../../shared/db';
import { listSandboxTemplates, listSnapshotBuilds } from '../../snapshots/builder';
import { type ProjectRole } from '../access';
import { resolveAppsEnabled } from '../apps-config';
import { resolveExperimentalFeatures, buildExperimentalCatalog } from '../../experimental/features';
import { isGithubAppConfigured, type GitHubRepo } from '../github';
import { accountGithubInstallations, deployments, projectGitConnections, projectGitCredentials, projectSecrets, projectSessions, projects } from '@kortix/db';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { Context } from 'hono';
import { parseGitHubRepoUrl } from './git';
import { proxyGitUrl } from './sessions';

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';

export type ProjectRow = typeof projects.$inferSelect;

export type ProjectGitConnectionRow = typeof projectGitConnections.$inferSelect;

export type ProjectGitCredentialRow = typeof projectGitCredentials.$inferSelect;

export type ProjectSessionRow = typeof projectSessions.$inferSelect;

export type RequestAuditContext = {
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
};

export const UUID_V4_REGEX = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const ACTIVE_SESSION_STATUSES = ['queued', 'branching', 'provisioning', 'running'] as const;

export const PROVISIONING_SESSION_STATUSES = ['queued', 'branching', 'provisioning'] as const;

export const PROJECT_GIT_AUTH_SECRET_NAME = 'KORTIX_GIT_AUTH_TOKEN';


export function serializeSession(
  row: ProjectSessionRow,
  ctx?: {
    /** The grants on this session (for restricted visibility). */
    grants?: SecretGrant[];
    /** The viewing user, to compute is_owner / can_manage_sharing. */
    viewerId?: string;
    /** Viewer can manage the project (owner/admin/manager). */
    canManageProject?: boolean;
    /** Resolved email of the session owner, for "shared by X" display. */
    ownerEmail?: string | null;
  },
) {
  const opencodeSessions = Array.isArray(row.metadata?.opencode_sessions)
    ? row.metadata.opencode_sessions
    : [];
  const isOwner = ctx?.viewerId ? row.createdBy === ctx.viewerId : false;
  // A user-set name (metadata.custom_name) is authoritative and ALWAYS wins
  // over the auto title (metadata.name) that opencode mirrors via
  // /v1/projects/sync-opencode-sessions. `name` is the resolved display value;
  // `custom_name` is exposed separately so clients can tell an override apart
  // from the auto title (e.g. to beat the live opencode root title).
  const customName = typeof row.metadata?.custom_name === 'string' ? row.metadata.custom_name : null;
  const autoName = typeof row.metadata?.name === 'string' ? row.metadata.name : null;
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
    name: customName ?? autoName,
    custom_name: customName,
    agent_name: row.agentName,
    status: row.status,
    error: row.error,
    metadata: row.metadata ?? {},
    opencode_sessions: opencodeSessions,
    // Ownership + org-visibility (Phase 2 session sharing).
    created_by: row.createdBy,
    owner_email: ctx?.ownerEmail ?? null,
    visibility: row.visibility,
    sharing: visibilityToIntent(row.visibility as 'private' | 'project' | 'restricted', ctx?.grants ?? []),
    is_owner: isOwner,
    can_manage_sharing: isOwner || Boolean(ctx?.canManageProject),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Load a session and enforce that the viewer can SEE it (owner, project-wide,
 * or in the allow-list). Returns null for both not-found and not-visible so we
 * never reveal the existence of a private session. Also reports whether the
 * viewer may manage its sharing (owner or project manager).
 */

export function dashboardBaseUrl(): string {
  return (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

/** True when a GitHub repo-create error is a name collision (HTTP 422). On
 *  POST /user/repos a 422 is, in practice, always "name already exists". */

export function isRepoNameTakenError(error: unknown): boolean {
  const m = ((error as Error)?.message ?? '').toLowerCase();
  return m.includes('already exists') || m.includes('name already') || m.includes('(422)');
}


export function serializeProject(row: ProjectRow, access?: { projectRole: ProjectRole | null; effectiveRole: ProjectRole }) {
  return {
    project_id: row.projectId,
    account_id: row.accountId,
    name: row.name,
    repo_url: row.repoUrl,
    // Universal client-facing git origin. When the proxy is enabled, runtime
    // clients (CLI `ship`, web) clone/push this with a Kortix token instead of
    // the real host URL. Falls back to repo_url so callers can always use it.
    git_origin_url: config.KORTIX_GIT_PROXY ? proxyGitUrl(row.projectId) : row.repoUrl,
    default_branch: row.defaultBranch,
    manifest_path: row.manifestPath,
    status: row.status,
    metadata: row.metadata ?? {},
    last_opened_at: row.lastOpenedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    project_role: access?.projectRole ?? null,
    effective_project_role: access?.effectiveRole ?? null,
    dashboard_url: `${dashboardBaseUrl()}/projects/${row.projectId}`,
    // Single source of truth for the experimental [[apps]] surface. Threading
    // the EFFECTIVE per-project value onto the project payload lets the web
    // client gate the Apps section + sidebar shortcut off the SAME gate that
    // gates the API routes. Per-project override (metadata.apps_enabled) wins;
    // KORTIX_APPS_EXPERIMENTAL is the default for projects that haven't chosen.
    // Experimental features (Customize → Settings → Experimental) — `experimental`
    // is the effective on/off map; `experimental_features` is the self-describing
    // catalog the UI renders from. SoT = ../../experimental/features.
    experimental: resolveExperimentalFeatures(row.metadata),
    experimental_features: buildExperimentalCatalog(row.metadata),
    apps_enabled: resolveAppsEnabled(row.metadata),
    // Warm sandbox pool (Customize → Sandbox). `warm_pool` is the effective
    // per-project config (UI value over the operator default); `warm_pool_available`
    // gates the UI control off the platform feature flag.
    warm_pool: resolveWarmConfig(row.metadata),
    warm_pool_available: warmPoolEnabled(),
  };
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


export function serializeGitHubRepo(repo: GitHubRepo) {
  return {
    id: String(repo.id),
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    default_branch: repo.default_branch,
    description: repo.description,
  };
}


export function clientIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || null;
}


export function requestAuditContext(c: Context): RequestAuditContext {
  return {
    method: c.req.method,
    path: c.req.path,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') || null,
  };
}


export type SecretRow = typeof projectSecrets.$inferSelect;

/**
 * The per-user view of one secret KEY: the shared/project row (what managers
 * control + who it's shared with) merged with the requesting member's own
 * private override, plus which one actually wins for them at runtime. This is
 * what powers the "use shared / use mine" choice in the UI.
 */

export function buildSecretView(input: {
  name: string;
  shared?: SecretRow;
  sharedGrants?: SecretGrant[];
  personal?: SecretRow;
  subject: ShareSubject;
  canManageShared: boolean;
}) {
  const { name, shared, sharedGrants = [], personal, subject, canManageShared } = input;
  const system = isSystemProjectSecretName(name);
  const isGitAuth = name === PROJECT_GIT_AUTH_SECRET_NAME;
  const usableByMe = shared
    ? isSecretUsableBy(shared.shareScope as 'project' | 'restricted', sharedGrants, subject)
    : false;
  const mineActive = Boolean(personal?.active);
  const effectiveSource: 'mine' | 'shared' | 'none' =
    personal && mineActive ? 'mine' : usableByMe ? 'shared' : 'none';
  return {
    name,
    project_id: (shared ?? personal)!.projectId,
    secret_id: shared?.secretId ?? null,
    created_by: shared?.createdBy ?? null,
    created_at: (shared?.createdAt ?? personal?.createdAt)?.toISOString() ?? null,
    updated_at: (shared?.updatedAt ?? personal?.updatedAt)?.toISOString() ?? null,
    system,
    readonly: system,
    purpose: isGitAuth ? 'git_auth' : null,
    can_rotate: isGitAuth,
    managed_by: isGitAuth ? 'project_secret' : null,
    // The SHARED row: is a project value set, who can use it, and can it reach me.
    configured: Boolean(shared),
    share_scope: shared?.shareScope ?? 'project',
    sharing: shared ? scopeToIntent(shared.shareScope as 'project' | 'restricted', sharedGrants) : null,
    usable_by_me: usableByMe,
    // MY private override (value never returned), and whether I'm using it.
    mine: personal ? { active: personal.active, updated_at: personal.updatedAt.toISOString() } : null,
    // What actually gets injected into my sessions for this key.
    effective_source: effectiveSource,
    // Members manage only their own override; managers also manage the shared row.
    can_manage_shared: canManageShared && !system,
  };
}

/**
 * Load every secret KEY in a project as the per-user view (shared + my own
 * override merged). Used by the secrets list + returned after a write.
 */

export async function loadSecretViewsForUser(
  projectId: string,
  subject: ShareSubject,
  canManageShared: boolean,
): Promise<ReturnType<typeof buildSecretView>[]> {
  const rows = await db
    .select()
    .from(projectSecrets)
    .where(and(
      eq(projectSecrets.projectId, projectId),
      or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, subject.userId)),
    ))
    .orderBy(desc(projectSecrets.updatedAt));

  const byName = new Map<string, { shared?: SecretRow; personal?: SecretRow }>();
  for (const row of rows) {
    const slot = byName.get(row.name) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byName.set(row.name, slot);
  }
  const grants = await loadGrants(rows.filter((r) => r.ownerUserId === null).map((r) => r.secretId));

  return [...byName.entries()].map(([name, slot]) =>
    buildSecretView({
      name,
      shared: slot.shared,
      sharedGrants: slot.shared ? grants.get(slot.shared.secretId) ?? [] : [],
      personal: slot.personal,
      subject,
      canManageShared,
    }),
  );
}


export function isSystemProjectSecretName(name: string): boolean {
  return name.toUpperCase().startsWith('KORTIX_');
}


export function serializeSessionSandboxConfig(configValue: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const config = { ...(configValue ?? {}) };
  delete config.serviceKey;
  return config;
}


export function serializeGitHubInstallation(
  row: typeof accountGithubInstallations.$inferSelect | null,
  accountId: string,
  installUrl: string | null,
) {
  const installed = Boolean(row);
  const metadata = normalizeJsonObject(row?.metadata);
  // GitHub backing is App-only: a per-account App installation is required
  // whenever the App is configured and this account hasn't installed it yet.
  const requiresInstallation = isGithubAppConfigured() && !installed;
  return {
    account_id: accountId,
    installation_row_id: row?.installationRowId ?? null,
    installed,
    configured: isGithubAppConfigured(),
    requires_installation: requiresInstallation,
    install_url: installed ? null : installUrl,
    installation_id: row?.installationId ?? null,
    owner_login: row?.ownerLogin ?? null,
    owner_type: row?.ownerType ?? null,
    repository_selection: row?.repositorySelection ?? null,
    permissions: row?.permissions ?? {},
    installation_url: normalizeString(metadata.html_url),
    updated_at: row?.updatedAt.toISOString() ?? null,
  };
}


export function serializeGitHubInstallations(
  rows: Array<typeof accountGithubInstallations.$inferSelect>,
  accountId: string,
  installUrl: string | null,
) {
  const primary = rows[0] ?? null;
  const base = serializeGitHubInstallation(primary, accountId, installUrl);
  return {
    ...base,
    installed: rows.length > 0,
    requires_installation: isGithubAppConfigured() && rows.length === 0,
    install_url: installUrl,
    installations: rows.map((row) => serializeGitHubInstallation(row, accountId, null)),
  };
}


export function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}


export function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}


export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}


export function normalizeRepoUrl(value: unknown): string | null {
  const repoUrl = normalizeString(value);
  if (!repoUrl) return null;
  const normalized = repoUrl.replace(/\/+$/, '');
  if (/^http:\/\//i.test(normalized)) {
    throw new Error('repo_url must use HTTPS or git@github.com SSH');
  }
  if (!parseGitHubRepoUrl(normalized)) {
    throw new Error('repo_url must be a GitHub repository URL');
  }
  return normalized;
}


export function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}


export function deriveKortixApiRoot(kortixUrl: string): string {
  return (kortixUrl || 'https://api.kortix.com')
    .replace(/\/+$/, '')
    .replace(/\/v1\/router$/, '')
    .replace(/\/v1$/, '');
}


export function deriveProjectName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const tail = cleaned.split(/[/:]/).filter(Boolean).pop();
  if (!tail) return 'Untitled Project';
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}


export async function readBody(c: Context) {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return {};
  }
}


export function serializeBuildSummary(b: Awaited<ReturnType<typeof listSnapshotBuilds>>[number]) {
  return {
    build_id: b.buildId,
    slug: b.slug,
    snapshot_name: b.snapshotName,
    content_hash: b.contentHash,
    status: b.status,
    error: b.error,
    error_category: b.errorCategory,
    source: b.source,
    started_at: b.startedAt.toISOString(),
    finished_at: b.finishedAt?.toISOString() ?? null,
  };
}


export function serializeTemplate(t: Awaited<ReturnType<typeof listSandboxTemplates>>[number]) {
  return {
    template_id: t.templateId,
    slug: t.slug,
    name: t.name,
    is_default: t.isDefault,
    source: t.source,
    provider: t.provider,
    has_dockerfile: t.hasDockerfile,
    has_image: t.hasImage,
    image: t.image,
    dockerfile_path: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memory_gb: t.memoryGb,
    disk_gb: t.diskGb,
    snapshot_name: t.snapshotName,
    content_hash: t.contentHash,
    built_from_commit: t.builtFromCommit,
    daytona_state: t.daytonaState,
    provider_state: t.providerState,
    ready: t.ready,
  };
}


export function serializeDeploymentRow(row: typeof deployments.$inferSelect) {
  return {
    deployment_id: row.deploymentId,
    account_id: row.accountId,
    project_id: row.projectId,
    app_slug: row.appSlug,
    provider: row.provider,
    status: row.status,
    source_type: row.sourceType,
    source_ref: row.sourceRef,
    framework: row.framework,
    domains: row.domains,
    live_url: row.liveUrl,
    env_vars: row.envVars,
    build_config: row.buildConfig,
    error: row.error,
    version: row.version,
    freestyle_id: row.freestyleId,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}


export const PROJECT_ROLES = ['manager', 'editor', 'viewer'] as const;

export type ProjectGroupGrantRole = typeof PROJECT_ROLES[number];


export function isProjectRole(v: unknown): v is ProjectGroupGrantRole {
  return typeof v === 'string' && (PROJECT_ROLES as readonly string[]).includes(v);
}

// GET /v1/projects/:projectId/group-grants
// List every group attached to this project, with the role + group name.
