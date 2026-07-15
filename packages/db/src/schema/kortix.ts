import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const kortixSchema = pgSchema('kortix');

export const sandboxStatusEnum = kortixSchema.enum('sandbox_status', [
  'provisioning',
  'active',
  'stopped',
  'archived',
  'error',
]);

export const sandboxProviderEnum = kortixSchema.enum('sandbox_provider', [
  'daytona',
  'platinum',
  'e2b',
]);

export const projectStatusEnum = kortixSchema.enum('project_status', ['active', 'archived']);

export const projectSessionStatusEnum = kortixSchema.enum('project_session_status', [
  'queued',
  'branching',
  'provisioning',
  'running',
  'stopped',
  'failed',
  'completed',
]);

export const sessionLifecycleCommandStatusEnum = kortixSchema.enum(
  'session_lifecycle_command_status',
  ['queued', 'running', 'succeeded', 'failed', 'dead_lettered'],
);

// `member` is the floor project role (renamed from `user`, see the
// project_role_member_rename migration). `user` and the older `viewer` are
// DEPRECATED — both fold into `member` via parseProjectRole/normalizeProjectRole
// and are no longer assignable. `viewer` lingers because Postgres can't drop an
// enum member; `user` was renamed in place. Nothing reads or writes either.
export const projectRoleEnum = kortixSchema.enum('project_role', [
  'manager',
  'editor',
  'member',
  'viewer',
]);

export const projectAccessRequestStatusEnum = kortixSchema.enum('project_access_request_status', [
  'pending',
  'approved',
  'rejected',
]);

export const apiKeyStatusEnum = kortixSchema.enum('api_key_status', [
  'active',
  'revoked',
  'expired',
]);

export const apiKeyTypeEnum = kortixSchema.enum('api_key_type', ['user', 'sandbox']);

// ─── Accounts & Members ─────────────────────────────────────────────────────
// Replaces basejump.account_user. Fully kortix-native.

export const accountRoleEnum = kortixSchema.enum('account_role', ['owner', 'admin', 'member']);

