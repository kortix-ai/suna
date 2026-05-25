import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  numeric,
  bigint,
  index,
  uniqueIndex,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const kortixSchema = pgSchema('kortix');

export const sandboxStatusEnum = kortixSchema.enum('sandbox_status', [
  'provisioning',
  'active',
  'stopped',
  'archived',
  'pooled',
  'error',
]);

export const sandboxProviderEnum = kortixSchema.enum('sandbox_provider', [
  'daytona',
  'local_docker',
  'justavps',
]);

export const deploymentStatusEnum = kortixSchema.enum('deployment_status', [
  'pending',
  'building',
  'deploying',
  'active',
  'failed',
  'stopped',
]);

export const deploymentSourceEnum = kortixSchema.enum('deployment_source', [
  'git',
  'code',
  'files',
  'tar',
]);

export const projectStatusEnum = kortixSchema.enum('project_status', [
  'active',
  'archived',
]);

export const projectSessionStatusEnum = kortixSchema.enum('project_session_status', [
  'queued',
  'branching',
  'provisioning',
  'running',
  'stopped',
  'failed',
  'completed',
]);

export const projectSnapshotStatusEnum = kortixSchema.enum('project_snapshot_status', [
  'queued',
  'building',
  'ready',
  'failed',
]);

export const projectRoleEnum = kortixSchema.enum('project_role', [
  'manager',
  'editor',
  'viewer',
]);

export const apiKeyStatusEnum = kortixSchema.enum('api_key_status', [
  'active',
  'revoked',
  'expired',
]);

export const apiKeyTypeEnum = kortixSchema.enum('api_key_type', [
  'user',
  'sandbox',
]);

// ─── Accounts & Members ─────────────────────────────────────────────────────
// Replaces basejump.account_user. Fully kortix-native.

export const accountRoleEnum = kortixSchema.enum('account_role', [
  'owner',
  'admin',
  'member',
]);

export const accounts = kortixSchema.table(
  'accounts',
  {
    accountId: uuid('account_id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    personalAccount: boolean('personal_account').default(true).notNull(),
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
  },
);

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
     *    [{ project_id: uuid, role: 'manager'|'editor'|'viewer',
     *       expires_at?: iso }]
     *  Multiple grants are allowed — the same email could be invited
     *  to several projects at once via repeated calls (they upsert). */
    bootstrapGrants: jsonb('bootstrap_grants').$type<Array<{
      project_id: string;
      role: 'manager' | 'editor' | 'viewer';
      expires_at?: string | null;
    }>>(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
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
    uniqueIndex('idx_account_github_installations_account_installation').on(table.accountId, table.installationId),
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
    manifestPath: text('manifest_path').default('kortix.toml').notNull(),
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
    uniqueIndex('idx_projects_account_repo').on(table.accountId, table.repoUrl),
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
    projectRole: projectRoleEnum('project_role').default('viewer').notNull(),
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

/**
 * Sharing scope of a project secret. `project` = every project member (default).
 * `restricted` = only the principals (members/groups) in `project_secret_grants`.
 * "Just me" is the degenerate restricted case (one member grant: the creator).
 */
export const secretShareScopeEnum = kortixSchema.enum('secret_share_scope', [
  'project',
  'restricted',
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

export const projectSecrets = kortixSchema.table(
  'project_secrets',
  {
    secretId: uuid('secret_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    scope: projectSecretScopeEnum('scope').default('runtime').notNull(),
    shareScope: secretShareScopeEnum('share_scope').default('project').notNull(),
    // NULL = the shared project-level row (governed by share_scope + grants).
    // Non-null = that member's PRIVATE per-key override, which shadows the
    // shared row of the same name in their own sessions. Mirrors
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
    // At most one SHARED row per (project, name)…
    uniqueIndex('idx_project_secrets_project_name_shared')
      .on(table.projectId, table.name)
      .where(sql`${table.ownerUserId} is null`),
    // …and at most one PERSONAL override per (project, name, member).
    uniqueIndex('idx_project_secrets_project_name_owner')
      .on(table.projectId, table.name, table.ownerUserId)
      .where(sql`${table.ownerUserId} is not null`),
  ],
);

/**
 * Allow-list for a `restricted` project secret — which members/groups can use
 * it. Empty (with scope=project) = whole project. Dashboard-managed; never in
 * git. Drives connector usability: a connector is usable by a user iff its bound
 * `auth.secret` (or Pipedream connection) is shared with that user.
 */
export const secretGrantPrincipalEnum = kortixSchema.enum('secret_grant_principal', [
  'member',
  'group',
]);

export const projectSecretGrants = kortixSchema.table(
  'project_secret_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    secretId: uuid('secret_id')
      .notNull()
      .references(() => projectSecrets.secretId, { onDelete: 'cascade' }),
    principalType: secretGrantPrincipalEnum('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_secret_grants_secret').on(table.secretId),
    uniqueIndex('idx_project_secret_grants_unique').on(
      table.secretId,
      table.principalType,
      table.principalId,
    ),
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.slug] }),
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
    channelId: varchar('channel_id', { length: 128 }).notNull(),
    channelName: varchar('channel_name', { length: 256 }),
    channelType: varchar('channel_type', { length: 32 }),
    pickerTs: varchar('picker_ts', { length: 64 }),
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
    threadId: varchar('thread_id', { length: 256 }).notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_chat_threads_thread').on(
      table.platform,
      table.workspaceId,
      table.threadId,
    ),
    index('idx_chat_threads_project').on(table.projectId),
    index('idx_chat_threads_session').on(table.sessionId),
  ],
);

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

