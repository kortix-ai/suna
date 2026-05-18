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

export const projectTriggerTypeEnum = kortixSchema.enum('project_trigger_type', [
  'cron',
  'webhook',
]);

export const projectTriggerEventStatusEnum = kortixSchema.enum('project_trigger_event_status', [
  'queued',
  'fired',
  'failed',
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

export const accountSecretKindEnum = kortixSchema.enum('account_secret_kind', [
  'api_key',
  'oauth_subscription',
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

export const accountSecrets = kortixSchema.table(
  'account_secrets',
  {
    secretId: uuid('secret_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    kind: accountSecretKindEnum('kind').default('api_key').notNull(),
    provider: varchar('provider', { length: 32 }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_secrets_account').on(table.accountId),
    index('idx_account_secrets_kind').on(table.kind),
    uniqueIndex('idx_account_secrets_account_name').on(table.accountId, table.name),
  ],
);

export const accountGithubInstallations = kortixSchema.table(
  'account_github_installations',
  {
    accountId: uuid('account_id')
      .primaryKey()
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
    uniqueIndex('idx_account_github_installations_installation').on(table.installationId),
    index('idx_account_github_installations_owner').on(table.ownerLogin),
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_members_account_user').on(table.accountId, table.userId),
    index('idx_project_members_project').on(table.projectId),
    uniqueIndex('idx_project_members_project_user').on(table.projectId, table.userId),
  ],
);

export const projectSecrets = kortixSchema.table(
  'project_secrets',
  {
    secretId: uuid('secret_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    valueEnc: text('value_enc').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_secrets_project').on(table.projectId),
    uniqueIndex('idx_project_secrets_project_name').on(table.projectId, table.name),
  ],
);

export const projectConnections = kortixSchema.table(
  'project_connections',
  {
    connectionId: uuid('connection_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    sourceType: varchar('source_type', { length: 32 }).default('static').notNull(),
    config: jsonb('config').default({}).$type<Record<string, unknown>>(),
    enabled: boolean('enabled').default(true).notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_connections_account').on(table.accountId),
    index('idx_project_connections_project').on(table.projectId),
    uniqueIndex('idx_project_connections_project_name').on(table.projectId, table.name),
  ],
);

export const projectConnectionTools = kortixSchema.table(
  'project_connection_tools',
  {
    toolId: uuid('tool_id').defaultRandom().primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => projectConnections.connectionId, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    name: varchar('name', { length: 192 }).notNull(),
    description: text('description'),
    inputSchema: jsonb('input_schema').default({}).$type<Record<string, unknown>>(),
    implementation: jsonb('implementation').default({}).$type<Record<string, unknown>>(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_connection_tools_connection').on(table.connectionId),
    index('idx_project_connection_tools_project').on(table.projectId),
    uniqueIndex('idx_project_connection_tools_project_name').on(table.projectId, table.name),
  ],
);

export const projectTriggers = kortixSchema.table(
  'project_triggers',
  {
    triggerId: uuid('trigger_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    type: projectTriggerTypeEnum('type').notNull(),
    config: jsonb('config').default({}).$type<Record<string, unknown>>(),
    agentName: varchar('agent_name', { length: 128 }).default('default').notNull(),
    promptTemplate: text('prompt_template').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdBy: uuid('created_by'),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_triggers_account').on(table.accountId),
    index('idx_project_triggers_project').on(table.projectId),
    index('idx_project_triggers_type_enabled').on(table.type, table.enabled),
  ],
);

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
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_sessions_account').on(table.accountId),
    index('idx_project_sessions_project').on(table.projectId),
    index('idx_project_sessions_status').on(table.status),
    uniqueIndex('idx_project_sessions_project_branch').on(table.projectId, table.branchName),
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

export const projectTriggerEvents = kortixSchema.table(
  'project_trigger_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    triggerId: uuid('trigger_id')
      .notNull()
      .references(() => projectTriggers.triggerId, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    status: projectTriggerEventStatusEnum('status').default('queued').notNull(),
    payload: jsonb('payload').default({}).$type<Record<string, unknown>>(),
    renderedPrompt: text('rendered_prompt'),
    sessionId: text('session_id').references(() => projectSessions.sessionId, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_trigger_events_trigger').on(table.triggerId),
    index('idx_project_trigger_events_project_status').on(table.projectId, table.status),
    index('idx_project_trigger_events_status_created').on(table.status, table.createdAt),
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
  members: many(projectMembers),
  secrets: many(projectSecrets),
  connections: many(projectConnections),
  connectionTools: many(projectConnectionTools),
  triggers: many(projectTriggers),
  triggerEvents: many(projectTriggerEvents),
  sessions: many(projectSessions),
  runtimeSnapshots: many(projectRuntimeSnapshots),
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

export const accountSecretsRelations = relations(accountSecrets, ({ one }) => ({
  account: one(accounts, {
    fields: [accountSecrets.accountId],
    references: [accounts.accountId],
  }),
}));

export const projectConnectionsRelations = relations(projectConnections, ({ one, many }) => ({
  account: one(accounts, {
    fields: [projectConnections.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectConnections.projectId],
    references: [projects.projectId],
  }),
  tools: many(projectConnectionTools),
}));

export const projectConnectionToolsRelations = relations(projectConnectionTools, ({ one }) => ({
  account: one(accounts, {
    fields: [projectConnectionTools.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectConnectionTools.projectId],
    references: [projects.projectId],
  }),
  connection: one(projectConnections, {
    fields: [projectConnectionTools.connectionId],
    references: [projectConnections.connectionId],
  }),
}));

export const projectTriggersRelations = relations(projectTriggers, ({ one, many }) => ({
  account: one(accounts, {
    fields: [projectTriggers.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectTriggers.projectId],
    references: [projects.projectId],
  }),
  events: many(projectTriggerEvents),
}));

export const projectTriggerEventsRelations = relations(projectTriggerEvents, ({ one }) => ({
  account: one(accounts, {
    fields: [projectTriggerEvents.accountId],
    references: [accounts.accountId],
  }),
  project: one(projects, {
    fields: [projectTriggerEvents.projectId],
    references: [projects.projectId],
  }),
  trigger: one(projectTriggers, {
    fields: [projectTriggerEvents.triggerId],
    references: [projectTriggers.triggerId],
  }),
  session: one(projectSessions, {
    fields: [projectTriggerEvents.sessionId],
    references: [projectSessions.sessionId],
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
  projectConnections: many(projectConnections),
  projectConnectionTools: many(projectConnectionTools),
  projectTriggers: many(projectTriggers),
  projectTriggerEvents: many(projectTriggerEvents),
  projectSessions: many(projectSessions),
  projectRuntimeSnapshots: many(projectRuntimeSnapshots),
  sandboxes: many(sandboxes),
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
  },
  (table) => [
    index('kortix_credit_accounts_account_id_idx').on(table.accountId),
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