export const accounts = kortixSchema.table('accounts', {
    accountId: uuid('account_id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    setupCompleteAt: timestamp('setup_complete_at', { withTimezone: true }),
    setupWizardStep: integer('setup_wizard_step').default(0).notNull(),
    // When true the IAM engine rejects every browser/JWT request whose
    // session is not at AAL2 (MFA-verified). PATs are exempt — they're
    // expected to gate via per-policy require_mfa conditions instead.
    // Super-admins are also exempt so flipping the switch can never
    // permanently lock the account out.
    mfaRequired: boolean('mfa_required').default(false).notNull(),
    // Maximum lifetime of a session, measured from the JWT's `iat`
    // claim. NULL = no max (Supabase default — refresh tokens never
    // expire on their own). 0 < value ≤ 7*24*60 (one week ceiling).
    sessionMaxLifetimeMinutes: integer('session_max_lifetime_minutes'),
    // Idle timeout: a session is killed after this many minutes of no
    // requests against this account. NULL = no idle gate. We update
    // last_seen at most every 60s to keep DB write pressure bounded.
    sessionIdleTimeoutMinutes: integer('session_idle_timeout_minutes'),
    // PAT lifecycle policy (CLI Personal Access Tokens). All three
    // independent — admins can mix any combination.
    /** When set, PATs whose requested `expires_at` is further out than
     *  this are refused at mint. NULL = no ceiling. Units: days. */
    patMaxLifetimeDays: integer('pat_max_lifetime_days'),
    /** When true, minting a PAT without an `expires_at` is refused.
     *  Pairs with patMaxLifetimeDays — admins typically set both. */
    patRequireExpiry: boolean('pat_require_expiry').default(false).notNull(),
    /** When set, PATs not used in this many days are auto-revoked on
     *  next validate. NULL = no idle gate. Units: days. */
    patIdleRevokeDays: integer('pat_idle_revoke_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accountMembers = kortixSchema.table(
  'account_members',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    accountRole: accountRoleEnum('account_role').default('owner').notNull(),
    // Super-admin bypasses all IAM permission evaluation. Distinct from accountRole.
    isSuperAdmin: boolean('is_super_admin').default(false).notNull(),
    // External identifier set by an upstream IdP via SCIM. Null = managed
    // locally (invited via UI or API). When set, the IdP "owns" this row —
    // deactivating the user there should mirror here.
    scimExternalId: text('scim_external_id'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Composite primary key — REQUIRED so `INSERT ... ON CONFLICT (user_id,
    // account_id)` (invite accept, member add, YOLO seat mgmt) has a matching
    // constraint. Declared as a table-level primaryKey (not just a uniqueIndex)
    // so `drizzle-kit push` materializes a real constraint; a bare uniqueIndex
    // was silently skipped by push, leaving the table constraint-less and
    // every ON CONFLICT path 500ing with 42P10. See migration 105.
    primaryKey({ columns: [table.userId, table.accountId] }),
    index('idx_account_members_user_id').on(table.userId),
    index('idx_account_members_account_id').on(table.accountId),
    uniqueIndex('idx_account_members_user_account').on(table.userId, table.accountId),
  ],
);

// Pending invitations for users not yet members (or not yet signed up). On
// signup or first /v1/accounts call we auto-claim invites matching the user's
// email and convert them into account_members rows.
export const accountInvitations = kortixSchema.table(
  'account_invitations',
  {
    inviteId: uuid('invite_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    invitedBy: uuid('invited_by'),
    initialRole: accountRoleEnum('initial_role').default('member').notNull(),
    /** Optional list of project grants to apply when the invite is
     *  accepted. Lets a project admin invite a non-Kortix user "into
     *  project X as Editor" in one step — the system creates an
     *  account invite + records the project grant here; on accept,
     *  the user joins the org as a member AND gets the project role
     *  in the same transaction. Shape:
     *    [{ project_id: uuid, role: 'manager'|'editor'|'member',
     *       expires_at?: iso }]
     *  Multiple grants are allowed — the same email could be invited
     *  to several projects at once via repeated calls (they upsert).
     *  Legacy rows may carry the retired 'user'/'viewer' role; readers
     *  fold both into 'member' via parseProjectRole.
     *  Also carries `{ group_id }` entries: a SCIM Group membership pushed for a
     *  user who hasn't logged in yet (a pending invite, no user row) is parked
     *  here and materialized into account_group_members on acceptance — same
     *  ride-along pattern as project grants. */
    bootstrapGrants:
      jsonb('bootstrap_grants').$type<
      Array<
          | {
              project_id: string;
              role: 'manager' | 'editor' | 'member';
              expires_at?: string | null;
            }
        | { group_id: string }
      >
    >(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .default(sql`now() + interval '14 days'`)
      .notNull(),
  },
  (table) => [
    index('idx_account_invitations_email').on(table.email),
    index('idx_account_invitations_account').on(table.accountId),
    index('idx_account_invitations_expires_at').on(table.expiresAt),
    uniqueIndex('idx_account_invitations_pending').on(table.accountId, table.email),
  ],
);

export const accountGithubInstallations = kortixSchema.table(
  'account_github_installations',
  {
    installationRowId: uuid('installation_row_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    ownerLogin: varchar('owner_login', { length: 255 }).notNull(),
    ownerType: varchar('owner_type', { length: 32 }).default('Organization').notNull(),
    repositorySelection: varchar('repository_selection', { length: 32 }),
    permissions: jsonb('permissions').default({}).$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_github_installations_account').on(table.accountId),
    uniqueIndex('idx_account_github_installations_account_installation').on(
      table.accountId,
      table.installationId,
    ),
    index('idx_account_github_installations_owner').on(table.ownerLogin),
  ],
);

export const accountGithubInstallationStates = kortixSchema.table(
  'account_github_installation_states',
  {
    stateNonce: text('state_nonce').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    installationId: text('installation_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_github_installation_states_account').on(table.accountId),
    index('idx_account_github_installation_states_expires_at').on(table.expiresAt),
  ],
);

// ─── Projects ───────────────────────────────────────────────────────────────
// New project-first model. A project is the Git-backed source of truth for a
// company/repo. Legacy sandboxes remain below as compute/runtime state.

export const projects = kortixSchema.table(
  'projects',
  {
    projectId: uuid('project_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    repoUrl: text('repo_url').notNull(),
    defaultBranch: varchar('default_branch', { length: 255 }).default('main').notNull(),
    manifestPath: text('manifest_path').default('kortix.yaml').notNull(),
    status: projectStatusEnum('status').default('active').notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_projects_account').on(table.accountId),
    index('idx_projects_status').on(table.status),
    index('idx_projects_updated').on(table.updatedAt),
    index('idx_projects_account_repo').on(table.accountId, table.repoUrl),
  ],
);

export const projectGitConnections = kortixSchema.table(
  'project_git_connections',
  {
    connectionId: uuid('connection_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    repoUrl: text('repo_url').notNull(),
    /**
     * Real upstream git URL on the host (e.g. github.com/…).
     * Distinct from repoUrl, which is the client-facing Kortix git-proxy URL.
     * Server-side git + the proxy resolve the real host through this; clients
     * never see it. Null on legacy rows (defaults to repoUrl).
     */
    upstreamUrl: text('upstream_url'),
    /** True when Kortix provisioned this repo (vs a BYO/linked repo). */
    managed: boolean('managed').default(false).notNull(),
    repoOwner: varchar('repo_owner', { length: 255 }),
    repoName: varchar('repo_name', { length: 255 }),
    externalRepoId: text('external_repo_id'),
    defaultBranch: varchar('default_branch', { length: 255 }).default('main').notNull(),
    authMethod: varchar('auth_method', { length: 64 }).notNull(),
    installationId: text('installation_id'),
    credentialRef: text('credential_ref'),
    permissions: jsonb('permissions').default({}).$type<Record<string, unknown>>(),
    visibility: varchar('visibility', { length: 32 }),
    webhookId: text('webhook_id'),
    status: varchar('status', { length: 32 }).default('connected').notNull(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastErrorMessage: text('last_error_message'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_git_connections_account').on(table.accountId),
    uniqueIndex('idx_project_git_connections_project').on(table.projectId),
    index('idx_project_git_connections_provider_repo').on(table.provider, table.externalRepoId),
    index('idx_project_git_connections_status').on(table.status),
  ],
);

export const projectGitCredentials = kortixSchema.table(
  'project_git_credentials',
  {
    credentialId: uuid('credential_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 32 }).notNull(),
    authMethod: varchar('auth_method', { length: 64 }).default('token').notNull(),
    valueEnc: text('value_enc').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_git_credentials_account').on(table.accountId),
    uniqueIndex('idx_project_git_credentials_project_provider').on(table.projectId, table.provider),
  ],
);

export const projectMembers = kortixSchema.table(
  'project_members',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    projectRole: projectRoleEnum('project_role').default('member').notNull(),
    grantedBy: uuid('granted_by'),
    /** Optional auto-revoke timestamp. NULL = permanent grant.
     *  When set and in the past, the V2 engine treats the row as if it
     *  didn't exist. A periodic sweeper emits one audit event per
     *  expiry then leaves the row in place (deferred cleanup keeps the
     *  audit trail readable). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_members_account_user').on(table.accountId, table.userId),
    index('idx_project_members_project').on(table.projectId),
    uniqueIndex('idx_project_members_project_user').on(table.projectId, table.userId),
  ],
);

export const projectAccessRequests = kortixSchema.table(
  'project_access_requests',
  {
    requestId: uuid('request_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    requesterUserId: uuid('requester_user_id').notNull(),
    requesterEmail: varchar('requester_email', { length: 255 }).notNull(),
    message: text('message'),
    status: projectAccessRequestStatusEnum('status').default('pending').notNull(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_access_requests_project').on(table.projectId),
    index('idx_project_access_requests_account').on(table.accountId),
    index('idx_project_access_requests_requester').on(table.requesterUserId),
    index('idx_project_access_requests_status').on(table.status),
    uniqueIndex('idx_project_access_requests_pending_unique')
      .on(table.projectId, table.requesterUserId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * Generic member/group sharing scope + principal-kind enums, shared by several
 * `restricted`-allow-list features. `project_secrets` itself no longer uses
 * either (secret sharing was retired — a secret is always project-wide; see
 * migration 20260706_secrets_v2_identifier_model.sql) — these stay because
 * `executor_connectors`/`executor_connector_grants` (connector sharing) and
 * `project_session_grants` (session visibility) still do.
 */
export const secretShareScopeEnum = kortixSchema.enum('secret_share_scope', [
  'project',
  'restricted',
]);

/** Principal kind for a member/group allow-list grant. See doc comment above. */
export const secretGrantPrincipalEnum = kortixSchema.enum('secret_grant_principal', [
  'member',
  'group',
]);

/**
 * Usage scope. `runtime` secrets are injected into the sandbox env at session
 * boot (existing behavior). `connector` secrets are Executor connector
 * credentials / Pipedream connection bindings — resolved SERVER-SIDE by the
 * gateway and NEVER injected into the sandbox.
 */
export const projectSecretScopeEnum = kortixSchema.enum('project_secret_scope', [
  'runtime',
  'connector',
]);

/**
 * A project secret is `{ identifier, name (the KEY), value }`. `identifier` is
 * the unique-per-project handle — the human-facing label AND what an agent's
 * `secrets` grant (kortix.yaml) references. `name` is the env var KEY injected
 * into the sandbox and is deliberately NON-unique: two identifiers (e.g.
 * "GMAPS-primary" / "GMAPS-backup") may share the same key so an agent can be
 * granted one specific value among several candidates for the same env var.
 * Authorization is centralized on the AGENT GRANT (by identifier) — see
 * `agentMayUseEnv` (iam/agent-scope.ts) and `resolveGrantedSecretEnv`
 * (projects/secrets.ts). There is no per-secret member/group sharing and no
 * resource-side agent allow-list on the secret itself (both retired — see
 * migration 20260706_secrets_v2_identifier_model.sql).
 */
export const projectSecrets = kortixSchema.table(
  'project_secrets',
  {
    secretId: uuid('secret_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** Unique per (project, identifier) among SHARED rows. Existing/legacy
     *  rows have identifier === name (backfilled at migration time). */
    identifier: varchar('identifier', { length: 128 }).notNull(),
    /** The env var KEY injected into the sandbox. Non-unique — see doc above. */
    name: varchar('name', { length: 64 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    scope: projectSecretScopeEnum('scope').default('runtime').notNull(),
    // NULL = the shared project-level row. Non-null = that member's PRIVATE
    // per-identifier override (used ONLY by the CODEX_AUTH_JSON per-user
    // provider login today — the general "only me" override was retired, see
    // migration 20260702120000000_unify_secret_access_share_model.sql). Mirrors
    // executor_credentials.userId. See docs/specs/executor.md / iam.md.
    ownerUserId: uuid('owner_user_id'),
    // On a personal override row: whether the member currently uses their own
    // value (true) or has flipped back to the shared one while keeping theirs
    // stored (false). Ignored on shared rows.
    active: boolean('active').default(true).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_secrets_project').on(table.projectId),
    // Non-unique lookup index for by-KEY reads (getProjectSecretValue and friends).
    index('idx_project_secrets_project_name').on(table.projectId, table.name),
    // At most one SHARED row per (project, identifier)…
    uniqueIndex('idx_project_secrets_project_identifier_shared')
      .on(table.projectId, table.identifier)
      .where(sql`${table.ownerUserId} is null`),
    // …and at most one PERSONAL override per (project, name, member) — the
    // CODEX_AUTH_JSON per-user row; unchanged by the identifier model.
    uniqueIndex('idx_project_secrets_project_name_owner')
      .on(table.projectId, table.name, table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
  ],
);

/**
 * Who can see/open a session within the org. `private` (default) = only the
 * creator; `project` = every project member (team-wide); `restricted` = the
 * creator + the members/groups in `project_session_grants`. Mirrors the secret
 * sharing model but defaults to private. See docs/specs/iam.md.
 */
export const projectSessionVisibilityEnum = kortixSchema.enum('project_session_visibility', [
  'private',
  'project',
  'restricted',
]);

export const projectSessions = kortixSchema.table(
  'project_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    branchName: text('branch_name').notNull(),
    baseRef: text('base_ref').default('main').notNull(),
    sandboxProvider: sandboxProviderEnum('sandbox_provider').default('daytona').notNull(),
    sandboxId: text('sandbox_id'),
    sandboxUrl: text('sandbox_url'),
    opencodeSessionId: text('opencode_session_id'),
    agentName: text('agent_name').default('default').notNull(),
    status: projectSessionStatusEnum('status').default('queued').notNull(),
    error: text('error'),
    // Session ownership + org-visibility (default private to the creator).
    createdBy: uuid('created_by'),
    visibility: projectSessionVisibilityEnum('visibility').default('private').notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_sessions_account').on(table.accountId),
    index('idx_project_sessions_project').on(table.projectId),
    index('idx_project_sessions_status').on(table.status),
    index('idx_project_sessions_created_by').on(table.createdBy),
    uniqueIndex('idx_project_sessions_project_branch').on(table.projectId, table.branchName),
    uniqueIndex('idx_project_sessions_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.sessionId,
    ),
    // NOTE: a partial composite index `idx_project_sessions_account_active`
    // ((account_id) WHERE status IN active-set) ALSO exists — created by the
    // hand-written migration drizzle/20260617102106_account_active_session_index.sql
    // to keep the concurrency-cap COUNT O(active) instead of O(full history).
    // It is intentionally NOT declared here: re-adding it would make `db:generate`
    // emit a conflicting `CREATE INDEX` against the already-built index. Manage it
    // via that migration; its predicate mirrors ACTIVE_SESSION_STATUSES.
  ],
);

/**
 * Durable, non-secret wrapper context for one project session. It is kept out
 * of user-editable session metadata and materialized only as the single
 * server-owned KORTIX_SESSION_CONTEXT JSON envelope.
 */
export const projectSessionRuntimeContexts = kortixSchema.table(
  'project_session_runtime_contexts',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    context: jsonb('context').$type<Record<string, string | number | boolean | null>>().notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_session_runtime_contexts_updated').on(table.updatedAt),
    check(
      'project_session_runtime_contexts_byte_size_check',
      sql`${table.byteSize} >= 2 AND ${table.byteSize} <= 16384`,
    ),
    check(
      'project_session_runtime_contexts_object_check',
      sql`jsonb_typeof(${table.context}) = 'object'`,
    ),
  ],
);

// Account-scoped default model preferences. Drives server-side resolution of the
// synthetic `auto` model in the LLM gateway: a request for `auto` resolves to the
// per-agent default (scope='agent', scope_key=agent_name) → the account default
// (scope='account', scope_key='') → the platform default. The stored `model` is a
// gateway wire model (a bare managed id like 'glm-5.2', a BYOK 'provider/model',
// or 'codex/<id>') — never the synthetic `auto`. One row per (account, scope, key).
export const accountModelPreferences = kortixSchema.table(
  'account_model_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    scopeKey: text('scope_key').default('').notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_model_preferences_account').on(table.accountId),
    uniqueIndex('idx_account_model_preferences_scope').on(
      table.accountId,
      table.scope,
      table.scopeKey,
    ),
  ],
);

export interface ProjectLlmRoutingRule {
  model: string;
  fallbackModels: string[];
  fallbackOn: 'transient' | 'any-error';
}

// Project-owned gateway composition. A NULL default_fallback_models inherits
// the operator policy while [] deliberately disables fallback for `auto`.
// The project default model remains in account_model_preferences so every
// existing default-model consumer continues to share one source of truth.
export const projectLlmRoutingPolicies = kortixSchema.table(
  'project_llm_routing_policies',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    visionModel: varchar('vision_model', { length: 128 }),
    defaultFallbackModels: jsonb('default_fallback_models').$type<string[] | null>(),
    defaultFallbackOn: text('default_fallback_on'),
    rules: jsonb('rules').default([]).$type<ProjectLlmRoutingRule[]>().notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'project_llm_routing_policies_fallback_pair_check',
      sql`(${table.defaultFallbackModels} IS NULL AND ${table.defaultFallbackOn} IS NULL) OR (${table.defaultFallbackModels} IS NOT NULL AND ${table.defaultFallbackOn} IN ('transient', 'any-error'))`,
    ),
    check(
      'project_llm_routing_policies_rules_array_check',
      sql`jsonb_typeof(${table.rules}) = 'array'`,
    ),
  ],
);

/**
 * Allow-list for a `restricted` session — which members/groups (besides the
 * owner) can see + open it. Mirrors `project_secret_grants`.
 */
export const projectSessionGrants = kortixSchema.table(
  'project_session_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    principalType: secretGrantPrincipalEnum('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_session_grants_session').on(table.sessionId),
    uniqueIndex('idx_project_session_grants_unique').on(
      table.sessionId,
      table.principalType,
      table.principalId,
    ),
  ],
);

export const projectSessionPublicShares = kortixSchema.table(
  'project_session_public_shares',
  {
    shareId: uuid('share_id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    createdBy: uuid('created_by'),
    resourceType: text('resource_type').default('preview').notNull(),
    label: text('label').default('App preview').notNull(),
    port: integer('port'),
    path: text('path').default('/').notNull(),
    filePath: text('file_path'),
    mode: text('mode').default('view').notNull(),
    allowWebsocket: boolean('allow_websocket').default(false).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_project_session_public_shares_token_hash').on(table.tokenHash),
    index('idx_project_session_public_shares_session').on(table.sessionId),
    index('idx_project_session_public_shares_project').on(table.projectId),
  ],
);

/**
 * Runtime state for triggers defined in the project repo
 * (.opencode/triggers/<slug>.md). The repo holds the trigger config; this
 * row holds the cron scheduler's "last fired" state so we don't need to
 * write a git commit on every fire.
 */
export const projectTriggerRuntime = kortixSchema.table(
  'project_trigger_runtime',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 128 }).notNull(),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    // Observability for "why isn't my trigger running": outcome of the most
    // recent attempt ('fired' | 'queued' | 'failed'), the error if it failed
    // (or a parse error), and when that attempt happened (distinct from
    // last_fired_at, which only advances on a successful/queued fire).
    lastStatus: varchar('last_status', { length: 32 }),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    // The project member this trigger's automated sessions provision AS (the
    // "owner") — the secret-visibility subject and provisioning actor for
    // cron/webhook/manual fires. NULL = fall back to the account owner
    // (legacy behavior). Stored here, not in the portable repo manifest,
    // because a user_id is account-specific. Defaults to the trigger's
    // creator. See resolveTriggerActor(). (No longer feeds connector credential
    // resolution — `per_user` connector credentials were removed 2026-07-05;
    // every connector resolves the one shared credential regardless of owner.)
    ownerUserId: uuid('owner_user_id'),
    // For a `session_mode = 'pinned'` trigger: the exact session it loops. FK so
    // deleting the session auto-clears the pin (the next fire then degrades to
    // reuse/fresh instead of hard-failing on a dangling id) and for observability
    // into which session a pinned trigger drives. Portable source of truth is the
    // manifest `session_id`; this mirrors it for the FK.
    sessionId: text('session_id').references(() => projectSessions.sessionId, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.slug] }),
    index('idx_project_trigger_runtime_owner_user').on(table.ownerUserId),
  ],
);

export const sessionLifecycleCommands = kortixSchema.table(
  'session_lifecycle_commands',
  {
    commandId: uuid('command_id').defaultRandom().primaryKey(),
    commandType: varchar('command_type', { length: 64 }).notNull(),
    source: varchar('source', { length: 64 }).notNull(),
    status: sessionLifecycleCommandStatusEnum('status').default('queued').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => projectSessions.sessionId, {
      onDelete: 'set null',
    }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id'),
    idempotencyKey: text('idempotency_key'),
    payload: jsonb('payload').default({}).notNull().$type<Record<string, unknown>>(),
    result: jsonb('result').default({}).notNull().$type<Record<string, unknown>>(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_session_lifecycle_commands_idempotency').on(table.idempotencyKey),
    index('idx_session_lifecycle_commands_due').on(table.status, table.availableAt),
    index('idx_session_lifecycle_commands_project').on(table.projectId),
    index('idx_session_lifecycle_commands_session').on(table.sessionId),
    index('idx_session_lifecycle_commands_locked').on(table.lockedUntil),
  ],
);

// Workspace ↔ project membership: every project that connected a given Slack
// workspace. Drives project resolution — a channel with no binding auto-binds
// when the workspace has exactly one project, else a picker is shown.
export const chatInstalls = kortixSchema.table(
  'chat_installs',
  {
    installId: uuid('install_id').defaultRandom().primaryKey(),
    platform: varchar('platform', { length: 32 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    connectedAt: timestamp('connected_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_chat_installs_workspace_project').on(
      table.platform,
      table.workspaceId,
      table.projectId,
    ),
    index('idx_chat_installs_workspace').on(table.platform, table.workspaceId),
    index('idx_chat_installs_project').on(table.projectId),
  ],
);

// Per-channel routing: which project owns a specific channel. Bound lazily on
// first use. A NULL projectId means a project picker is posted in that channel
// and awaiting a click.
export const chatChannelBindings = kortixSchema.table(
  'chat_channel_bindings',
  {
    bindingId: uuid('binding_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').references(() => projects.projectId, {
      onDelete: 'cascade',
    }),
    platform: varchar('platform', { length: 32 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    channelId: text('channel_id').notNull(),
    channelName: varchar('channel_name', { length: 256 }),
    channelType: varchar('channel_type', { length: 32 }),
    pickerTs: varchar('picker_ts', { length: 64 }),
    // Per-channel agent + model overrides. Null = use the project/platform
    // default. Sessions started from this channel inherit these so different
    // channels bound to the same project can run different agents/models.
    agentName: varchar('agent_name', { length: 128 }),
    opencodeModel: varchar('opencode_model', { length: 128 }),
    // How Slack users may participate in sessions started from this channel.
    // Default is project-wide sharing: linked project members can join the
    // Slack thread. Teams can opt into owner approval or owner-only.
    conversationPolicy: varchar('conversation_policy', { length: 32 })
      .default('project_open')
      .notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_chat_channel_bindings_channel').on(
      table.platform,
      table.workspaceId,
      table.channelId,
    ),
    index('idx_chat_channel_bindings_project').on(table.projectId),
  ],
);

// Thread → session mapping. First Slack/Telegram message in a thread spawns
// a Kortix session and writes a row here. Follow-up messages in the same
// thread look up the existing session and deliver the prompt as a follow-up
// to opencode — same sandbox, same conversation, no fresh boot.
export const chatThreads = kortixSchema.table(
  'chat_threads',
  {
    threadRowId: uuid('thread_row_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    threadId: text('thread_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_chat_threads_thread').on(table.platform, table.workspaceId, table.threadId),
    index('idx_chat_threads_project').on(table.projectId),
    index('idx_chat_threads_session').on(table.sessionId),
  ],
);

// Short-lived Slack messages waiting for the sender to finish `/login`. The
// login URL carries only this id; the original Slack event stays server-side so
// we can resume the exact message after the account bind succeeds.
export const chatPendingAuthMessages = kortixSchema.table(
  'chat_pending_auth_messages',
  {
    pendingId: uuid('pending_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).default('slack').notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    platformUserId: varchar('platform_user_id', { length: 128 }).notNull(),
    envelope: jsonb('envelope').notNull().$type<Record<string, unknown>>(),
    event: jsonb('event').notNull().$type<Record<string, unknown>>(),
    slackResponseUrl: text('slack_response_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_chat_pending_auth_messages_lookup').on(
      table.workspaceId,
      table.platformUserId,
      table.expiresAt,
    ),
    index('idx_chat_pending_auth_messages_expiry').on(table.expiresAt),
  ],
);

export const chatThreadParticipants = kortixSchema.table(
  'chat_thread_participants',
  {
    participantId: uuid('participant_id').defaultRandom().primaryKey(),
    platform: varchar('platform', { length: 32 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    threadId: text('thread_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    platformUserId: varchar('platform_user_id', { length: 128 }).notNull(),
    userId: uuid('user_id').notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_chat_thread_participants_thread_user').on(
      table.platform,
      table.workspaceId,
      table.threadId,
      table.platformUserId,
    ),
    index('idx_chat_thread_participants_session').on(table.sessionId),
    index('idx_chat_thread_participants_user').on(table.userId),
  ],
);

// Per-user identity binding: maps a chat-platform user (e.g. a Slack user in a
// given workspace) to the Kortix user they authenticated as via `/login`. The
// inbound gate resolves the sender through this table and runs the agent as that
// Kortix user — so each member acts under their OWN credentials/secrets, never
// the installer's. No row = unlinked = blocked until they log in. revokedAt set
// = `/logout`, treated as unlinked. Membership against a project's account is
// re-checked at run time, so this mapping is intentionally workspace-scoped, not
// account-scoped (one workspace can map to multiple projects/accounts).
export const chatUserIdentities = kortixSchema.table(
  'chat_user_identities',
  {
    identityId: uuid('identity_id').defaultRandom().primaryKey(),
    platform: varchar('platform', { length: 32 }).notNull(),
    workspaceId: varchar('workspace_id', { length: 128 }).notNull(),
    platformUserId: varchar('platform_user_id', { length: 128 }).notNull(),
    userId: uuid('user_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idx_chat_user_identities_platform_user').on(
      table.platform,
      table.workspaceId,
      table.platformUserId,
    ),
    index('idx_chat_user_identities_user').on(table.userId),
  ],
);

// Live Slack turn-stream state, shared across API replicas. The agent's
// `slack step` / `slack send` relays land on ANY instance behind the load
// balancer, so the stream handle (which Slack message to update, the steps so
// far, placeholder vs streaming) CANNOT live in one process's memory — a relay
// hitting the non-owning replica would drop (and the final `send` would never
// close the stream). One row per session; upserted per relay, deleted on
// finalize, swept on expiry.
export const chatTurnStreams = kortixSchema.table(
  'chat_turn_streams',
  {
    sessionId: text('session_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    teamId: varchar('team_id', { length: 128 }).notNull(),
    channel: text('channel').notNull(),
    triggerTs: varchar('trigger_ts', { length: 64 }).notNull(),
    messageTs: varchar('message_ts', { length: 64 }),
    streaming: boolean('streaming').notNull().default(false),
    placeholderActive: boolean('placeholder_active').notNull().default(false),
    finalized: boolean('finalized').notNull().default(false),
    steps: jsonb('steps').notNull().default([]),
    originatingEvent: jsonb('originating_event').notNull(),
    // Platform-specific conversation reference for non-Slack channels (Teams:
    // { platform, serviceUrl, conversationId, activityId, streamId, streamSequence }).
    // Slack leaves this null and uses the columns above. Nullable + additive.
    channelRef: jsonb('channel_ref'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_chat_turn_streams_expiry').on(table.expiresAt)],
);

export const teamsPendingUploads = kortixSchema.table(
  'teams_pending_uploads',
  {
    uploadId: text('upload_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    serviceUrl: text('service_url').notNull(),
    conversationId: text('conversation_id').notNull(),
    botId: varchar('bot_id', { length: 128 }),
    filename: text('filename').notNull(),
    contentType: varchar('content_type', { length: 128 }),
    contentBase64: text('content_base64').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_teams_pending_uploads_expiry').on(table.expiresAt)],
);

// Cross-replica dedup of inbound Slack event deliveries. Slack can deliver the
// same event_id more than once (retries); with >1 replica an in-memory set
// dedups per-process only, so a redelivery to another replica re-fires the turn
// (the "random reply in a dead thread" bug). Insert-on-conflict-do-nothing here
// makes "have I handled this event_id?" a single shared decision.
export const chatEventDedup = kortixSchema.table(
  'chat_event_dedup',
  {
    eventId: text('event_id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_chat_event_dedup_expiry').on(table.expiresAt)],
);

// Single-row-per-lock advisory lease for cross-replica leader election (the
// scheduler / sweepers elect one leader so background work doesn't double-run
// across ECS tasks). Previously SQL-migration-only; folded into the schema so
// `kortix.*` is 100% Drizzle-owned and the migration engine has one source.
export const workerLeaderLease = kortixSchema.table('worker_leader_lease', {
  lockKey: text('lock_key').primaryKey(),
  ownerId: text('owner_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-session sandbox runtime row. Decoupled from `kortix.sandboxes` (the
// legacy /instances table) on purpose: project sessions carry no billing
// state, no sandbox_members roster, and no team membership semantics — their
// ACL is enforced via `project_members`.
export const sessionSandboxStatusEnum = kortixSchema.enum('session_sandbox_status', [
  'provisioning',
  'active',
  'stopped',
  'error',
  'archived',
]);

export const sessionSandboxes = kortixSchema.table(
  'session_sandboxes',
  {
    sandboxId: uuid('sandbox_id').primaryKey(),
    sessionId: text('session_id').notNull().unique(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    provider: sandboxProviderEnum('provider').default('daytona').notNull(),
    externalId: text('external_id'),
    baseUrl: text('base_url'),
    status: sessionSandboxStatusEnum('status').default('provisioning').notNull(),
    config: jsonb('config').default({}).$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_session_sandboxes_session').on(table.sessionId),
    index('idx_session_sandboxes_project').on(table.projectId),
    index('idx_session_sandboxes_account').on(table.accountId),
    index('idx_session_sandboxes_status').on(table.status),
    index('idx_session_sandboxes_external_id').on(table.externalId),
  ],
);

/**
 * Provider analytics — an append-only telemetry log, one row per terminal
 * provisioning/migration outcome. Written fire-and-forget from the provision
 * path (the `provisionTimeline` is already computed, so capture is ~free) and
 * survives the session_sandboxes row being deleted (e.g. on migration). Powers
 * the admin Providers → Analytics tab: per-provider success rate, provision
 * latency (p50/p95), and where the time goes (phase marks). Lightweight and
 * non-intrusive — never on the request hot path, no FKs, append-only.
 */
export const providerEvents = kortixSchema.table(
  'provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: text('provider').notNull(),
    // 'provision' (a sandbox-create attempt) | 'migrate' (a cross-provider move)
    kind: text('kind').notNull(),
    // 'ok' | 'error' | 'stopped'
    outcome: text('outcome').notNull(),
    totalMs: integer('total_ms'),
    // Provision timeline marks: [{ label, atMs, deltaMs }]
    marks: jsonb('marks').default([]).$type<unknown[]>(),
    attempts: integer('attempts').default(1),
    // 'capacity' | 'other' for errors; null otherwise.
    errorClass: text('error_class'),
    error: text('error'),
    // For migrate: the source provider moved away from.
    fromProvider: text('from_provider'),
    sessionId: text('session_id'),
    accountId: uuid('account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_provider_events_provider').on(table.provider),
    index('idx_provider_events_kind').on(table.kind),
    index('idx_provider_events_outcome').on(table.outcome),
    index('idx_provider_events_created').on(table.createdAt),
  ],
);

/**
 * Sandbox templates — the durable identity for "a kind of sandbox a session
 * can boot from." One row per template; the platform default is a shared row
 * (project_id NULL, is_shared=true) reused by every project. Per-project
 * custom templates have project_id set.
 *
 * Templates are provider-agnostic: the `provider` column points at which
 * backend will build the image (`daytona` today; future adapters slot in).
 * `provider_state` is a cache of the live registry state for the UI — boot
 * still asks the provider directly, so cache drift is harmless.
 *
 * Sources of truth:
 *   - kortix.yaml `sandbox.templates` entries → upserted into this table on read
 *     so TOML stays code-as-truth. The upsert keys on (project_id, slug).
 *   - UI-created templates → live here only (no TOML), marked source='ui'.
 *
 * Built-image identity is content-addressed via `content_hash` (same scheme
 * as before); `provider_snapshot_name` is what the provider stores it under.
 */
export const sandboxTemplates = kortixSchema.table(
  'sandbox_templates',
  {
    templateId: uuid('template_id').defaultRandom().primaryKey(),
    /**
     * Owning project. NULL for the platform-shared default(s), which any
     * project may boot a session from.
     */
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.accountId, { onDelete: 'cascade' }),
    /** Unique per project (or globally for shared templates). User-visible. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** True iff this is a globally shared template (the platform default). */
    isShared: boolean('is_shared').default(false).notNull(),
    /** Where the template came from: 'platform' | 'toml' | 'ui'. */
    source: text('source').default('toml').notNull(),
    /** 'daytona' (others to follow). */
    provider: text('provider').default('daytona').notNull(),

    // ─── Image definition (exactly one of image / dockerfilePath) ──────────
    /** Public Docker image reference (e.g. python:3.12-slim). */
    image: text('image'),
    /** Repo-relative path to a Dockerfile. Mutually exclusive with `image`. */
    dockerfilePath: text('dockerfile_path'),
    /** Optional entrypoint override. */
    entrypoint: text('entrypoint'),

    // ─── Resources ─────────────────────────────────────────────────────────
    cpu: integer('cpu'),
    memoryGb: integer('memory_gb'),
    diskGb: integer('disk_gb'),

    // ─── Live state (cached; provider is source of truth) ──────────────────
    /** Content hash of the template inputs — the snapshot identity. */
    contentHash: text('content_hash'),
    /**
     * Git commit the template's Dockerfile was last built from. NULL for the
     * platform default (constant Dockerfile) and image-only templates. Lets the
     * UI show "built from <sha>" and lets a reconcile decide whether a merged
     * Dockerfile change drifted the identity.
     */
    builtFromCommit: text('built_from_commit'),
    /**
     * Agent-swap eligibility key of the last build: user image + spec + NON-agent
     * runtime layer (everything the kortix-agent CAS swap does NOT touch). The
     * builder swaps the agent in place of a full rebuild ONLY when the new
     * identity's swapKey equals this stored value — i.e. the agent binary is the
     * sole delta. NULL for rows built before this column / the platform default
     * until first build → those rebuild. See snapshots/builder.ts maybeSwapAgent.
     */
    swapKey: text('swap_key'),
    /** Provider-side snapshot name (e.g. `kortix-default-…`, `kortix-tpl-…`). */
    providerSnapshotName: text('provider_snapshot_name'),
    /** Last-known provider state: 'active' | 'building' | 'pulling' | 'error' | 'missing'. */
    providerState: text('provider_state').default('missing').notNull(),
    /** Last successful build's finishedAt. */
    lastBuiltAt: timestamp('last_built_at', { withTimezone: true }),
    /** Last error message (capped). */
    lastError: text('last_error'),

    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_sandbox_templates_project').on(table.projectId),
    index('idx_sandbox_templates_shared').on(table.isShared),
    uniqueIndex('idx_sandbox_templates_project_slug').on(table.projectId, table.slug),
  ],
);

/**
 * Append-only log of every snapshot build attempt. NOT consulted on session
 * boot — boot is stateless (asks Daytona directly via the content-addressed
 * name). The log exists for UI: build history, the failure error string used
 * by "Fix with agent", and proactive pre-builds tracked by the dashboard.
 *
 * Status transitions: 'building' → 'ready' | 'failed'. Never updated after a
 * terminal state. Drift with Daytona is harmless because nothing reads it on
 * the hot path.
 */
export const projectSnapshotBuilds = kortixSchema.table(
  'project_snapshot_builds',
  {
    buildId: uuid('build_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    branch: text('branch').default('').notNull(),
    snapshotName: text('snapshot_name').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull(), // 'building' | 'ready' | 'failed'
    error: text('error'),
    errorCategory: text('error_category'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_project_snapshot_builds_project_recent').on(table.projectId, table.startedAt.desc()),
    index('idx_project_snapshot_builds_status').on(
      table.projectId,
      table.status,
      table.startedAt.desc(),
    ),
  ],
);

export const sandboxes = kortixSchema.table(
  'sandboxes',
  {
    sandboxId: uuid('sandbox_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    // Historical /instances audit rows may carry retired providers. Current
    // session runtimes use the strict sandbox_provider enum.
    provider: text('provider').default('daytona').notNull(),
    externalId: text('external_id'),
    status: sandboxStatusEnum('status').default('provisioning').notNull(),
    baseUrl: text('base_url').notNull(),
    config: jsonb('config').default({}).$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Billing: tracks included vs additional (paid) instances
    isIncluded: boolean('is_included').default(false).notNull(),
    stripeSubscriptionItemId: text('stripe_subscription_item_id'),
  },
  (table) => [
    index('idx_sandboxes_account').on(table.accountId),
    index('idx_sandboxes_external_id').on(table.externalId),
    index('idx_sandboxes_status').on(table.status),
  ],
);

export const scopeEffectEnum = kortixSchema.enum('scope_effect', ['grant', 'revoke']);

export const sandboxMembers = kortixSchema.table(
  'sandbox_members',
  {
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.sandboxId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    addedBy: uuid('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
    monthlySpendCapCents: integer('monthly_spend_cap_cents'),
    currentPeriodCents: integer('current_period_cents').notNull().default(0),
    currentPeriodStart: bigint('current_period_start', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('idx_sandbox_members_unique').on(table.sandboxId, table.userId),
    index('idx_sandbox_members_user').on(table.userId),
    index('idx_sandbox_members_sandbox').on(table.sandboxId),
  ],
);

export const sandboxMemberScopes = kortixSchema.table(
  'sandbox_member_scopes',
  {
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.sandboxId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    scope: text('scope').notNull(),
    effect: scopeEffectEnum('effect').notNull(),
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_sandbox_member_scopes_unique').on(table.sandboxId, table.userId, table.scope),
    index('idx_sandbox_member_scopes_lookup').on(table.sandboxId, table.userId),
  ],
);

export const sandboxInvites = kortixSchema.table(
  'sandbox_invites',
  {
    inviteId: uuid('invite_id').defaultRandom().primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.sandboxId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    invitedBy: uuid('invited_by'),
    initialRole: accountRoleEnum('initial_role').default('member').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .default(sql`now() + interval '14 days'`)
      .notNull(),
  },
  (table) => [
    index('idx_sandbox_invites_email').on(table.email),
    index('idx_sandbox_invites_sandbox').on(table.sandboxId),
    index('idx_sandbox_invites_expires_at').on(table.expiresAt),
  ],
);

export const legacySandboxMigrations = kortixSchema.table(
  'legacy_sandbox_migrations',
  {
    migrationId: uuid('migration_id').defaultRandom().primaryKey(),
    runId: text('run_id').notNull(),
    sandboxId: uuid('sandbox_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id'),
    sessionId: text('session_id'),
    status: varchar('status', { length: 32 }).default('planned').notNull(),
    mode: varchar('mode', { length: 32 }).default('dry_run').notNull(),
    plan: jsonb('plan').default({}).$type<Record<string, unknown>>().notNull(),
    rollback: jsonb('rollback').default({}).$type<Record<string, unknown>>().notNull(),
    // base64 tar.gz of the legacy OpenCode store; source for on-open chat
    // rehydrate (see migration 00000000000097). Large — select explicitly.
    opencodeArchive: text('opencode_archive'),
    error: text('error'),
    // Durable runner state (see migration 00000000000096). `phase` is the current
    // step the resume worker continues from; `progress` accumulates per-step
    // artifacts (backup url, repo id, discovered opencode session ids, ...);
    // `heartbeatAt` is the lease the resume loop uses to reclaim stalled runs.
    phase: varchar('phase', { length: 32 }),
    progress: jsonb('progress').default({}).$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_legacy_sandbox_migrations_run').on(table.runId),
    index('idx_legacy_sandbox_migrations_sandbox').on(table.sandboxId),
    index('idx_legacy_sandbox_migrations_status').on(table.status),
    index('idx_legacy_sandbox_migrations_account').on(table.accountId),
    index('idx_legacy_sandbox_migrations_heartbeat').on(table.status, table.heartbeatAt),
  ],
);

// Suna (agentpress) → opencode migration. One row per ACCOUNT: all of the
// account's old Suna projects become ONE new project with N sessions (chats),
// each chat's sandbox files archived under legacy/<slug>/. Same durable-runner
// model as legacy_sandbox_migrations (phase/progress/heartbeat lease, resumable
// by the worker), but keyed on account_id since the source is public.resources,
// not kortix.sandboxes.
export const sunaAccountMigrations = kortixSchema.table(
  'suna_account_migrations',
  {
    migrationId: uuid('migration_id').defaultRandom().primaryKey(),
    runId: text('run_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id'),
    status: varchar('status', { length: 32 }).default('planned').notNull(),
    mode: varchar('mode', { length: 32 }).default('dry_run').notNull(),
    plan: jsonb('plan').default({}).$type<Record<string, unknown>>().notNull(),
    error: text('error'),
    phase: varchar('phase', { length: 32 }),
    progress: jsonb('progress').default({}).$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').default(0).notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_suna_account_migrations_status').on(table.status),
    index('idx_suna_account_migrations_account').on(table.accountId),
    index('idx_suna_account_migrations_heartbeat').on(table.status, table.heartbeatAt),
  ],
);

// ─── API Keys (sandbox-scoped) ──────────────────────────────────────────────

export const kortixApiKeys = kortixSchema.table(
  'api_keys',
  {
    keyId: uuid('key_id').defaultRandom().primaryKey(),
    // No FK constraint: session_sandboxes is not guaranteed to exist before
    // older api_keys migrations replay, but API keys are now session-scoped.
    sandboxId: uuid('sandbox_id').notNull(),
    accountId: uuid('account_id').notNull(),
    publicKey: varchar('public_key', { length: 64 }).notNull(),
    secretKeyHash: varchar('secret_key_hash', { length: 128 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    type: apiKeyTypeEnum('type').default('user').notNull(),
    status: apiKeyStatusEnum('status').default('active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_kortix_api_keys_public_key').on(table.publicKey),
    index('idx_kortix_api_keys_secret_hash').on(table.secretKeyHash),
    index('idx_kortix_api_keys_sandbox').on(table.sandboxId),
    index('idx_kortix_api_keys_account').on(table.accountId),
  ],
);

// ─── Account Tokens (Personal Access Tokens for the CLI) ────────────────────
// Account-scoped, minted from the dashboard, used as
// `Authorization: Bearer <kortix_pat_...>` by the `kortix` CLI.

/**
 * Per-agent authorization grant stored on a session's account token. The single
 * canonical shape — imported by the resolution, enforcement, and context layers
 * so it's never re-declared. `kortixCli`/`connectors` are `"all"` (everything,
 * capped at the launching user) or an explicit list; `[]` = deny.
 */
export interface AgentGrant {
  agent: string;
  kortixCli: string[] | 'all';
  connectors: string[] | 'all';
  /** Project-secret IDENTIFIERS (not env-var keys — see project_secrets.identifier)
   *  this agent may receive as sandbox env (and read via the secrets API). 'all'
   *  = every secret in the project (the default for a listed agent when `env` is
   *  omitted, and for the catch-all agent); an explicit list of identifiers
   *  narrows it; [] = none. Two granted identifiers that resolve to the same env
   *  var KEY is a validation error (ambiguous) — see resolveGrantedSecretEnv.
   *  Optional for back-compat with grants minted before this field existed
   *  (treated as 'all'). */
  env?: string[] | 'all';
}

export const accountTokens = kortixSchema.table(
  'account_tokens',
  {
    tokenId: uuid('token_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** When non-null, this token is scoped to a single project — it
     *  can only call `/v1/projects/<project_id>/*` routes and is
     *  rejected by account-level handlers. Session executor tokens also set
     *  sessionId + agentGrant. */
    projectId: uuid('project_id').references(() => projects.projectId, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    publicKey: varchar('public_key', { length: 64 }).notNull(),
    secretKeyHash: varchar('secret_key_hash', { length: 128 }).notNull(),
    status: apiKeyStatusEnum('status').default('active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Per-agent authorization grant for a sandbox session token: which Kortix
     *  CLI/API actions + connector profiles the running agent may use. Resolved
     *  from the kortix.yaml `agents` map at session birth. The launching
     *  user's role is still enforced by route IAM, so effective access is
     *  user role ∩ agentGrant. Null for non-agent tokens (laptop CLI PATs,
     *  etc.) — which keep role-only access. */
    agentGrant: jsonb('agent_grant').$type<AgentGrant>(),
    /** Session this token belongs to (sandbox executor token, session_id =
     *  sandbox_id). Lets the LLM gateway attribute usage_events per-session —
     *  the reaper's reliable activity signal + precise billing. Null for
     *  non-session tokens (laptop CLI PATs, project-scoped operator tokens). */
    sessionId: text('session_id'),
    /** The STANDING IDENTITY this session token acts as. When set, the IAM
     *  engine authorizes the request as this service account (its own policies),
     *  not the launching user — `effective = SA standing role ∩ agentGrant`. The
     *  user_id stays for provenance/audit. NULL = legacy behavior (authorize as
     *  the user). Set at session mint to the agent's auto-provisioned SA.
     *  ON DELETE CASCADE (fail-closed): deleting the SA identity kills its live
     *  session tokens (next call 401s) rather than silently reverting the agent
     *  to the broader launching-user perms — sessions only ever NARROW. */
    serviceAccountId: uuid('service_account_id').references(
      () => serviceAccounts.serviceAccountId,
      {
      onDelete: 'cascade',
      },
    ),
  },
  (table) => [
    uniqueIndex('idx_account_tokens_public_key').on(table.publicKey),
    index('idx_account_tokens_secret_hash').on(table.secretKeyHash),
    index('idx_account_tokens_account').on(table.accountId),
    index('idx_account_tokens_user').on(table.userId),
    index('idx_account_tokens_project').on(table.projectId),
  ],
);

// ─── OAuth2 Provider ──────────────────────────────────────────────────────

export const oauthClients = kortixSchema.table('oauth_clients', {
    clientId: uuid('client_id').defaultRandom().primaryKey(),
    clientSecretHash: varchar('client_secret_hash', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    redirectUris: jsonb('redirect_uris').default([]).$type<string[]>(),
    scopes: jsonb('scopes').default([]).$type<string[]>(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const oauthAuthorizationCodes = kortixSchema.table(
  'oauth_authorization_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 128 }).notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    scopes: jsonb('scopes').default([]).$type<string[]>(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: varchar('code_challenge_method', { length: 10 }).default('S256').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_oauth_codes_code').on(table.code),
    index('idx_oauth_codes_client').on(table.clientId),
    index('idx_oauth_codes_expires').on(table.expiresAt),
  ],
);

export const oauthAccessTokens = kortixSchema.table(
  'oauth_access_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    scopes: jsonb('scopes').default([]).$type<string[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_oauth_access_token_hash').on(table.tokenHash),
    index('idx_oauth_access_tokens_client').on(table.clientId),
    index('idx_oauth_access_tokens_user').on(table.userId),
  ],
);

export const oauthRefreshTokens = kortixSchema.table(
  'oauth_refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    accessTokenId: uuid('access_token_id')
      .notNull()
      .references(() => oauthAccessTokens.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_oauth_refresh_token_hash').on(table.tokenHash),
    index('idx_oauth_refresh_tokens_client').on(table.clientId),
  ],
);

export const sandboxesRelations = relations(sandboxes, ({ one, many }) => ({
  account: one(accounts, {
    fields: [sandboxes.accountId],
    references: [accounts.accountId],
  }),
  apiKeys: many(kortixApiKeys),
  members: many(sandboxMembers),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  account: one(accounts, {
    fields: [projects.accountId],
    references: [accounts.accountId],
  }),
  gitConnections: many(projectGitConnections),
  gitCredentials: many(projectGitCredentials),
  members: many(projectMembers),
  secrets: many(projectSecrets),
  sessions: many(projectSessions),
}));

export const projectGitConnectionsRelations = relations(projectGitConnections, ({ one }) => ({
  account: one(accounts, {
    fields: [projectGitConnections.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectGitConnections.projectId],
    references: [projects.projectId],
  }),
}));

export const projectGitCredentialsRelations = relations(projectGitCredentials, ({ one }) => ({
  account: one(accounts, {
    fields: [projectGitCredentials.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectGitCredentials.projectId],
    references: [projects.projectId],
  }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  account: one(accounts, {
    fields: [projectMembers.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.projectId],
  }),
}));

export const projectSecretsRelations = relations(projectSecrets, ({ one }) => ({
  project: one(projects, {
    fields: [projectSecrets.projectId],
    references: [projects.projectId],
  }),
}));

export const projectSessionsRelations = relations(projectSessions, ({ one }) => ({
  account: one(accounts, {
    fields: [projectSessions.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectSessions.projectId],
    references: [projects.projectId],
  }),
  runtimeContext: one(projectSessionRuntimeContexts, {
    fields: [projectSessions.sessionId],
    references: [projectSessionRuntimeContexts.sessionId],
  }),
}));

export const projectSessionRuntimeContextsRelations = relations(
  projectSessionRuntimeContexts,
  ({ one }) => ({
    session: one(projectSessions, {
      fields: [projectSessionRuntimeContexts.sessionId],
      references: [projectSessions.sessionId],
    }),
  }),
);

export const sandboxMembersRelations = relations(sandboxMembers, ({ one }) => ({
  sandbox: one(sandboxes, {
    fields: [sandboxMembers.sandboxId],
    references: [sandboxes.sandboxId],
  }),
}));

export const sandboxInvitesRelations = relations(sandboxInvites, ({ one }) => ({
  sandbox: one(sandboxes, {
    fields: [sandboxInvites.sandboxId],
    references: [sandboxes.sandboxId],
  }),
}));

export const kortixApiKeysRelations = relations(kortixApiKeys, ({ one }) => ({
  sandbox: one(sandboxes, {
    fields: [kortixApiKeys.sandboxId],
    references: [sandboxes.sandboxId],
  }),
}));

// ─── Account Relations ──────────────────────────────────────────────────────

export const accountsRelations = relations(accounts, ({ many }) => ({
  members: many(accountMembers),
  githubInstallations: many(accountGithubInstallations),
  projectMembers: many(projectMembers),
  projects: many(projects),
  projectSessions: many(projectSessions),
  sandboxes: many(sandboxes),
  groups: many(accountGroups),
}));

export const accountMembersRelations = relations(accountMembers, ({ one }) => ({
  account: one(accounts, {
    fields: [accountMembers.accountId],
    references: [accounts.accountId],
  }),
}));

export const accountGithubInstallationsRelations = relations(
  accountGithubInstallations,
  ({ one }) => ({
  account: one(accounts, {
    fields: [accountGithubInstallations.accountId],
    references: [accounts.accountId],
  }),
  }),
);

export const auditEvents = kortixSchema.table(
  'audit_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').references(() => accounts.accountId, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_audit_events_account_time').on(table.accountId, table.occurredAt),
    index('idx_audit_events_actor_time').on(table.actorUserId, table.occurredAt),
    index('idx_audit_events_resource').on(table.resourceType, table.resourceId),
  ],
);

export const usageEvents = kortixSchema.table(
  'usage_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    actorUserId: uuid('actor_user_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    route: text('route').notNull(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    cachedTokens: integer('cached_tokens').default(0).notNull(),
    cacheWriteTokens: integer('cache_write_tokens').default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    streaming: boolean('streaming').default(false).notNull(),
    upstreamStatus: integer('upstream_status'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_usage_events_account_time').on(table.accountId, table.createdAt),
    index('idx_usage_events_project_time').on(table.projectId, table.createdAt),
    index('idx_usage_events_session').on(table.sessionId),
    index('idx_usage_events_model').on(table.provider, table.model),
  ],
);

// ─── Gateway (observability + control plane) ───────────────────────────────

export const gatewayRequestLogs = kortixSchema.table(
  'gateway_request_logs',
  {
    logId: uuid('log_id').defaultRandom().primaryKey(),
    requestId: text('request_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id'),
    sessionId: text('session_id'),
    keyId: uuid('key_id'),
    requestedModel: text('requested_model').notNull(),
    resolvedModel: text('resolved_model').notNull(),
    provider: text('provider').notNull(),
    status: integer('status').notNull(),
    ok: boolean('ok').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    latencyMs: integer('latency_ms').default(0).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    candidatesTried: jsonb('candidates_tried').default([]).$type<string[]>(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    cachedTokens: integer('cached_tokens').default(0).notNull(),
    upstreamCost: numeric('upstream_cost', { precision: 12, scale: 6 }).default('0').notNull(),
    finalCost: numeric('final_cost', { precision: 12, scale: 6 }).default('0').notNull(),
    streaming: boolean('streaming').default(false).notNull(),
    billingMode: text('billing_mode'),
    request: jsonb('request').$type<Record<string, unknown>>(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_gateway_logs_request_id').on(table.requestId),
    index('idx_gateway_logs_account_time').on(table.accountId, table.createdAt),
    index('idx_gateway_logs_project_time').on(table.projectId, table.createdAt),
    index('idx_gateway_logs_model').on(table.provider, table.resolvedModel),
    index('idx_gateway_logs_account_ok').on(table.accountId, table.ok),
    index('idx_gateway_logs_session').on(table.projectId, table.sessionId),
  ],
);

export const gatewayApiKeys = kortixSchema.table(
  'gateway_api_keys',
  {
    keyId: uuid('key_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    keyPrefix: varchar('key_prefix', { length: 24 }).notNull(),
    secretKeyHash: varchar('secret_key_hash', { length: 128 }).notNull(),
    status: apiKeyStatusEnum('status').default('active').notNull(),
    createdBy: uuid('created_by'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_gateway_keys_secret_hash').on(table.secretKeyHash),
    index('idx_gateway_keys_project').on(table.projectId),
    index('idx_gateway_keys_account').on(table.accountId),
  ],
);

export const gatewayBudgetScopeEnum = kortixSchema.enum('gateway_budget_scope', [
  'project',
  'member',
]);
export const gatewayBudgetPeriodEnum = kortixSchema.enum('gateway_budget_period', [
  'day',
  'week',
  'month',
]);
export const gatewayBudgetActionEnum = kortixSchema.enum('gateway_budget_action', [
  'block',
  'warn',
]);

export const gatewayBudgets = kortixSchema.table(
  'gateway_budgets',
  {
    budgetId: uuid('budget_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    scope: gatewayBudgetScopeEnum('scope').notNull(),
    subjectUserId: uuid('subject_user_id'),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 4 }).notNull(),
    period: gatewayBudgetPeriodEnum('period').default('month').notNull(),
    action: gatewayBudgetActionEnum('action').default('block').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_gateway_budgets_project').on(table.projectId),
    index('idx_gateway_budgets_lookup').on(table.projectId, table.scope),
  ],
);

// ─── Billing / Credits ─────────────────────────────────────────────────────

export const billingCustomers = kortixSchema.table(
  'billing_customers',
  {
    accountId: uuid('account_id').notNull(),
    id: text().primaryKey().notNull(),
    email: text(),
    active: boolean(),
    provider: text(),
  },
  (table) => [index('idx_kortix_billing_customers_account_id').on(table.accountId)],
);

export const creditAccounts = kortixSchema.table(
  'credit_accounts',
  {
    accountId: uuid('account_id').primaryKey().notNull(),
    balance: numeric('balance', { precision: 12, scale: 4 }).default('0').notNull(),
    lifetimeGranted: numeric('lifetime_granted', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    lifetimePurchased: numeric('lifetime_purchased', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    lifetimeUsed: numeric('lifetime_used', { precision: 12, scale: 4 }).default('0').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    lastGrantDate: timestamp('last_grant_date', { withTimezone: true, mode: 'string' }),
    tier: varchar('tier', { length: 50 }).default('free'),
    billingCycleAnchor: timestamp('billing_cycle_anchor', { withTimezone: true, mode: 'string' }),
    nextCreditGrant: timestamp('next_credit_grant', { withTimezone: true, mode: 'string' }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    expiringCredits: numeric('expiring_credits', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    nonExpiringCredits: numeric('non_expiring_credits', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    dailyCreditsBalance: numeric('daily_credits_balance', { precision: 10, scale: 2 })
      .default('0')
      .notNull(),
    trialStatus: varchar('trial_status', { length: 20 }).default('none'),
    trialStartedAt: timestamp('trial_started_at', { withTimezone: true, mode: 'string' }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true, mode: 'string' }),
    isGrandfatheredFree: boolean('is_grandfathered_free').default(false),
    lastProcessedInvoiceId: varchar('last_processed_invoice_id', { length: 255 }),
    commitmentType: varchar('commitment_type', { length: 50 }),
    commitmentStartDate: timestamp('commitment_start_date', { withTimezone: true, mode: 'string' }),
    commitmentEndDate: timestamp('commitment_end_date', { withTimezone: true, mode: 'string' }),
    commitmentPriceId: varchar('commitment_price_id', { length: 255 }),
    canCancelAfter: timestamp('can_cancel_after', { withTimezone: true, mode: 'string' }),
    lastRenewalPeriodStart: bigint('last_renewal_period_start', { mode: 'number' }),
    paymentStatus: text('payment_status').default('active'),
    lastPaymentFailure: timestamp('last_payment_failure', { withTimezone: true, mode: 'string' }),
    scheduledTierChange: text('scheduled_tier_change'),
    scheduledTierChangeDate: timestamp('scheduled_tier_change_date', {
      withTimezone: true,
      mode: 'string',
    }),
    scheduledPriceId: text('scheduled_price_id'),
    provider: varchar('provider', { length: 20 }).default('stripe'),
    revenuecatCustomerId: varchar('revenuecat_customer_id', { length: 255 }),
    revenuecatSubscriptionId: varchar('revenuecat_subscription_id', { length: 255 }),
    revenuecatCancelledAt: timestamp('revenuecat_cancelled_at', {
      withTimezone: true,
      mode: 'string',
    }),
    revenuecatCancelAtPeriodEnd: timestamp('revenuecat_cancel_at_period_end', {
      withTimezone: true,
      mode: 'string',
    }),
    revenuecatPendingChangeProduct: text('revenuecat_pending_change_product'),
    revenuecatPendingChangeDate: timestamp('revenuecat_pending_change_date', {
      withTimezone: true,
      mode: 'string',
    }),
    revenuecatPendingChangeType: text('revenuecat_pending_change_type'),
    revenuecatProductId: text('revenuecat_product_id'),
    planType: varchar('plan_type', { length: 50 }).default('monthly'),
    stripeSubscriptionStatus: varchar('stripe_subscription_status', { length: 50 }),
    lastDailyRefresh: timestamp('last_daily_refresh', { withTimezone: true, mode: 'string' }),
    autoTopupEnabled: boolean('auto_topup_enabled').default(false).notNull(),
    autoTopupThreshold: numeric('auto_topup_threshold', { precision: 10, scale: 2 })
      .default('5')
      .notNull(),
    autoTopupAmount: numeric('auto_topup_amount', { precision: 10, scale: 2 })
      .default('20')
      .notNull(),
    autoTopupLastCharged: timestamp('auto_topup_last_charged', {
      withTimezone: true,
      mode: 'string',
    }),
    // Billing v2 — per-seat model. Existing rows default to 'legacy' so legacy
    // customers are untouched; new signups use 'per_seat'. The wallet is a
    // single fungible balance; usage breakdown by category comes from
    // aggregating credit_ledger entries by `type` (compute_debit / llm_debit).
    billingModel: text('billing_model').default('legacy').notNull(),
    seatCount: integer('seat_count').default(1).notNull(),
    seatSubscriptionItemId: text('seat_subscription_item_id'),
    autoTopupCustomized: boolean('auto_topup_customized').default(false).notNull(),
    autoTopupConsecutiveFailures: integer('auto_topup_consecutive_failures').default(0).notNull(),
    autoTopupDisabledReason: text('auto_topup_disabled_reason'),
    // Demo/dogfood flag: when true the account gets ALL enterprise entitlements
    // (SSO, SCIM, …) regardless of tier — a self-serve, interactive preview of
    // the enterprise surface. NOT a real Enterprise plan (sales-assigned);
    // production use requires a signed agreement. Default false → fail-closed.
    demoEnterprise: boolean('demo_enterprise').default(false).notNull(),
    // Operator-set concurrent-session cap for this account. NULL (the default)
    // means "no override" — the account's plan tier decides the limit
    // (TierConfig.concurrentSessionLimit). When set, it takes precedence over
    // the tier limit in BOTH directions (raise for enterprise deals, lower for
    // abuse containment). Set out-of-band (data migration / operator SQL),
    // like tier='enterprise'.
    maxConcurrentSessions: integer('max_concurrent_sessions'),
  },
  (table) => [
    index('kortix_credit_accounts_account_id_idx').on(table.accountId),
    index('idx_credit_accounts_billing_model').on(table.billingModel),
  ],
);

// Billing v2 — per-second sandbox compute metering.
// One row per active window. Hibernate closes the row; resume opens a new one.
// Cost flows into credit_ledger as 'compute_debit'; this table is the audit trail.
export const sandboxComputeSessions = kortixSchema.table(
  'sandbox_compute_sessions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountId: uuid('account_id').notNull(),
    sandboxId: uuid('sandbox_id').notNull(),
    sessionId: text('session_id'),
    actorUserId: uuid('actor_user_id'),
    provider: sandboxProviderEnum('provider').default('daytona').notNull(),
    cpuCores: integer('cpu_cores').notNull(),
    memoryGb: integer('memory_gb').notNull(),
    diskGb: integer('disk_gb').notNull(),
    gpuCount: integer('gpu_count').default(0).notNull(),
    state: text().default('active').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    lastBilledAt: timestamp('last_billed_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    ledgerId: uuid('ledger_id'),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_sandbox_compute_sessions_account_time').on(table.accountId, table.startedAt),
    index('idx_sandbox_compute_sessions_provider_time').on(table.provider, table.startedAt),
    index('idx_sandbox_compute_sessions_open')
      .on(table.sandboxId)
      .where(sql`${table.endedAt} IS NULL`),
    uniqueIndex('uniq_sandbox_compute_sessions_one_open')
      .on(table.sandboxId)
      .where(sql`${table.endedAt} IS NULL`),
    index('idx_sandbox_compute_sessions_last_billed')
      .on(table.lastBilledAt)
      .where(sql`${table.state} = 'active'`),
  ],
);

// Billing v2 — per-member Kortix YOLO tokens.
// Token plaintext is returned once at mint and never stored. Sandbox bootstrap
// fetches plaintext from an in-memory/KV cache; cache miss = rotate.
export const stripeWebhookEventsProcessed = kortixSchema.table(
  'stripe_webhook_events_processed',
  {
    eventId: text('event_id').primaryKey().notNull(),
    eventType: text('event_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_stripe_webhook_events_processed_at').on(table.processedAt)],
);

export const yoloMemberTokens = kortixSchema.table(
  'yolo_member_tokens',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.accountId] }),
    index('idx_yolo_member_tokens_prefix')
      .on(table.tokenPrefix)
      .where(sql`${table.revokedAt} IS NULL`),
    index('idx_yolo_member_tokens_account').on(table.accountId),
  ],
);

export const creditLedger = kortixSchema.table(
  'credit_ledger',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountId: uuid('account_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 4 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 12, scale: 4 }).notNull(),
    type: text().notNull(),
    description: text(),
    referenceId: uuid('reference_id'),
    referenceType: text('reference_type'),
    metadata: jsonb().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    createdBy: uuid('created_by'),
    isExpiring: boolean('is_expiring').default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    stripeEventId: varchar('stripe_event_id', { length: 255 }),
    idempotencyKey: text('idempotency_key'),
    processingSource: text('processing_source'),
  },
  (table) => [
    unique('kortix_unique_stripe_event').on(table.stripeEventId),
    index('idx_kortix_credit_ledger_idempotency')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const creditUsage = kortixSchema.table('credit_usage', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  accountId: uuid('account_id').notNull(),
  amountDollars: numeric('amount_dollars', { precision: 10, scale: 2 }).notNull(),
  description: text(),
  usageType: text('usage_type').default('token_overage'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  subscriptionTier: text('subscription_tier'),
  metadata: jsonb().default({}),
});

export const accountDeletionRequests = kortixSchema.table('account_deletion_requests', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  accountId: uuid('account_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: text().default('pending').notNull(),
  reason: text(),
  requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'string' }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
});

export const creditPurchases = kortixSchema.table('credit_purchases', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  accountId: uuid('account_id').notNull(),
  amountDollars: numeric('amount_dollars', { precision: 10, scale: 2 }).notNull(),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  stripeChargeId: text('stripe_charge_id'),
  status: text().default('pending').notNull(),
  description: text(),
  metadata: jsonb().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  provider: varchar('provider', { length: 50 }).default('stripe'),
  revenuecatTransactionId: varchar('revenuecat_transaction_id', { length: 255 }),
  revenuecatProductId: varchar('revenuecat_product_id', { length: 255 }),
});

// ─── Tunnel (Reverse-Tunnel to Local Machine) ──────────────────────────────

export const tunnelStatusEnum = kortixSchema.enum('tunnel_status', [
  'online',
  'offline',
  'connecting',
]);

export const tunnelCapabilityEnum = kortixSchema.enum('tunnel_capability', [
  'filesystem',
  'shell',
  'network',
  'apps',
  'hardware',
  'desktop',
  'gpu',
]);

export const tunnelPermissionStatusEnum = kortixSchema.enum('tunnel_permission_status', [
  'active',
  'revoked',
  'expired',
]);

export const tunnelPermissionRequestStatusEnum = kortixSchema.enum(
  'tunnel_permission_request_status',
  ['pending', 'approved', 'denied', 'expired'],
);

/** Machine info reported by the local agent on connect. */
export interface TunnelMachineInfo {
  hostname: string;
  platform: string;
  arch: string;
  osVersion?: string;
  nodeVersion?: string;
  agentVersion?: string;
  [key: string]: unknown;
}

/** Scope shape for filesystem capability. */
export interface TunnelFilesystemScope {
  paths: string[];
  operations: ('read' | 'write' | 'list' | 'delete')[];
  maxFileSize?: number;
  excludePatterns?: string[];
}

/** Scope shape for shell capability. */
export interface TunnelShellScope {
  commands: string[];
  workingDir?: string;
  maxTimeout?: number;
}

/** Scope shape for network capability. */
export interface TunnelNetworkScope {
  ports: number[];
  hosts: string[];
  protocols: ('http' | 'tcp')[];
}

/** Union of all capability scopes. */
export type TunnelPermissionScope =
  | TunnelFilesystemScope
  | TunnelShellScope
  | TunnelNetworkScope
  | Record<string, unknown>;

export const tunnelConnections = kortixSchema.table(
  'tunnel_connections',
  {
    tunnelId: uuid('tunnel_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    sandboxId: uuid('sandbox_id').references(() => sandboxes.sandboxId, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    status: tunnelStatusEnum('status').default('offline').notNull(),
    capabilities: jsonb('capabilities').default([]).$type<string[]>(),
    machineInfo: jsonb('machine_info').default({}).$type<TunnelMachineInfo>(),
    relayOwnerId: varchar('relay_owner_id', { length: 255 }),
    relayOwnerInstance: varchar('relay_owner_instance', { length: 255 }),
    relayOwnerStartedAt: timestamp('relay_owner_started_at', { withTimezone: true }),
    relayOwnerHeartbeatAt: timestamp('relay_owner_heartbeat_at', { withTimezone: true }),
    setupTokenHash: varchar('setup_token_hash', { length: 128 }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tunnel_connections_account').on(table.accountId),
    index('idx_tunnel_connections_sandbox').on(table.sandboxId),
    index('idx_tunnel_connections_status').on(table.status),
    index('idx_tunnel_connections_relay_owner').on(table.relayOwnerId),
  ],
);

export const tunnelRpcForwards = kortixSchema.table(
  'tunnel_rpc_forwards',
  {
    requestId: uuid('request_id').defaultRandom().primaryKey(),
    tunnelId: uuid('tunnel_id')
      .notNull()
      .references(() => tunnelConnections.tunnelId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    requesterRelayOwnerId: varchar('requester_relay_owner_id', { length: 255 }),
    targetRelayOwnerId: varchar('target_relay_owner_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    method: varchar('method', { length: 255 }).notNull(),
    params: jsonb('params').default({}).$type<Record<string, unknown>>(),
    result: jsonb('result'),
    error: jsonb('error').$type<{ code?: number; message?: string; data?: unknown } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_tunnel_rpc_forwards_target_status').on(
      table.targetRelayOwnerId,
      table.status,
      table.expiresAt,
    ),
    index('idx_tunnel_rpc_forwards_expiry').on(table.expiresAt),
    index('idx_tunnel_rpc_forwards_tunnel').on(table.tunnelId),
  ],
);

export const tunnelPermissions = kortixSchema.table(
  'tunnel_permissions',
  {
    permissionId: uuid('permission_id').defaultRandom().primaryKey(),
    tunnelId: uuid('tunnel_id')
      .notNull()
      .references(() => tunnelConnections.tunnelId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    capability: tunnelCapabilityEnum('capability').notNull(),
    scope: jsonb('scope').default({}).$type<TunnelPermissionScope>(),
    status: tunnelPermissionStatusEnum('status').default('active').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tunnel_permissions_tunnel').on(table.tunnelId),
    index('idx_tunnel_permissions_account').on(table.accountId),
    index('idx_tunnel_permissions_capability').on(table.capability),
    index('idx_tunnel_permissions_status').on(table.status),
  ],
);

export const tunnelPermissionRequests = kortixSchema.table(
  'tunnel_permission_requests',
  {
    requestId: uuid('request_id').defaultRandom().primaryKey(),
    tunnelId: uuid('tunnel_id')
      .notNull()
      .references(() => tunnelConnections.tunnelId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    capability: tunnelCapabilityEnum('capability').notNull(),
    requestedScope: jsonb('requested_scope').default({}).$type<TunnelPermissionScope>(),
    reason: text('reason'),
    status: tunnelPermissionRequestStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tunnel_perm_requests_tunnel').on(table.tunnelId),
    index('idx_tunnel_perm_requests_account').on(table.accountId),
    index('idx_tunnel_perm_requests_status').on(table.status),
  ],
);

export const tunnelAuditLogs = kortixSchema.table(
  'tunnel_audit_logs',
  {
    logId: uuid('log_id').defaultRandom().primaryKey(),
    tunnelId: uuid('tunnel_id')
      .notNull()
      .references(() => tunnelConnections.tunnelId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    capability: tunnelCapabilityEnum('capability').notNull(),
    operation: varchar('operation', { length: 100 }).notNull(),
    requestSummary: jsonb('request_summary').default({}).$type<Record<string, unknown>>(),
    success: boolean('success').notNull(),
    durationMs: integer('duration_ms'),
    bytesTransferred: integer('bytes_transferred'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tunnel_audit_tunnel').on(table.tunnelId),
    index('idx_tunnel_audit_account').on(table.accountId),
    index('idx_tunnel_audit_capability').on(table.capability),
    index('idx_tunnel_audit_created').on(table.createdAt),
  ],
);

export const tunnelDeviceAuthStatusEnum = kortixSchema.enum('tunnel_device_auth_status', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

export const tunnelDeviceAuthRequests = kortixSchema.table(
  'tunnel_device_auth_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deviceCode: varchar('device_code', { length: 9 }).notNull(),
    deviceSecretHash: varchar('device_secret_hash', { length: 128 }).notNull(),
    status: tunnelDeviceAuthStatusEnum('status').default('pending').notNull(),
    machineHostname: varchar('machine_hostname', { length: 255 }),
    accountId: uuid('account_id'),
    tunnelId: uuid('tunnel_id').references(() => tunnelConnections.tunnelId, {
      onDelete: 'set null',
    }),
    setupToken: varchar('setup_token', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_tunnel_device_auth_code').on(table.deviceCode),
    index('idx_tunnel_device_auth_status').on(table.status),
    index('idx_tunnel_device_auth_expires').on(table.expiresAt),
  ],
);

// ─── Tunnel Relations ────────────────────────────────────────────────────────

export const tunnelConnectionsRelations = relations(tunnelConnections, ({ one, many }) => ({
  account: one(accounts, {
    fields: [tunnelConnections.accountId],
    references: [accounts.accountId],
  }),
  sandbox: one(sandboxes, {
    fields: [tunnelConnections.sandboxId],
    references: [sandboxes.sandboxId],
  }),
  permissions: many(tunnelPermissions),
  permissionRequests: many(tunnelPermissionRequests),
  auditLogs: many(tunnelAuditLogs),
}));

export const tunnelPermissionsRelations = relations(tunnelPermissions, ({ one }) => ({
  tunnel: one(tunnelConnections, {
    fields: [tunnelPermissions.tunnelId],
    references: [tunnelConnections.tunnelId],
  }),
}));

export const tunnelPermissionRequestsRelations = relations(tunnelPermissionRequests, ({ one }) => ({
  tunnel: one(tunnelConnections, {
    fields: [tunnelPermissionRequests.tunnelId],
    references: [tunnelConnections.tunnelId],
  }),
}));

export const tunnelAuditLogsRelations = relations(tunnelAuditLogs, ({ one }) => ({
  tunnel: one(tunnelConnections, {
    fields: [tunnelAuditLogs.tunnelId],
    references: [tunnelConnections.tunnelId],
  }),
}));

// ─── Access Control ─────────────────────────────────────────────────────────

// ─── Platform User Roles ────────────────────────────────────────────────────
// Platform-level roles (not account-scoped). Controls admin access to the platform.

export const platformRoleEnum = kortixSchema.enum('platform_role', [
  'user',
  'admin',
  'super_admin',
]);

export const platformUserRoles = kortixSchema.table(
  'platform_user_roles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    role: platformRoleEnum('role').default('user').notNull(),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_platform_user_roles_account_id').on(table.accountId),
    index('idx_platform_user_roles_role').on(table.role),
  ],
);

// ─── Access Control ─────────────────────────────────────────────────────────

export const accessRequestStatusEnum = kortixSchema.enum('access_request_status', [
  'pending',
  'approved',
  'rejected',
]);

export const platformSettings = kortixSchema.table('platform_settings', {
    key: varchar('key', { length: 255 }).primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accessAllowlist = kortixSchema.table(
  'access_allowlist',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryType: varchar('entry_type', { length: 20 }).notNull(), // 'email' | 'domain'
    value: varchar('value', { length: 255 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_access_allowlist_type_value').on(table.entryType, table.value)],
);

export const accessRequests = kortixSchema.table(
  'access_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    company: varchar('company', { length: 255 }),
    useCase: text('use_case'),
    status: accessRequestStatusEnum('status').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_access_requests_email').on(table.email),
    index('idx_access_requests_status').on(table.status),
  ],
);

// ─── Change Requests ────────────────────────────────────────────────────────
// PR-equivalent for Kortix-native git workflows. A change_request proposes
// merging `head_ref` into `base_ref` for a given project. The CR is metadata;
// the underlying git operations (fetch, diff, merge) run through
// apps/api/src/projects/git.ts and work against whichever backend the
// project's repo URL points to (GitHub, GitLab, plain git).

export const changeRequestStatusEnum = kortixSchema.enum('change_request_status', [
  'open',
  'merged',
  'closed',
]);

export const changeRequests = kortixSchema.table(
  'change_requests',
  {
    crId: uuid('cr_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** Short, monotonically-increasing per-project display number (CR #1, #2, …). */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').default('').notNull(),
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    status: changeRequestStatusEnum('status').default('open').notNull(),
    /** Auto-refreshed against the live head_ref tip on every read. */
    headCommitSha: text('head_commit_sha'),
    baseCommitSha: text('base_commit_sha'),
    /** Originating session (if the CR was opened from inside a sandbox). */
    originSessionId: text('origin_session_id').references(() => projectSessions.sessionId, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').notNull(),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedBy: uuid('merged_by'),
    mergeCommitSha: text('merge_commit_sha'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_change_requests_account').on(table.accountId),
    index('idx_change_requests_project').on(table.projectId),
    index('idx_change_requests_project_status').on(table.projectId, table.status),
    uniqueIndex('idx_change_requests_project_number').on(table.projectId, table.number),
  ],
);

export const changeRequestsRelations = relations(changeRequests, ({ one }) => ({
  project: one(projects, {
    fields: [changeRequests.projectId],
    references: [projects.projectId],
  }),
  account: one(accounts, {
    fields: [changeRequests.accountId],
    references: [accounts.accountId],
  }),
  originSession: one(projectSessions, {
    fields: [changeRequests.originSessionId],
    references: [projectSessions.sessionId],
  }),
}));

// ─── Review Center ─────────────────────────────────────────────────────────
// A review_item is "one thing a human needs to look at or decide on": an agent
// output/decision/batch submitted for review, presented in a friendly inbox.
// The polymorphic `detail` jsonb carries the kind-specific payload. (Change
// requests and executor/tunnel approvals are folded in by adapters in a later
// pass — they keep their own source-of-truth tables.) See docs/REVIEW_CENTER_DESIGN.md.

export const reviewItemKindEnum = kortixSchema.enum('review_item_kind', [
  'change',
  'approval',
  'output',
  'decision',
  'batch',
]);

export const reviewItemStatusEnum = kortixSchema.enum('review_item_status', [
  'needs_you',
  'waiting',
  'approved',
  'changes_requested',
  'rejected',
  'done',
  'dismissed',
]);

export const reviewItemRiskEnum = kortixSchema.enum('review_item_risk', [
  'none',
  'low',
  'medium',
  'high',
]);

export const reviewItemSourceEnum = kortixSchema.enum('review_item_source', [
  'web',
  'slack',
  'agent',
]);

export const reviewItems = kortixSchema.table(
  'review_items',
  {
    reviewItemId: uuid('review_item_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** Originating session/agent run, if submitted from inside a sandbox. */
    originSessionId: text('origin_session_id').references(() => projectSessions.sessionId, {
      onDelete: 'set null',
    }),
    kind: reviewItemKindEnum('kind').notNull(),
    status: reviewItemStatusEnum('status').default('needs_you').notNull(),
    risk: reviewItemRiskEnum('risk').default('none').notNull(),
    source: reviewItemSourceEnum('source').default('agent').notNull(),
    /** Plain-language envelope shown in the inbox. */
    title: text('title').notNull(),
    summary: text('summary').default('').notNull(),
    /** Kind-specific payload: artifact preview, decision options, batch children, … */
    detail: jsonb('detail').default({}).$type<Record<string, unknown>>().notNull(),
    /** Attribution label for the originating agent / session. */
    agent: text('agent').default('').notNull(),
    createdBy: uuid('created_by').notNull(),
    /** Set when a human acts (approve / reject / request changes / answer). */
    actedBy: uuid('acted_by'),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    feedback: text('feedback'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_review_items_project').on(table.projectId),
    index('idx_review_items_project_status').on(table.projectId, table.status),
    index('idx_review_items_project_kind').on(table.projectId, table.kind),
    index('idx_review_items_created').on(table.createdAt),
  ],
);

export const reviewItemsRelations = relations(reviewItems, ({ one }) => ({
  project: one(projects, {
    fields: [reviewItems.projectId],
    references: [projects.projectId],
  }),
  account: one(accounts, {
    fields: [reviewItems.accountId],
    references: [accounts.accountId],
  }),
  originSession: one(projectSessions, {
    fields: [reviewItems.originSessionId],
    references: [projectSessions.sessionId],
  }),
}));

// ─── IAM (Cloudflare-style groups + policies) ──────────────────────────────
// Layered on top of account_members. A user's effective permissions are the
// union of: super-admin bypass, the legacy account_role bridge, direct policies
// on the member, and policies on any group the member belongs to.

export const accountGroupSourceEnum = kortixSchema.enum('account_group_source', [
  'manual',
  'scim',
  'sso',
]);

export const accountGroups = kortixSchema.table(
  'account_groups',
  {
    groupId: uuid('group_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    source: accountGroupSourceEnum('source').default('manual').notNull(),
    externalId: text('external_id'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_groups_account').on(table.accountId),
    uniqueIndex('idx_account_groups_account_name').on(table.accountId, table.name),
  ],
);

export const accountGroupMembers = kortixSchema.table(
  'account_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => accountGroups.groupId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    addedBy: uuid('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('idx_account_group_members_user').on(table.userId),
  ],
);

/**
 * IAM V2 bulk-access channel. Attaches an account_group to a project with
 * a project_role. Every user in the group inherits that role on that
 * project. This is what SCIM/SAML-pushed groups land on once an admin
 * picks the project + role binding.
 */
export const projectGroupGrants = kortixSchema.table(
  'project_group_grants',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => accountGroups.groupId, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').default('member').notNull(),
    grantedBy: uuid('granted_by'),
    /** Optional auto-revoke timestamp. NULL = permanent attachment.
     *  Same semantics as project_members.expires_at. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.groupId] }),
    index('idx_project_group_grants_project').on(table.projectId),
    index('idx_project_group_grants_group').on(table.groupId),
    index('idx_project_group_grants_account').on(table.accountId),
  ],
);

export const accountGroupsRelations = relations(accountGroups, ({ one, many }) => ({
  account: one(accounts, {
    fields: [accountGroups.accountId],
    references: [accounts.accountId],
  }),
  members: many(accountGroupMembers),
}));

export const accountGroupMembersRelations = relations(accountGroupMembers, ({ one }) => ({
  group: one(accountGroups, {
    fields: [accountGroupMembers.groupId],
    references: [accountGroups.groupId],
  }),
}));

// ─── IAM v1 — DB-driven custom roles + policies ────────────────────────────
// The built-in roles (owner/admin/member, manager/editor/user) stay as
// frozen Sets in apps/api/src/iam/role-perms.ts and keep their in-memory fast
// path. These tables add ACCOUNT-scoped CUSTOM roles and the policies that bind
// a principal (member/group/token) to a custom role at a scope. The engine
// consults them ADDITIVELY (union, allow-only highest-wins) on top of the
// built-in role — so nothing existing changes until an admin creates a custom
// role and assigns it. A department = an account_group bound here to a scoped
// custom role; deactivating a capability = a role whose action set OMITS it.

export const iamRoles = kortixSchema.table(
  'iam_roles',
  {
    roleId: uuid('role_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    /** Machine key, unique per account (e.g. 'marketing_operator'). */
    key: varchar('key', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    /** Where the role's actions apply: 'account' | 'project'. Plain text +
     *  app-level validation (mirrors resourceTypeForAction's vocabulary). */
    scopeType: varchar('scope_type', { length: 16 }).default('project').notNull(),
    /** Reserved: v1 only creates custom roles; built-ins remain code-defined. */
    isBuiltin: boolean('is_builtin').default(false).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_iam_roles_account').on(table.accountId),
    uniqueIndex('idx_iam_roles_account_key').on(table.accountId, table.key),
  ],
);

export const iamRoleActions = kortixSchema.table(
  'iam_role_actions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => iamRoles.roleId, { onDelete: 'cascade' }),
    /** A permission string from actions.ts VALID_ACTIONS (validated at write). */
    action: varchar('action', { length: 96 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.action] })],
);

export const iamPolicies = kortixSchema.table(
  'iam_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    /** 'member' (user id) | 'group' (account_groups.group_id) | 'token' (SA). */
    principalType: varchar('principal_type', { length: 16 }).notNull(),
    /** Untyped uuid — same choice as project_secret_grants.principal_id. */
    principalId: uuid('principal_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => iamRoles.roleId, { onDelete: 'cascade' }),
    /** 'account' (every project) | 'project' (scope_id = project_id). */
    scopeType: varchar('scope_type', { length: 16 }).notNull(),
    /** project_id when scope_type='project'; NULL = account-wide. No FK (the
     *  column is polymorphic across account-wide vs a specific project). */
    scopeId: uuid('scope_id'),
    /** Optional auto-revoke; same semantics as project_members.expires_at. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_iam_policies_account_principal').on(
      table.accountId,
      table.principalType,
      table.principalId,
    ),
    index('idx_iam_policies_scope').on(table.scopeType, table.scopeId),
    index('idx_iam_policies_role').on(table.roleId),
  ],
);

export const iamRolesRelations = relations(iamRoles, ({ one, many }) => ({
  account: one(accounts, {
    fields: [iamRoles.accountId],
    references: [accounts.accountId],
  }),
  actions: many(iamRoleActions),
}));

export const iamRoleActionsRelations = relations(iamRoleActions, ({ one }) => ({
  role: one(iamRoles, {
    fields: [iamRoleActions.roleId],
    references: [iamRoles.roleId],
  }),
}));

/**
 * IAM V2 per-RESOURCE scoping. Scopes a member or group (Department) to a
 * SPECIFIC agent or skill within a project — "Marketing may use agent
 * `outreach-bot` and skill `lead-research`, nothing else." Sits as an
 * INTERSECTION on top of the project-role / custom-policy verdict:
 *   - A resource (agent name / skill slug) becomes "scoped" once ≥1 grant row
 *     exists for (project, resource_type, resource_id).
 *   - UNSCOPED resources stay project-wide (no behaviour change) — so scoping
 *     agent A restricts only agent A; agents with no grant stay open to anyone
 *     who holds the capability. This makes the feature inherently opt-in and
 *     avoids surprise lockouts.
 *   - SCOPED resources are visible/usable ONLY to principals with a matching
 *     grant (member = the user, or any group the user belongs to). Account
 *     owners/admins keep implicit Manager and bypass scoping entirely.
 * `resource_id` is TEXT because agent names + skill slugs are file-based
 * manifest keys, not uuids. Mirrors the project_group_grants / iam_policies
 * (member|group principal) pattern; principal_id is an untyped uuid for the
 * same polymorphic reason as iam_policies.principal_id.
 */
export const iamResourceGrants = kortixSchema.table(
  'iam_resource_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** 'agent' | 'skill' — validated app-side; extensible to command/etc. */
    resourceType: varchar('resource_type', { length: 32 }).notNull(),
    /** Agent name / skill slug — the file-based manifest key (NOT a uuid). */
    resourceId: text('resource_id').notNull(),
    /** 'member' (user id) | 'group' (account_groups.group_id). */
    principalType: varchar('principal_type', { length: 16 }).notNull(),
    /** Untyped uuid — same choice as iam_policies.principal_id. */
    principalId: uuid('principal_id').notNull(),
    /** v1 is allow-only; 'deny' reserved for a future explicit-deny tier. */
    effect: varchar('effect', { length: 8 }).default('allow').notNull(),
    /** Optional auto-revoke; same semantics as project_members.expires_at. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One grant per (resource, principal) — upsert target.
    uniqueIndex('uq_iam_resource_grants').on(
      table.projectId,
      table.resourceType,
      table.resourceId,
      table.principalType,
      table.principalId,
    ),
    // "Is anything of this type scoped in this project?" + per-resource lookup.
    index('idx_iam_resource_grants_project_type').on(table.projectId, table.resourceType),
    index('idx_iam_resource_grants_resource').on(
      table.projectId,
      table.resourceType,
      table.resourceId,
    ),
    // Cache invalidation by principal (a user or a group).
    index('idx_iam_resource_grants_principal').on(table.principalType, table.principalId),
    index('idx_iam_resource_grants_account').on(table.accountId),
  ],
);

// ─── SCIM 2.0 provisioning tokens ──────────────────────────────────────────
// Long-lived bearer tokens used by external IdPs (Okta, Azure AD, etc.) to
// drive the /scim/v2/accounts/:accountId/* endpoints. Separate from PATs
// because the lifecycle is different: rotated by IT admins, never
// individual users; not subject to per-user MFA; not used for human auth.

export const scimTokens = kortixSchema.table(
  'scim_tokens',
  {
    tokenId: uuid('token_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    // SHA-256 hex of the plaintext token (kortix_scim_*). We never store
    // the plaintext, only the hash. Same approach as account_tokens.
    secretHash: text('secret_hash').notNull(),
    // Optional public prefix so admins can recognise tokens in a list
    // ("kortix_scim_abcd…"). Display-only; not used for lookup.
    publicPrefix: varchar('public_prefix', { length: 32 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_scim_tokens_account').on(table.accountId),
    // Hash is globally unique; the validate path looks up by hash alone.
    uniqueIndex('idx_scim_tokens_secret_hash').on(table.secretHash),
  ],
);

// ─── Audit webhooks (SIEM streaming) ───────────────────────────────────────
// Per-account HTTP webhooks fired on every audit event so customers can
// ship to Splunk / Datadog / generic SIEMs. Payload is signed with
// HMAC-SHA256 using the webhook's secret. Delivery is fire-and-forget;
// last error is surfaced on the row so admins can see failures.

export const auditWebhooks = kortixSchema.table(
  'audit_webhooks',
  {
    webhookId: uuid('webhook_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** HMAC-SHA256 signing secret. Shown once at create, then hashed-equivalent
     * (kept plain because we have to use it to sign every outgoing payload —
     * encryption-at-rest covers the storage threat model). */
    secret: text('secret').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    /** Optional action prefix filter — e.g. "iam." to only deliver IAM
     * events, or empty to deliver everything. */
    actionPrefix: varchar('action_prefix', { length: 128 }),
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_audit_webhooks_account').on(table.accountId),
    index('idx_audit_webhooks_enabled').on(table.accountId, table.enabled),
  ],
);

// ─── SAML SSO (per-account) ─────────────────────────────────────────────────
// Pairs a kortix account with the Supabase auth.sso_providers row that
// represents its SAML connection. The Supabase side handles the SAML
// handshake; we look up the kortix account here when a JWT carrying a
// matching sso_provider_id arrives, then JIT-provision membership and
// sync group memberships from the configured group claim.

export const accountSsoProviders = kortixSchema.table(
  'account_sso_providers',
  {
    ssoProviderId: uuid('sso_provider_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    /** UUID of the matching auth.sso_providers row. Supabase generates it
     *  when the admin uploads SAML metadata via Studio or the auth API. */
    supabaseSsoProviderId: uuid('supabase_sso_provider_id').notNull(),
    /** Human label for the IdP ("Okta", "Azure AD prod", …). Display-only. */
    name: varchar('name', { length: 128 }).notNull(),
    /** Primary email domain — used to route /sign-in?email=foo@acme.com
     *  to the right SAML provider without the user picking a workspace. */
    primaryDomain: varchar('primary_domain', { length: 253 }).notNull(),
    /** JWT claim name (under app_metadata) carrying the user's groups.
     *  Common values: "groups" (Okta), "memberOf" (Azure AD). String or
     *  string[] — we accept both at read time. */
    groupClaimName: varchar('group_claim_name', { length: 128 }).default('groups').notNull(),
    /** When true, users who sign in via this SSO but have no matching
     *  group mapping get a baseline 'member' row anyway. Off by default
     *  so admins can enforce strict group-driven access. */
    autoCreateMembers: boolean('auto_create_members').default(true).notNull(),
    /** When true, a login auto-creates an IAM group (source='sso', named after
     *  the claim value) + a claim->group mapping for every group the IdP sends,
     *  so admins skip manual mapping and just attach project roles. Off by
     *  default — providers keep the explicit-mapping behavior. */
    autoProvisionGroups: boolean('auto_provision_groups').default(false).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One SSO provider per account (v1 limitation; multi-IdP can come
    // later if customers need staging/prod separation).
    uniqueIndex('idx_account_sso_providers_account').on(table.accountId),
    // Reverse lookup: JWT carries the supabase id, we resolve to account.
    uniqueIndex('idx_account_sso_providers_supabase').on(table.supabaseSsoProviderId),
    // Domain lookup for the sign-in router.
    index('idx_account_sso_providers_domain').on(table.primaryDomain),
  ],
);

// ─── Service accounts (non-human IAM principals) ──────────────────────────
// First-class machine identities owned by the account itself, not by a
// user. Distinct from PATs (which inherit a user's identity) — service
// accounts have their own policies via principal_type='token' with
// principal_id=service_account.id. Used for CI/CD, integrations,
// cron-like automation. One bearer token per SA in v1; rotation =
// disable + create a new SA.

export const serviceAccounts = kortixSchema.table(
  'service_accounts',
  {
    serviceAccountId: uuid('service_account_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    /** SHA-256 hex of the plaintext bearer (kortix_sa_*). Plaintext
     *  is shown ONCE at creation, never persisted. Auto-provisioned agent SAs
     *  (agent_name set) are IDENTITY-ONLY: a random secret is generated and the
     *  plaintext discarded, so the bearer is unusable — the agent authenticates
     *  via its session account_token (service_account_id), not this bearer. */
    secretHash: text('secret_hash').notNull(),
    /** Display prefix so admins can recognise SAs in lists. */
    publicPrefix: varchar('public_prefix', { length: 32 }).notNull(),
    /** active | disabled. Disabled SAs are kept for audit trail but
     *  refuse every request. */
    status: varchar('status', { length: 16 }).default('active').notNull(),
    /** Set for an auto-provisioned AGENT identity: the project the agent lives
     *  in. NULL for a manually-created (human-managed) service account. */
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'cascade' }),
    /** The kortix.yaml `agents` entry name this SA is the standing identity for.
     *  NULL for a manual service account. (account_id, project_id, agent_name)
     *  is unique so get-or-create is idempotent per agent. */
    agentName: text('agent_name'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledBy: uuid('disabled_by'),
  },
  (table) => [
    index('idx_service_accounts_account').on(table.accountId),
    uniqueIndex('idx_service_accounts_secret_hash').on(table.secretHash),
    // Display-name uniqueness applies to MANUAL service accounts only — auto
    // agent SAs are uniqued by their (account, project, agent) tuple instead, so
    // two projects can each have an agent with the same friendly name.
    uniqueIndex('idx_service_accounts_account_name')
      .on(table.accountId, table.name)
      .where(sql`agent_name IS NULL`),
    uniqueIndex('idx_service_accounts_agent')
      .on(table.accountId, table.projectId, table.agentName)
      .where(sql`agent_name IS NOT NULL`),
  ],
);

// ─── Session activity (per account × user × session) ──────────────────────
// Tracks idle time + active sessions per account. One row per
// (account, user, session_id) the first time we see that session hit the
// account; updated lazily (>60s since last write) for liveness.
// `revoked_at` set by admins via force-logout.

export const accountSessionActivity = kortixSchema.table(
  'account_session_activity',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    /** First time we saw this (account, user, session) tuple. Used by
     *  the UI to sort the "active sessions" list and by the engine to
     *  enforce max-lifetime when the JWT has no iat (PAT-style). */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    /** Set when an admin force-logs-out this session OR when the user
     *  hits a lifetime/idle gate (so we don't repeatedly query Supabase
     *  for an already-killed session). */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Why this session was revoked — 'admin', 'idle', 'lifetime'. */
    revokedReason: varchar('revoked_reason', { length: 32 }),
    revokedBy: uuid('revoked_by'),
    /** Captured at first sight for diagnostics ("which IP/UA was this?"). */
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.userId, table.sessionId] }),
    index('idx_account_session_activity_account').on(table.accountId),
    index('idx_account_session_activity_user').on(table.accountId, table.userId),
  ],
);

// Claim-value → IAM group mapping. A SAML user with claim "Engineers" in
// their token gets added to whichever IAM group is mapped to that claim.
// Missing on the way IN: claim removed → group dropped on next sign-in.
export const accountSsoGroupMappings = kortixSchema.table(
  'account_sso_group_mappings',
  {
    mappingId: uuid('mapping_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    ssoProviderId: uuid('sso_provider_id')
      .notNull()
      .references(() => accountSsoProviders.ssoProviderId, { onDelete: 'cascade' }),
    /** Match against an entry in the IdP group claim. Compared case- and
     *  whitespace-INSENSITIVELY at sync time (see iam/sso-sync.ts
     *  resolveClaimedGroupIds) so an admin can't silently lock users out by
     *  mistyping the casing of an Entra/Okta group name. */
    claimValue: varchar('claim_value', { length: 256 }).notNull(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => accountGroups.groupId, { onDelete: 'cascade' }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Same claim can only map to one group within an account (avoid
    // surprise double-membership). To map a claim to multiple groups,
    // put those users in one IAM group and attach the policies there.
    uniqueIndex('idx_account_sso_mappings_claim').on(table.accountId, table.claimValue),
    index('idx_account_sso_mappings_provider').on(table.ssoProviderId),
    index('idx_account_sso_mappings_group').on(table.groupId),
  ],
);

/* ─── Executor (connectors) ───────────────────────────────────────────────
 * One unified connector layer the agent reaches via the Executor (CLI/MCP/SDK).
 * Connectors are DEFINED in kortix.yaml (`connectors`) and materialized here
 * on push (manifest = config source of truth, like triggers). Credentials are
 * project_secrets (scope handled by sharing above); the Pipedream connection
 * binding is also a project secret. See docs/specs/executor.md.
 */
export const executorConnectorProviderEnum = kortixSchema.enum('executor_connector_provider', [
  'pipedream',
  'mcp',
  'openapi',
  'graphql',
  'http',
  // Chat platforms (Slack, later Telegram/Teams) as first-class connectors. The
  // catalog is a fixed per-platform action set; the credential is the platform's
  // existing install token (resolved server-side, no executor_credential row).
  'channel',
  // Connected machines reached over the Agent Computer Tunnel. ONE auto-
  // materialized connector fronts all the account's machines (machine = a call
  // arg); its catalog is the tunnel RPC method set, and it has no credential —
  // the live WS relay IS the credential, with per-machine auth/scope enforced by
  // the tunnel permission layer. See docs/specs/computer-connector.md.
  'computer',
]);

export const executorConnectorStatusEnum = kortixSchema.enum('executor_connector_status', [
  'active',
  'disabled',
  'needs_auth',
  'error',
]);

export const executorPolicyActionEnum = kortixSchema.enum('executor_policy_action', [
  'always_run',
  'require_approval',
  'block',
]);

export const executorRiskEnum = kortixSchema.enum('executor_risk', [
  'read',
  'write',
  'destructive',
]);

export const executorExecutionStatusEnum = kortixSchema.enum('executor_execution_status', [
  'ok',
  'error',
  'denied',
  'pending_approval',
]);

/**
 * How a connector's credential is stored/used. `shared` (one project-level
 * credential everyone with access uses) is the ONLY writable value.
 *
 * `per_user` (each member connects their own) was REMOVED 2026-07-05
 * (docs/specs/2026-07-05-agent-first-config-unification.md §2.5): it conflated
 * delegated-identity ("act as whichever human launched this session") with
 * connector credential storage, and had no coherent answer for triggers/
 * channels (no launching human). Migration
 * `20260705191549103_remove_per_user_credential_mode.sql` flipped every
 * `per_user` row to `shared`, deleted the per-member `executor_credentials`
 * rows (no silent credential promotion — a per-member OAuth is a personal
 * identity, so those connectors now need reconnecting), and added a CHECK
 * constraint enforcing `shared` at the DB level. `per_user` stays listed below
 * ONLY because Postgres cannot cleanly drop a value from an existing enum
 * type without rebuilding it — the value is orphaned, not reachable: nothing
 * in the app writes it, and the CHECK constraint rejects it outright. Do not
 * reintroduce writes of `per_user`. A future "connect your own account"
 * feature (interactive-sessions-only, tracked separately) will need a new,
 * differently-named mechanism — not a revival of this one.
 */
export const executorCredentialModeEnum = kortixSchema.enum('executor_credential_mode', [
  'shared',
  'per_user',
]);

export const executorConnectors = kortixSchema.table(
  'executor_connectors',
  {
    connectorId: uuid('connector_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    providerType: executorConnectorProviderEnum('provider_type').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    /** Provider-specific config: app/account | url/transport | endpoint | base_url | spec | auth. */
    config: jsonb('config').default({}).$type<Record<string, unknown>>().notNull(),
    /** Legacy reference to a project_secrets row (kept; credentials now in executor_credentials). */
    authSecret: varchar('auth_secret', { length: 64 }),
    /** ORPHANED 2026-07-06 (docs/specs/2026-07-05-agent-first-config-unification.md):
     *  connectors are unconditionally project-wide now — authorization lives
     *  solely on the agent's `connectors` grant. `project` is the only value a
     *  DB CHECK constraint (added by the retirement migration) still accepts;
     *  nothing in the app reads or writes this column anymore. */
    shareScope: secretShareScopeEnum('share_scope').default('project').notNull(),
    /** ORPHANED 2026-07-06 (docs/specs/2026-07-05-agent-first-config-unification.md):
     *  the connector-side agent gate was retired — the agent-side `connectors`
     *  grant (`[[agents]].connectors`, iam/agent-scope.ts) is now the ONLY gate
     *  on which agents may call a connector. Values were nulled by the
     *  retirement migration; nothing in the app reads or writes this column
     *  anymore (kept, like `per_user` on executorCredentialModeEnum, because
     *  Postgres can't cleanly drop a column's meaning without a bigger change). */
    agentScope: text('agent_scope').array(),
    /** Credential storage model. `shared` only — see executorCredentialModeEnum
     *  doc comment for why `per_user` is gone but the enum literal lingers. A
     *  DB CHECK constraint (added by the removal migration) enforces `shared`. */
    credentialMode: executorCredentialModeEnum('credential_mode').default('shared').notNull(),
    /** Hash over config+auth — skip catalog re-sync when unchanged. */
    manifestHash: varchar('manifest_hash', { length: 64 }),
    status: executorConnectorStatusEnum('status').default('active').notNull(),
    lastError: text('last_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_executor_connectors_project').on(table.projectId),
    index('idx_executor_connectors_account').on(table.accountId),
    uniqueIndex('idx_executor_connectors_project_slug').on(table.projectId, table.slug),
    uniqueIndex('idx_executor_connectors_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.connectorId,
    ),
    uniqueIndex('idx_executor_connectors_tenant_alias').on(
      table.accountId,
      table.projectId,
      table.connectorId,
      table.slug,
    ),
  ],
);

export const executorConnectionProfileOwnerTypeEnum = kortixSchema.enum(
  'executor_connection_profile_owner_type',
  ['project', 'agent', 'member', 'subject', 'external'],
);

export const executorConnectionProfileStatusEnum = kortixSchema.enum(
  'executor_connection_profile_status',
  ['active', 'revoked', 'error'],
);

/** A concrete server-side identity behind one logical connector definition. */
export const executorConnectionProfiles = kortixSchema.table(
  'executor_connection_profiles',
  {
    profileId: uuid('profile_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    ownerType: executorConnectionProfileOwnerTypeEnum('owner_type').default('project').notNull(),
    ownerId: text('owner_id'),
    label: varchar('label', { length: 255 }).notNull(),
    status: executorConnectionProfileStatusEnum('status').default('active').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId],
      foreignColumns: [
        executorConnectors.accountId,
        executorConnectors.projectId,
        executorConnectors.connectorId,
      ],
      name: 'executor_connection_profiles_connector_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_executor_connection_profiles_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.connectorId,
      table.profileId,
    ),
    uniqueIndex('idx_executor_connection_profiles_connector_identity').on(
      table.connectorId,
      table.profileId,
    ),
    uniqueIndex('idx_executor_connection_profiles_default')
      .on(table.connectorId)
      .where(sql`${table.isDefault} = true`),
    uniqueIndex('idx_executor_connection_profiles_owner')
      .on(table.connectorId, table.ownerType, table.ownerId)
      .where(sql`${table.ownerId} is not null`),
    index('idx_executor_connection_profiles_project').on(table.projectId),
    index('idx_executor_connection_profiles_connector').on(table.connectorId),
    check(
      'executor_connection_profiles_owner_check',
      sql`(${table.ownerType} = 'project' AND ${table.ownerId} IS NULL) OR (${table.ownerType} <> 'project' AND ${table.ownerId} IS NOT NULL AND btrim(${table.ownerId}) <> '')`,
    ),
    check(
      'executor_connection_profiles_metadata_check',
      sql`jsonb_typeof(${table.metadata}) = 'object' AND octet_length(${table.metadata}::text) <= 16384`,
    ),
  ],
);

export const projectSessionConnectorBindingSourceEnum = kortixSchema.enum(
  'project_session_connector_binding_source',
  ['request', 'default'],
);

/** Durable alias -> concrete profile selection for one project session. */
export const projectSessionConnectorBindings = kortixSchema.table(
  'project_session_connector_bindings',
  {
    sessionId: text('session_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    connectorId: uuid('connector_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    source: projectSessionConnectorBindingSourceEnum('source').default('request').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.connectorAlias] }),
    foreignKey({
      columns: [table.accountId, table.projectId, table.sessionId],
      foreignColumns: [
        projectSessions.accountId,
        projectSessions.projectId,
        projectSessions.sessionId,
      ],
      name: 'project_session_connector_bindings_session_tenant_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId, table.connectorAlias],
      foreignColumns: [
        executorConnectors.accountId,
        executorConnectors.projectId,
        executorConnectors.connectorId,
        executorConnectors.slug,
      ],
      name: 'project_session_connector_bindings_alias_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId, table.profileId],
      foreignColumns: [
        executorConnectionProfiles.accountId,
        executorConnectionProfiles.projectId,
        executorConnectionProfiles.connectorId,
        executorConnectionProfiles.profileId,
      ],
      name: 'project_session_connector_bindings_profile_tenant_fk',
    }).onDelete('restrict'),
    index('idx_project_session_connector_bindings_profile').on(table.profileId),
    index('idx_project_session_connector_bindings_project').on(table.projectId),
  ],
);

/** ORPHANED 2026-07-06 — the per-connector member/department "who can access"
 *  allow-list was retired (connectors are project-wide now); the retirement
 *  migration deleted every row and nothing in the app writes to this table
 *  anymore. Kept (empty) rather than dropped — see the shareScope/agentScope
 *  comments on executorConnectors. */
export const executorConnectorGrants = kortixSchema.table(
  'executor_connector_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    principalType: secretGrantPrincipalEnum('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_executor_connector_grants_connector').on(table.connectorId),
    uniqueIndex('idx_executor_connector_grants_unique').on(
      table.connectorId,
      table.principalType,
      table.principalId,
    ),
  ],
);

/**
 * Connector credentials — split from the connector. One row per (connector, user):
 * `user_id = NULL` is the shared project credential. A row with a set `user_id`
 * (that member's own — the `per_user` mode) is no longer written by the app
 * (removed 2026-07-05; migration `20260705191549103_remove_per_user_credential_mode.sql`
 * deleted every existing one) — the column stays for shape/back-compat and a
 * possible future "connect your own account" feature, but every write path
 * today passes `userId: null`. Value/binding encrypted; resolved server-side only.
 */
export const executorCredentials = kortixSchema.table(
  'executor_credentials',
  {
    credentialId: uuid('credential_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    /** Phase-2 profile identity. Nullable only during legacy dual-read rollout. */
    profileId: uuid('profile_id'),
    /** NULL = shared project credential (the only mode written today). */
    userId: uuid('user_id'),
    /** `secret` (api key / token) or `connection` (Pipedream account binding id). */
    kind: varchar('kind', { length: 32 }).default('secret').notNull(),
    valueEnc: text('value_enc').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_executor_credentials_connector').on(table.connectorId),
    index('idx_executor_credentials_profile').on(table.profileId),
    uniqueIndex('idx_executor_credentials_profile_unique')
      .on(table.profileId)
      .where(sql`${table.profileId} is not null`),
    foreignKey({
      columns: [table.connectorId, table.profileId],
      foreignColumns: [
        executorConnectionProfiles.connectorId,
        executorConnectionProfiles.profileId,
      ],
      name: 'executor_credentials_connector_profile_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_executor_credentials_legacy_connector_unique')
      .on(table.connectorId)
      .where(sql`${table.profileId} is null`),
  ],
);

export const executorConnectorActions = kortixSchema.table(
  'executor_connector_actions',
  {
    actionId: uuid('action_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    /** Connector-namespaced tool path, e.g. "stripe.charges.create". */
    path: varchar('path', { length: 512 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown> | null>(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    risk: executorRiskEnum('risk').default('read').notNull(),
    /** Provider invocation metadata (method+path, operationId, field, mcp tool name…). */
    binding: jsonb('binding').default({}).$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_executor_connector_actions_connector').on(table.connectorId),
    uniqueIndex('idx_executor_connector_actions_path').on(table.connectorId, table.path),
  ],
);

/** Connector-scoped tool-call policies, materialized from [[connectors.policies]]. */
export const executorConnectorPolicies = kortixSchema.table(
  'executor_connector_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    /** Glob over the connector's tool paths. */
    match: varchar('match', { length: 512 }).notNull(),
    action: executorPolicyActionEnum('action').notNull(),
    /** Authoring order — evaluated top-to-bottom, first match wins. */
    position: integer('position').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_executor_connector_policies_connector').on(table.connectorId)],
);

/**
 * Project-scoped tool-call policies — materialized from top-level [[policies]]
 * in kortix.yaml. Patterns are fully-qualified (`<slug>.<path>` globs) and apply
 * across ALL connectors in the project; evaluated BEFORE any connector-scoped
 * rule. See docs/specs/executor.md §8.
 */
export const executorProjectPolicies = kortixSchema.table(
  'executor_project_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** Glob over fully-qualified tool paths (e.g. `stripe.charges.create`). */
    match: varchar('match', { length: 512 }).notNull(),
    action: executorPolicyActionEnum('action').notNull(),
    /** Authoring order — evaluated top-to-bottom, first match wins. */
    position: integer('position').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_executor_project_policies_project').on(table.projectId)],
);

export const executorDefaultModeEnum = kortixSchema.enum('executor_default_mode', [
  'risk',
  'allow_all',
]);

/**
 * One row per project — non-policy executor settings (just `default_mode`
 * today). Materialized from `policy` in kortix.yaml; missing block = allow_all
 * for back-compat with existing projects.
 */
export const executorProjectSettings = kortixSchema.table('executor_project_settings', {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    defaultMode: executorDefaultModeEnum('default_mode').default('allow_all').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Audit + approval ledger for every executor call. */
export const executorExecutions = kortixSchema.table(
  'executor_executions',
  {
    executionId: uuid('execution_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id').references(() => executorConnectors.connectorId, {
      onDelete: 'set null',
    }),
    profileId: uuid('profile_id').references(() => executorConnectionProfiles.profileId, {
      onDelete: 'set null',
    }),
    actionPath: varchar('action_path', { length: 512 }).notNull(),
    /** Who: the acting user (the executor token's principal). */
    actingUserId: uuid('acting_user_id'),
    sessionId: uuid('session_id'),
    status: executorExecutionStatusEnum('status').notNull(),
    risk: executorRiskEnum('risk'),
    /** Hash of the inputs (never raw secrets). */
    requestDigest: varchar('request_digest', { length: 64 }),
    /** Redacted result summary / error. */
    resultSummary: jsonb('result_summary').$type<Record<string, unknown> | null>(),
    approvedBy: uuid('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_executor_executions_project').on(table.projectId),
    index('idx_executor_executions_project_session_created').on(
      table.projectId,
      table.sessionId,
      table.createdAt.desc(),
    ),
    index('idx_executor_executions_connector').on(table.connectorId),
    index('idx_executor_executions_profile').on(table.profileId),
    index('idx_executor_executions_status').on(table.status),
  ],
);

/**
 * "Allow for this session" decisions on `require_approval` connector calls. When
 * a human approves a gated action and picks "allow for the rest of this
 * session", (session, connector, action) is recorded here; the executor gateway
 * consults it BEFORE holding a require_approval call, so the same tool never
 * re-prompts within the session. Only widens `require_approval` → run — a policy
 * `block` is never recorded (the resolve endpoint refuses it). Ephemeral: FKs
 * cascade on project/connector delete.
 */
export const sessionToolApprovals = kortixSchema.table(
  'session_tool_approvals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    actionPath: varchar('action_path', { length: 512 }).notNull(),
    grantedBy: uuid('granted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('session_tool_approvals_unique').on(
      table.sessionId,
      table.connectorId,
      table.actionPath,
    ),
    index('session_tool_approvals_session_idx').on(table.sessionId),
  ],
);

export const executorConnectorsRelations = relations(executorConnectors, ({ one, many }) => ({
  project: one(projects, {
    fields: [executorConnectors.projectId],
    references: [projects.projectId],
  }),
  actions: many(executorConnectorActions),
  policies: many(executorConnectorPolicies),
}));

export const executorConnectorActionsRelations = relations(executorConnectorActions, ({ one }) => ({
  connector: one(executorConnectors, {
    fields: [executorConnectorActions.connectorId],
    references: [executorConnectors.connectorId],
  }),
}));

export const executorConnectorPoliciesRelations = relations(
  executorConnectorPolicies,
  ({ one }) => ({
  connector: one(executorConnectors, {
    fields: [executorConnectorPolicies.connectorId],
    references: [executorConnectors.connectorId],
  }),
  }),
);

export const executorProjectPoliciesRelations = relations(executorProjectPolicies, ({ one }) => ({
  project: one(projects, {
    fields: [executorProjectPolicies.projectId],
    references: [projects.projectId],
  }),
}));

export const executorProjectSettingsRelations = relations(executorProjectSettings, ({ one }) => ({
  project: one(projects, {
    fields: [executorProjectSettings.projectId],
    references: [projects.projectId],
  }),
}));