export const projectRuntimeSnapshots = kortixSchema.table(
  'project_runtime_snapshots',
  {
    snapshotRowId: uuid('snapshot_row_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    provider: sandboxProviderEnum('provider').default('daytona').notNull(),
    commitSha: text('commit_sha').notNull(),
    branch: text('branch').default('').notNull(),
    snapshotId: text('snapshot_id'),
    status: projectSnapshotStatusEnum('status').default('queued').notNull(),
    error: text('error'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_runtime_snapshots_project').on(table.projectId),
    index('idx_project_runtime_snapshots_status').on(table.status),
    index('idx_project_runtime_snapshots_branch_ready').on(table.projectId, table.branch, table.status, table.createdAt),
    uniqueIndex('idx_project_runtime_snapshots_commit_provider').on(table.projectId, table.commitSha, table.provider),
  ],
);

export const sandboxes = kortixSchema.table(
  'sandboxes',
  {
    sandboxId: uuid('sandbox_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    provider: sandboxProviderEnum('provider').default('daytona').notNull(),
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

export const scopeEffectEnum = kortixSchema.enum('scope_effect', [
  'grant',
  'revoke',
]);

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
    uniqueIndex('idx_sandbox_member_scopes_unique').on(
      table.sandboxId,
      table.userId,
      table.scope,
    ),
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
    error: text('error'),
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
  ],
);

// ─── Pool Resources ─────────────────────────────────────────────────────────

export const poolResources = kortixSchema.table(
  'pool_resources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    provider: sandboxProviderEnum('provider').notNull(),
    serverType: varchar('server_type', { length: 64 }).notNull(),
    location: varchar('location', { length: 64 }).notNull(),
    desiredCount: integer('desired_count').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_pool_resources_unique').on(table.provider, table.serverType, table.location),
  ],
);

export const poolSandboxes = kortixSchema.table(
  'pool_sandboxes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    resourceId: uuid('resource_id').references(() => poolResources.id, { onDelete: 'set null' }),
    provider: sandboxProviderEnum('provider').notNull(),
    externalId: text('external_id').notNull(),
    baseUrl: text('base_url').notNull().default(''),
    serverType: varchar('server_type', { length: 64 }).notNull(),
    location: varchar('location', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('provisioning'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_pool_sandboxes_claim').on(table.status, table.createdAt),
    uniqueIndex('idx_pool_sandboxes_external_id_active').on(table.externalId),
  ],
);

export const deployments = kortixSchema.table(
  'deployments',
  {
    deploymentId: uuid('deployment_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    sandboxId: uuid('sandbox_id').references(() => sandboxes.sandboxId, { onDelete: 'set null' }),
    // Optional link back to a Git-backed project + the [[apps]] slug inside
    // its kortix.toml. Populated by the /v1/projects/:id/apps path; nullable
    // because the legacy /v1/deployments path doesn't carry these.
    projectId: uuid('project_id'),
    appSlug: varchar('app_slug', { length: 128 }),
    // Provider that produced this deployment ("freestyle" today; future:
    // "vercel", "cloudflare", ...). Nullable for back-compat with rows
    // written before the provider adapter shipped.
    provider: varchar('provider', { length: 32 }),
    freestyleId: text('freestyle_id'),
    status: deploymentStatusEnum('status').default('pending').notNull(),

    // Source
    sourceType: deploymentSourceEnum('source_type').notNull(),
    sourceRef: text('source_ref'),
    framework: varchar('framework', { length: 50 }),

    // Config
    domains: jsonb('domains').default([]).$type<string[]>(),
    liveUrl: text('live_url'),
    envVars: jsonb('env_vars').default({}).$type<Record<string, string>>(),
    buildConfig: jsonb('build_config').$type<Record<string, unknown>>(),
    entrypoint: text('entrypoint'),

    // Metadata
    error: text('error'),
    version: integer('version').default(1).notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_deployments_account').on(table.accountId),
    index('idx_deployments_sandbox').on(table.sandboxId),
    index('idx_deployments_status').on(table.status),
    index('idx_deployments_live_url').on(table.liveUrl),
    index('idx_deployments_created').on(table.createdAt),
    // Drives the project-apps list view + the auto-deploy sweep lookup
    // ("latest deployment for this (project, slug)").
    index('idx_deployments_project_app').on(table.projectId, table.appSlug, table.createdAt),
  ],
);


// ─── API Keys (sandbox-scoped) ──────────────────────────────────────────────

export const kortixApiKeys = kortixSchema.table(
  'api_keys',
  {
    keyId: uuid('key_id').defaultRandom().primaryKey(),
    // No FK constraint: sandbox_id can point at either `sandboxes` (legacy
    // /instances) or `session_sandboxes` (project-session sandboxes). Both
    // tables share the UUID space so the lookup keeps working.
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
     *  rejected by account-level handlers. Used for sandbox-injected
     *  CLI tokens. */
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
  },
  (table) => [
    uniqueIndex('idx_account_tokens_public_key').on(table.publicKey),
    index('idx_account_tokens_secret_hash').on(table.secretKeyHash),
    index('idx_account_tokens_account').on(table.accountId),
    index('idx_account_tokens_user').on(table.userId),
    index('idx_account_tokens_project').on(table.projectId),
  ],
);

// ─── Server Entries ──────────────────────────────────────────────────────────
// User-configured server/instance entries (persisted from the frontend).
// Auth tokens are NOT stored — they remain in the browser's localStorage.

export const serverEntries = kortixSchema.table(
  'server_entries',
  {
    /** Auto-generated row PK. */
    entryId: uuid('entry_id').defaultRandom().primaryKey(),
    /** Frontend-assigned entry ID (e.g. 'default', 'cloud-sandbox', 'srv_xxx'). Unique per account. */
    id: varchar('id', { length: 128 }).notNull(),
    /** Owner account — scopes entries per-user. Null in local mode (single user). */
    accountId: uuid('account_id'),
    label: varchar('label', { length: 255 }).notNull(),
    url: text('url').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    provider: sandboxProviderEnum('provider'),
    sandboxId: text('sandbox_id'),
    mappedPorts: jsonb('mapped_ports').$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_server_entries_default').on(table.isDefault),
    index('idx_server_entries_account').on(table.accountId),
    uniqueIndex('idx_server_entries_account_id').on(table.accountId, table.id),
  ],
);

// ─── OAuth2 Provider ──────────────────────────────────────────────────────

export const oauthClients = kortixSchema.table(
  'oauth_clients',
  {
    clientId: uuid('client_id').defaultRandom().primaryKey(),
    clientSecretHash: varchar('client_secret_hash', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    redirectUris: jsonb('redirect_uris').default([]).$type<string[]>(),
    scopes: jsonb('scopes').default([]).$type<string[]>(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

export const oauthAuthorizationCodes = kortixSchema.table(
  'oauth_authorization_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 128 }).notNull(),
    clientId: uuid('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
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
    clientId: uuid('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
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
    accessTokenId: uuid('access_token_id').notNull().references(() => oauthAccessTokens.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
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
  deployments: many(deployments),
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
  runtimeSnapshots: many(projectRuntimeSnapshots),
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
}));

export const projectRuntimeSnapshotsRelations = relations(projectRuntimeSnapshots, ({ one }) => ({
  account: one(accounts, {
    fields: [projectRuntimeSnapshots.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectRuntimeSnapshots.projectId],
    references: [projects.projectId],
  }),
}));

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

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  sandbox: one(sandboxes, {
    fields: [deployments.sandboxId],
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
  projectRuntimeSnapshots: many(projectRuntimeSnapshots),
  sandboxes: many(sandboxes),
  groups: many(accountGroups),
}));

export const accountMembersRelations = relations(accountMembers, ({ one }) => ({
  account: one(accounts, {
    fields: [accountMembers.accountId],
    references: [accounts.accountId],
  }),
}));

export const accountGithubInstallationsRelations = relations(accountGithubInstallations, ({ one }) => ({
  account: one(accounts, {
    fields: [accountGithubInstallations.accountId],
    references: [accounts.accountId],
  }),
}));

export const auditEvents = kortixSchema.table(
  'audit_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .references(() => accounts.accountId, { onDelete: 'set null' }),
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
    projectId: uuid('project_id')
      .references(() => projects.projectId, { onDelete: 'set null' }),
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
  (table) => [
    index('idx_kortix_billing_customers_account_id').on(table.accountId),
  ],
);

export const creditAccounts = kortixSchema.table(
  'credit_accounts',
  {
    accountId: uuid('account_id').primaryKey().notNull(),
    balance: numeric('balance', { precision: 12, scale: 4 }).default('0').notNull(),
    lifetimeGranted: numeric('lifetime_granted', { precision: 12, scale: 4 }).default('0').notNull(),
    lifetimePurchased: numeric('lifetime_purchased', { precision: 12, scale: 4 }).default('0').notNull(),
    lifetimeUsed: numeric('lifetime_used', { precision: 12, scale: 4 }).default('0').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    lastGrantDate: timestamp('last_grant_date', { withTimezone: true, mode: 'string' }),
    tier: varchar('tier', { length: 50 }).default('free'),
    billingCycleAnchor: timestamp('billing_cycle_anchor', { withTimezone: true, mode: 'string' }),
    nextCreditGrant: timestamp('next_credit_grant', { withTimezone: true, mode: 'string' }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    expiringCredits: numeric('expiring_credits', { precision: 12, scale: 4 }).default('0').notNull(),
    nonExpiringCredits: numeric('non_expiring_credits', { precision: 12, scale: 4 }).default('0').notNull(),
    dailyCreditsBalance: numeric('daily_credits_balance', { precision: 10, scale: 2 }).default('0').notNull(),
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
    scheduledTierChangeDate: timestamp('scheduled_tier_change_date', { withTimezone: true, mode: 'string' }),
    scheduledPriceId: text('scheduled_price_id'),
    provider: varchar('provider', { length: 20 }).default('stripe'),
    revenuecatCustomerId: varchar('revenuecat_customer_id', { length: 255 }),
    revenuecatSubscriptionId: varchar('revenuecat_subscription_id', { length: 255 }),
    revenuecatCancelledAt: timestamp('revenuecat_cancelled_at', { withTimezone: true, mode: 'string' }),
    revenuecatCancelAtPeriodEnd: timestamp('revenuecat_cancel_at_period_end', { withTimezone: true, mode: 'string' }),
    revenuecatPendingChangeProduct: text('revenuecat_pending_change_product'),
    revenuecatPendingChangeDate: timestamp('revenuecat_pending_change_date', { withTimezone: true, mode: 'string' }),
    revenuecatPendingChangeType: text('revenuecat_pending_change_type'),
    revenuecatProductId: text('revenuecat_product_id'),
    planType: varchar('plan_type', { length: 50 }).default('monthly'),
    stripeSubscriptionStatus: varchar('stripe_subscription_status', { length: 50 }),
    lastDailyRefresh: timestamp('last_daily_refresh', { withTimezone: true, mode: 'string' }),
    autoTopupEnabled: boolean('auto_topup_enabled').default(false).notNull(),
    autoTopupThreshold: numeric('auto_topup_threshold', { precision: 10, scale: 2 }).default('5').notNull(),
    autoTopupAmount: numeric('auto_topup_amount', { precision: 10, scale: 2 }).default('20').notNull(),
    autoTopupLastCharged: timestamp('auto_topup_last_charged', { withTimezone: true, mode: 'string' }),
    // Billing v2 — per-seat model. Existing rows default to 'legacy' so legacy
    // customers are untouched; new signups use 'per_seat'.
    billingModel: text('billing_model').default('legacy').notNull(),
    seatCount: integer('seat_count').default(1).notNull(),
    seatSubscriptionItemId: text('seat_subscription_item_id'),
    includedComputePerSeatUsd: numeric('included_compute_per_seat_usd', { precision: 10, scale: 4 }),
    includedYoloPerSeatUsd: numeric('included_yolo_per_seat_usd', { precision: 10, scale: 4 }),
    includedComputeBalance: numeric('included_compute_balance', { precision: 12, scale: 4 }).default('0').notNull(),
    includedYoloBalance: numeric('included_yolo_balance', { precision: 12, scale: 4 }).default('0').notNull(),
    autoTopupCustomized: boolean('auto_topup_customized').default(false).notNull(),
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
    cpuCores: integer('cpu_cores').notNull(),
    memoryGb: integer('memory_gb').notNull(),
    diskGb: integer('disk_gb').notNull(),
    gpuCount: integer('gpu_count').default(0).notNull(),
    state: text().default('active').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    lastBilledAt: timestamp('last_billed_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    ledgerId: uuid('ledger_id'),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_sandbox_compute_sessions_account_time').on(table.accountId, table.startedAt),
    index('idx_sandbox_compute_sessions_open')
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
export const yoloMemberTokens = kortixSchema.table(
  'yolo_member_tokens',
  {
    userId: uuid('user_id').notNull(),
    accountId: uuid('account_id').notNull(),
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
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

export const tunnelPermissionRequestStatusEnum = kortixSchema.enum('tunnel_permission_request_status', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

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
    setupTokenHash: varchar('setup_token_hash', { length: 128 }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tunnel_connections_account').on(table.accountId),
    index('idx_tunnel_connections_sandbox').on(table.sandboxId),
    index('idx_tunnel_connections_status').on(table.status),
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
    tunnelId: uuid('tunnel_id').references(() => tunnelConnections.tunnelId, { onDelete: 'set null' }),
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

export const platformSettings = kortixSchema.table(
  'platform_settings',
  {
    key: varchar('key', { length: 255 }).primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

export const accessAllowlist = kortixSchema.table(
  'access_allowlist',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryType: varchar('entry_type', { length: 20 }).notNull(), // 'email' | 'domain'
    value: varchar('value', { length: 255 }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_access_allowlist_type_value').on(table.entryType, table.value),
  ],
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
// project's repo URL points to (GitHub, GitLab, Freestyle, plain git).

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
    originSessionId: text('origin_session_id').references(() => projectSessions.sessionId, { onDelete: 'set null' }),
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

// ─── IAM (Cloudflare-style groups + policies) ──────────────────────────────
// Layered on top of account_members. A user's effective permissions are the
// union of: super-admin bypass, the legacy account_role bridge, direct policies
// on the member, and policies on any group the member belongs to.

export const accountGroupSourceEnum = kortixSchema.enum('account_group_source', [
  'manual',
  'scim',
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
    role: projectRoleEnum('role').default('viewer').notNull(),
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
     *  is shown ONCE at creation, never persisted. */
    secretHash: text('secret_hash').notNull(),
    /** Display prefix so admins can recognise SAs in lists. */
    publicPrefix: varchar('public_prefix', { length: 32 }).notNull(),
    /** active | disabled. Disabled SAs are kept for audit trail but
     *  refuse every request. */
    status: varchar('status', { length: 16 }).default('active').notNull(),
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
    uniqueIndex('idx_service_accounts_account_name').on(table.accountId, table.name),
  ],
);

// ─── Resource groups: project groups ───────────────────────────────────────
// Bundle multiple projects under one name so a single policy can target
// the whole bundle ("Mobile editors: editor role on group=mobile-prod").
// Cloudflare-style. Group membership is many-to-many; one project can
// belong to multiple groups. The IAM engine treats project_group as a
// scope type and resolves "is target project in this group?" at match
// time.


// ─── Permission usage analytics ("Access Analyzer") ────────────────────────
// Counters of every (user, action) the IAM engine has allowed in this
// account. Updated lazily (throttled in-memory) to keep write pressure
// bounded. Lets admins right-size roles based on actual usage and spot
// unused privileges. Denies are NOT tracked here — that's a separate
// "denied attempts" feature.


// ─── Break-glass emergency access ──────────────────────────────────────────
// Time-bounded super-admin grant a privileged member can self-activate
// in an emergency. The grant carries a mandatory reason, auto-expires
// (1h default, configurable per activation), and the IAM engine treats
// the holder as super-admin during the active window. Activation +
// revocation + expiry all hit the audit log so SOC reviews can show
// "who broke glass, when, why".
//
// Gating: only members who already hold member.super_admin.grant can
// activate. That keeps the same admin trust boundary — break-glass
// formalises emergency promotion without inventing a new privilege.


// ─── Approval requests for sensitive IAM actions ───────────────────────────
// Two-phase pattern: the sensitive endpoint stores the requested action
// + payload here and returns 202; a second admin POSTs /approve to
// execute it. Requester can't approve their own request.
//
// v1 covers a curated set of high-blast-radius actions:
//   - member.super_admin.grant
//   - iam.mfa_required.disable
//   - account.delete


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
    /** Exact match against an entry in the group claim. Case-sensitive
     *  to match how IdPs ship the values. */
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
 * Connectors are DEFINED in kortix.toml ([[connectors]]) and materialized here
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
 * How a connector's credential is stored/used:
 *   shared   = one project-level credential everyone with access uses.
 *   per_user = each member connects their own (BYO account / key).
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
    /** Who can use this connector. `project` = all members; `restricted` = the grants below. */
    shareScope: secretShareScopeEnum('share_scope').default('project').notNull(),
    /** Credential storage model — shared project credential vs each member brings their own. */
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
  ],
);

/** Access allow-list for a `restricted` connector — which members/groups can use it. */
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
    uniqueIndex('idx_executor_connector_grants_unique').on(table.connectorId, table.principalType, table.principalId),
  ],
);

/**
 * Connector credentials — split from the connector. One row per (connector, user):
 * `user_id = NULL` is the shared project credential; a set `user_id` is that
 * member's own (per_user mode). Value/binding encrypted; resolved server-side only.
 */
export const executorCredentials = kortixSchema.table(
  'executor_credentials',
  {
    credentialId: uuid('credential_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => executorConnectors.connectorId, { onDelete: 'cascade' }),
    /** NULL = shared project credential; set = this member's own. */
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
    uniqueIndex('idx_executor_credentials_connector_user').on(table.connectorId, table.userId),
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
  (table) => [
    index('idx_executor_connector_policies_connector').on(table.connectorId),
  ],
);

/**
 * Project-scoped tool-call policies — materialized from top-level [[policies]]
 * in kortix.toml. Patterns are fully-qualified (`<slug>.<path>` globs) and apply
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
  (table) => [
    index('idx_executor_project_policies_project').on(table.projectId),
  ],
);

export const executorDefaultModeEnum = kortixSchema.enum('executor_default_mode', [
  'risk',
  'allow_all',
]);

/**
 * One row per project — non-policy executor settings (just `default_mode`
 * today). Materialized from [policy] in kortix.toml; missing block = allow_all
 * for back-compat with existing projects.
 */
export const executorProjectSettings = kortixSchema.table(
  'executor_project_settings',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    defaultMode: executorDefaultModeEnum('default_mode').default('allow_all').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

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
    index('idx_executor_executions_connector').on(table.connectorId),
    index('idx_executor_executions_status').on(table.status),
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

export const executorConnectorPoliciesRelations = relations(executorConnectorPolicies, ({ one }) => ({
  connector: one(executorConnectors, {
    fields: [executorConnectorPolicies.connectorId],
    references: [executorConnectors.connectorId],
  }),
}));

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

export const projectSecretGrantsRelations = relations(projectSecretGrants, ({ one }) => ({
  secret: one(projectSecrets, {
    fields: [projectSecretGrants.secretId],
    references: [projectSecrets.secretId],
  }),
}));
