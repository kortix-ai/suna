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

/**
 * DELIVERY strategy for a project secret — orthogonal to `projectSecretScopeEnum`
 * below. Where `scope` says which subsystem OWNS a row, `strategy` says how (and
 * whether) the value reaches the wire:
 *
 *   runtime  the plaintext value is injected into the sandbox env — today's
 *            behavior, and the default, so an existing deployment is unchanged.
 *   egress   a format-shaped handle is injected; the real credential is attached
 *            outside the guest by the egress proxy, per host+method+path.
 *   broker   a handle (or a session-scoped gateway key) is injected; a named
 *            Kortix chokepoint attaches the credential.
 *   denied   nothing is injected — the name is not emitted at all.
 *
 * The order of the values IS the strictness lattice: composition across the DB
 * row, the manifest, the agent grant and the session allowlist takes the MAX, so
 * a declaration can only ever strengthen delivery, never weaken it. Adding a
 * value in the middle would silently re-rank every stored row — append only.
 *
 * A third `scope` value was deliberately NOT used: `scope='connector'` rows are
 * written live by the channels install store and mean something else entirely.
 *
 * Declared up here with the other early enums because `projects` (the first
 * table that uses it) is defined well above the secrets section, and a table's
 * column builders run at module load — a later `const` would be in its TDZ.
 */
export const projectSecretStrategyEnum = kortixSchema.enum('project_secret_strategy', [
  'runtime',
  'egress',
  'broker',
  'denied',
]);

/** The only service allowed to receive a decrypted project secret value. */
export const projectSecretConsumerEnum = kortixSchema.enum('project_secret_consumer', [
  'sandbox',
  'llm_gateway',
  'connector',
  'git_proxy',
  'http_broker',
  'network',
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

export const sessionLifecycleCommandStatusEnum = kortixSchema.enum(
  'session_lifecycle_command_status',
  ['queued', 'running', 'succeeded', 'failed', 'dead_lettered'],
);

// Lifecycle of a durable sandbox-provider migration (prepare → verify →
// activate). The active provider is NOT flipped until the target's per-project
// ppwarm image is built + verified; see apps/api/src/projects/provider-transition/*.
//   pending     — recorded; source provider still active for new sessions
//   building    — the target ppwarm image is being (re)built
//   ready       — image built + present on the target provider
//   activating  — passed re-verification; flipping the active pin (CAS)
//   activated   — pin flipped; new sessions use the prepared image
//   failed      — prep failed; source provider remains active (retryable)
//   superseded  — a newer transition/intent replaced this one
//   cancelled   — the user switched back / cancelled before activation
export const providerTransitionStatusEnum = kortixSchema.enum('provider_transition_status', [
  'pending',
  'building',
  'ready',
  'activating',
  'activated',
  'failed',
  'superseded',
  'cancelled',
]);

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
    // Delivery floor for secrets created in this project. Composed as a MAX with
    // the row's own strategy, so raising it here can only ever strengthen an
    // existing secret. Stays 'runtime' for every existing project — a
    // Kortix-as-a-Backend project is the case that wants 'denied', where an
    // undeclared secret exists but has no path until someone declares one.
    secretDefaultStrategy: projectSecretStrategyEnum('secret_default_strategy')
      .default('runtime')
      .notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    // Caller-supplied dedupe token for POST /v1/projects/provision. That route
    // mints a brand-new managed repo per call, so a retry after a lost response
    // used to create a real duplicate project + duplicate upstream repo. The
    // route looks this up BEFORE it creates anything upstream and returns the
    // existing project instead. NULL on every project created any other way
    // (BYO-repo link, /create-repo, CLI) and on every pre-existing row — the
    // partial unique index below only constrains rows that carry a key.
    idempotencyKey: text('idempotency_key'),
    // Monotonic CAS token for sandbox-provider switching. Reserved (bumped) on
    // THIS row at switch-REQUEST time and stamped onto the new provider_transitions
    // row; a later switch/cancel bumps it again. Activation is a conditional
    // UPDATE predicated on this value still equalling the transition's stamped
    // generation — so an older transition settling late can never overwrite newer
    // intent. See apps/api/src/projects/provider-transition/*.
    sandboxProviderGeneration: integer('sandbox_provider_generation').default(0).notNull(),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_projects_account').on(table.accountId),
    index('idx_projects_status').on(table.status),
    index('idx_projects_updated').on(table.updatedAt),
    index('idx_projects_account_repo').on(table.accountId, table.repoUrl),
    // The dedupe guarantee itself, not just a lookup index: two concurrent
    // provisions carrying the same key can both miss the pre-check, and only a
    // unique constraint stops the second INSERT. Partial, so the ~all rows with
    // no key are unconstrained. Account-scoped — one account's key must never
    // collide with another's.
    uniqueIndex('idx_projects_account_idempotency_key')
      .on(table.accountId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
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
 * `connectors`/`connector_grants` (connector sharing) and
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
 * boot (existing behavior). `connector` secrets are connector
 * credentials / Pipedream connection bindings — resolved SERVER-SIDE by the
 * gateway and NEVER injected into the sandbox.
 */
export const projectSecretScopeEnum = kortixSchema.enum('project_secret_scope', [
  'runtime',
  'connector',
]);

/**
 * How a non-`runtime` secret is allowed to leave the box. Stored shape only —
 * the grammar, the host/method/path matcher and the "no match ⇒ deny" rule live
 * in the API's strategy module, which parses this blob DEFENSIVELY: a row can
 * outlive the code that wrote it, and for `egress` this JSON is the thing that
 * decides whether a credential is attached to an agent-influenced request.
 *
 * Keys are snake_case because this is the same document the REST route, the
 * manifest `[env]` object form and the CLI accept — one grammar, not three.
 */
export interface SecretEgressRule {
  /** Exact host, or ONE leading `*.` suffix. Never a regex — see matchRule. */
  host: string;
  /** Absent or empty = any method. */
  methods?: string[];
  /** Exact path, or ONE trailing `/*`. Absent = any path under `host`. */
  path?: string;
  /** Where the credential is attached. Absent = the policy-level default. */
  inject?: SecretInjectionSlot;
}

export type SecretInjectionSlot =
  | { kind: 'header'; name: string; template?: string }
  | { kind: 'query'; name: string }
  | { kind: 'json_body_field'; path: string };

export interface SecretEgressPolicy {
  /** For `strategy='broker'`: which Kortix chokepoint holds the real value. */
  backend?: 'llm_gateway' | 'connector' | 'git_proxy' | 'kortix_fetch';
  /** Env var carrying the base URL that points an unmodified vendor SDK at us. */
  base_url_env?: string;
  /**
   * REQUIRED and non-empty. A policy with no rules matches nothing, and since
   * "no match" is a deny, it would be an elaborate way to write `denied` — far
   * more likely a caller who forgot the field than one who meant it.
   */
  rules: SecretEgressRule[];
  /**
   * REQUIRED. Where the credential is attached when a rule does not override it.
   * "First match wins, no match denies" only means something if a matched rule
   * has a defined slot to inject into; an absent default would leave a matched
   * request with nowhere to put the secret and no principled answer.
   */
  inject: SecretInjectionSlot;
  /** `observe` tunnels and audits undeclared hosts so a project can discover its
   *  real egress footprint before committing to `deny`. */
  on_no_match?: 'deny' | 'observe';
  /** `tunnel` blind-pipes a host for cert-pinned clients — and so cannot inject. */
  tls?: 'terminate' | 'tunnel';
}

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
    /** How the value reaches the wire. See projectSecretStrategyEnum. Set on
     *  INSERT only, never on conflict-update — mirroring `scope` — so a value
     *  re-entered through a setup link or `kortix env push` can never silently
     *  downgrade a brokered secret back to plaintext. */
    strategy: projectSecretStrategyEnum('strategy').default('runtime').notNull(),
    /** The only boundary allowed to consume plaintext. NULL means no consumer. */
    consumer: projectSecretConsumerEnum('consumer').default('sandbox'),
    /** NULL while strategy = 'runtime'; there is no wire for a plaintext row. */
    egressPolicy: jsonb('egress_policy').$type<SecretEgressPolicy>(),
    /** Format-shaping prefix for the minted handle (e.g. 'sk-ant-api03-') so a
     *  vendor SDK that regex-validates key SHAPE keeps constructing. NULL uses
     *  the self-describing default, which instead lands remediation text in the
     *  model's own context when a stray SDK 401s. */
    handlePrefix: varchar('handle_prefix', { length: 48 }),
    /** Free-text note. The setup-link flow has always collected this and thrown
     *  it away; the Delivery UI needs somewhere to say what a secret is for. */
    description: text('description'),
    /** Last explicit rotation. Distinct from updatedAt, which any edit bumps —
     *  "anything ever delivered as runtime must be ROTATED, not re-scoped", so
     *  this has to be answerable per secret. */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    /** Pins the strategy against every write path including the dedicated
     *  strategy route. An agent with an unrestricted grant can otherwise flip a
     *  row back to 'runtime' and reboot to read the value it was denied. */
    strategyLocked: boolean('strategy_locked').default(false).notNull(),
    // NULL = the shared project-level row. Non-null = that member's PRIVATE
    // per-identifier override (used ONLY by the CODEX_AUTH_JSON per-user
    // provider login today — the general "only me" override was retired, see
    // migration 20260702120000000_unify_secret_access_share_model.sql). Mirrors
    // connection_credentials.userId. See docs/specs/connector.md / iam.md.
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
    // NOTE: a partial index `idx_project_secrets_project_strategy`
    // ((project_id, strategy) WHERE strategy <> 'runtime') ALSO exists, created
    // by 20260728132613912_secret_delivery_indexes.concurrent.ts. It is
    // intentionally NOT declared here so `db:generate` won't emit a conflicting
    // plain CREATE INDEX against the already-built one — index create/drop is
    // the CONCURRENTLY escape hatch's territory (see MIGRATIONS.md).
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

// How a session was started, as a POLICY CLASS (distinct from the surface it
// came from, which lives in metadata.source). Derived from the caller's token
// kind + invocation source at create time — NEVER from the request body — and
// used to gate which override fields the caller may set (see session-origin.ts).
export const projectSessionOriginEnum = kortixSchema.enum('project_session_origin', [
  'user',
  'trigger',
  'schedule',
  'backend',
  'system',
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
    // Policy class this session was created under (default 'user'). `originRef`
    // is the backend wrapper's opaque end-user handle — set ONLY for
    // backend-origin sessions (a service account or API key/PAT); null for
    // everything else.
    origin: projectSessionOriginEnum('origin').default('user').notNull(),
    originRef: text('origin_ref'),
    // Backend-only per-session secrets allowlist (KaaB): a list of project-secret
    // IDENTIFIERS this session may receive. Set ONLY by a backend-origin caller
    // at create; immutable afterward. Semantics are pure NARROWING — the injected
    // env is (today's agent-grant set) ∩ (this allowlist), enforced at BOTH boot
    // and hot-push. null = no restriction (byte-identical to pre-KaaB behavior).
    secretsAllowlist: jsonb('secrets_allowlist').$type<string[]>(),
    // Connector aliases this session REQUIRES, independent of whether anything is
    // connected to them yet.
    //
    // A binding row cannot express this: `connection_id` is NOT NULL, so a binding is
    // "use THIS connection", never "this session needs Gmail and has none". That
    // gap is why the UI had to grey out an unconnected connector — there was
    // nowhere to record the intent — and why `require_connectors` on create was
    // read, enforced once, and then forgotten, leaving every later prompt and
    // every warm-claim re-check blind to what the caller actually asked for.
    //
    // Checked as a UNION with the running agent's manifest `connectors_required`
    // and the session's binding rows (see projects/lib/prompt-connector-preflight.ts),
    // so this column narrows nothing and only ever ADDS a requirement.
    // null/absent = the caller declared none.
    requiredConnectors: jsonb('required_connectors').$type<string[]>(),
    // Distinguishes omitted connector_bindings from an explicit replacement.
    connectorBindingsConfigured: boolean('connector_bindings_configured').default(false).notNull(),
    // When a session sets `connector_bindings`, binding ANY alias normally
    // suppresses the project-default fallback for every OTHER (unbound) alias —
    // "all-or-nothing" (see resolveSessionConnectorConnection). This opts the session
    // out: unbound aliases keep resolving to the project DEFAULT connection, so a
    // caller can override just one connector (e.g. a user's own Gmail) without
    // re-binding the rest. Only ever inherits the project default — never another
    // owner's connection — so it is safe for any origin.
    //
    // Set at create AND changeable by `PUT /sessions/{id}/scope`. It used to say
    // "immutable after", which stopped being true when the re-scope route landed
    // and silently forced it to false on every binding change — quietly cutting
    // off project-default fallback for a session that had been relying on it.
    connectorBindingsInheritUnbound: boolean('connector_bindings_inherit_unbound')
      .default(false)
      .notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_sessions_account').on(table.accountId),
    index('idx_project_sessions_project').on(table.projectId),
    index('idx_project_sessions_status').on(table.status),
    index('idx_project_sessions_created_by').on(table.createdBy),
    // Per-END-USER concurrency cap for Kortix-as-a-Backend: COUNT of a single
    // origin_ref's live sessions, checked on every backend session create.
    // Partial on the ACTIVE statuses (mirroring ACTIVE_SESSION_STATUSES in
    // apps/api/src/projects/lib/session-status.ts) and on origin_ref IS NOT
    // NULL, so it indexes only live backend sessions — a small fraction of the
    // table, and nothing at all for non-KaaB projects.
    // Supports the KaaB "list this end-user's sessions" filter, which spans ALL
    // statuses — the partial active-only index below cannot serve it.
    index('idx_project_sessions_project_origin')
      .on(table.projectId, table.originRef)
      .where(sql`${table.originRef} is not null`),
    index('idx_project_sessions_account_origin_active')
      .on(table.accountId, table.originRef)
      .where(
        sql`${table.originRef} is not null and ${table.status} in ('queued','branching','provisioning','running')`,
      ),
    uniqueIndex('idx_project_sessions_project_branch').on(table.projectId, table.branchName),
    uniqueIndex('idx_project_sessions_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.sessionId,
    ),
    uniqueIndex('idx_project_sessions_one_available_warm')
      .on(table.projectId, table.createdBy)
      .where(
        sql`${table.createdBy} is not null
          and ${table.metadata}->'warm_session'->>'state' = 'available'
          and coalesce(${table.metadata}->>'deletedAt', '') = ''`,
      ),
    // NOTE: a plain btree `idx_project_sessions_created_at` (created_at) ALSO
    // exists — created by migrations/20260807202731277_admin_analytics_time_indexes.concurrent.ts
    // so the admin activity dashboard's global `created_at >= $1` window scan
    // doesn't seq-scan the whole session history. Declared there, not here, for
    // the same reason as the index below: it must be built CONCURRENTLY.
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

/**
 * Lifecycle of one minted secret handle. `superseded` rather than deletion so a
 * handle that shows up after rotation can still be attributed to the session and
 * secret it was minted for — an unattributable handle is indistinguishable from
 * a forged one, which is the whole point of keeping the row.
 */
export const projectSecretHandleStatusEnum = kortixSchema.enum('project_secret_handle_status', [
  'active',
  'superseded',
  'revoked',
]);

/**
 * The handle a sandbox holds INSTEAD of a secret's value when that secret's
 * delivery strategy is not `runtime`. One row per (session, secret, revision);
 * minted at boot and reused on every hot push, so the string inside the box is
 * stable for the session's life.
 *
 * The row stores `lookupId` and a SHA-256 of the full handle — never the handle
 * itself. Presenting a handle is authentication, so a dump of this table must
 * not be usable to spend the credentials it describes.
 *
 * `policySnapshot` is frozen at mint time on purpose: a live handle may LOSE
 * validity (revocation, session end) but must never GAIN a host. Re-reading the
 * secret's current `egressPolicy` at call time would let an agent widen its own
 * reach by editing the row it was denied the value of.
 *
 * NOTE: this table's indexes — idx_secret_handles_lookup (unique, lookup_id),
 * idx_secret_handles_session (session_id) and idx_secret_handles_session_secret_rev
 * (unique, session_id + secret_id + revision) — are intentionally NOT declared
 * here. They ship in 20260728132613912_secret_delivery_indexes.concurrent.ts so
 * index creation stays on the CONCURRENTLY path; declaring them would make
 * `db:generate` emit conflicting plain CREATE INDEX statements. See MIGRATIONS.md.
 */
export const projectSessionSecretHandles = kortixSchema.table('project_session_secret_handles', {
  handleId: uuid('handle_id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.projectId, { onDelete: 'cascade' }),
  sessionId: text('session_id')
    .notNull()
    .references(() => projectSessions.sessionId, { onDelete: 'cascade' }),
  secretId: uuid('secret_id')
    .notNull()
    .references(() => projectSecrets.secretId, { onDelete: 'cascade' }),
  /** Denormalized from the secret so a handle presented after the row is
   *  deleted still audits as something a human can read. */
  identifier: varchar('identifier', { length: 128 }).notNull(),
  /** The env var KEY this handle was emitted under. Same non-uniqueness as
   *  project_secrets.name — two identifiers may share one key. */
  envName: varchar('env_name', { length: 64 }).notNull(),
  /** The public 96-bit component of the handle; what the broker looks up. */
  lookupId: varchar('lookup_id', { length: 32 }).notNull(),
  /** SHA-256 hex of the whole handle string — 64 chars, always. varchar and
   *  not char(64) despite the fixed width: char blank-pads and compares
   *  ignoring trailing spaces, and squawk's ban-char-field is on. */
  handleHash: varchar('handle_hash', { length: 64 }).notNull(),
  /** Bumped by per-prompt rotation; the previous revision goes `superseded`
   *  with an overlap window rather than dying mid-turn. */
  revision: integer('revision').default(1).notNull(),
  policySnapshot: jsonb('policy_snapshot').$type<SecretEgressPolicy>().notNull(),
  status: projectSecretHandleStatusEnum('status').default('active').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// Account-scoped default model preferences. Drives server-side resolution of the
// synthetic `auto` model in the LLM gateway: a request for `auto` resolves to the
// per-agent default (scope='agent', scope_key=agent_name) → the account default
// (scope='account', scope_key='') → the platform default. The stored `model` is a
// gateway wire model (a bare managed id like 'glm-5.2', a BYOK 'provider/model',
// or 'codex/<id>') — never the synthetic `auto`.
//
// `project_id` (added 2026-07-18, see 20260718*_account_model_preferences_project_id.sql)
// scopes an agent-name pin to the ONE project that set it: agent names are declared
// per-project (each project's own kortix.yaml), so without this, two unrelated
// projects sharing an account and an agent name (almost always the conventional
// 'kortix') would clobber each other's pin — the row was keyed only on
// (account, scope, scope_key=agent_name), account-wide. `project_id` is NULL for
// scope IN ('account','project') always, and for PRE-migration `scope='agent'` rows
// (they keep applying account-wide as a fallback until the owning project explicitly
// re-pins that agent, which writes a NEW project-scoped row — the legacy row is
// never auto-migrated/deleted, so OTHER projects that never re-pin keep seeing it).
// Two unique indexes replace the old single one so both shapes stay enforced:
//   idx_account_model_preferences_scope_global  (account_id, scope, scope_key)
//     WHERE project_id IS NULL   — account/project scope + legacy global agent pins
//   idx_account_model_preferences_scope_project (account_id, scope, scope_key, project_id)
//     WHERE project_id IS NOT NULL — new per-project agent pins
export const accountModelPreferences = kortixSchema.table(
  'account_model_preferences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    scopeKey: text('scope_key').default('').notNull(),
    // Only ever set for scope='agent' — see doc comment above.
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'cascade' }),
    model: varchar('model', { length: 128 }).notNull(),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_account_model_preferences_account').on(table.accountId),
    uniqueIndex('idx_account_model_preferences_scope_global')
      .on(table.accountId, table.scope, table.scopeKey)
      .where(sql`${table.projectId} is null`),
    uniqueIndex('idx_account_model_preferences_scope_project')
      .on(table.accountId, table.scope, table.scopeKey, table.projectId)
      .where(sql`${table.projectId} is not null`),
  ],
);

export interface ProjectLlmRoutingRule {
  model: string;
  fallbackModels: string[];
  fallbackOn: 'transient' | 'any-error';
}

// Per-model generation-parameter defaults a project configures (reasoning
// effort, temperature, top_p, max output tokens, ...). Deliberately a single
// generic blob keyed by wire model id rather than one column per param —
// adding a new control later (e.g. a penalty knob) needs zero migration,
// only a shape change to `@kortix/llm-catalog`'s `GenerationConfig`. Values
// are clamped against the model's live catalog capabilities at BOTH the
// write path (apps/api's routing-policy PUT handler) and the resolution-
// layer injection path (routing/resolve-route.ts) — this column stores
// whatever was clamped at write time, but is re-clamped on every read since
// a model's capabilities (or the catalog itself) can change after the fact.
export type ProjectModelGenerationConfig = Record<
  string,
  {
    reasoningEffort?: string;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
  }
>;

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
    modelGenerationConfig: jsonb('model_generation_config')
      .default({})
      .$type<ProjectModelGenerationConfig>()
      .notNull(),
    /**
     * EXCEPTIONS to the catalog default, as `wireModelId -> enabled`. Effective
     * enablement is `overrides[id] ?? defaultEnabledModelIds(catalog).has(id)`
     * — the newest model per family is on, and this records only what an admin
     * deliberately changed. Display-only: it decides what the session picker
     * and "Manage models" OFFER; the gateway never refuses a request over it
     * (enforcement 400'd in-use models — the #5932 revert).
     *
     * Storing EXCEPTIONS rather than the resolved set is load-bearing: a stored
     * set freezes the moment it's written, so every later catalog addition (a
     * newly connected provider, next month's Claude) lands OFF and needs a
     * manual click. Overrides let the default keep tracking "the latest"
     * forever while still honouring explicit choices. It also removes the
     * `[]`-means-two-things ambiguity that made the previous `disabled_models`
     * opt-out list unable to express the default at all.
     */
    modelOverrides: jsonb('model_overrides').default({}).$type<Record<string, boolean>>().notNull(),
    /**
     * @deprecated Superseded by `modelOverrides`. Retained un-read for one
     * release so a mixed-version rollout can't hit a missing column on the
     * gateway's hot path; the contract migration drops it.
     */
    disabledModels: jsonb('disabled_models').default([]).$type<string[]>().notNull(),
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
    check(
      'project_llm_routing_policies_gen_config_object_check',
      sql`jsonb_typeof(${table.modelGenerationConfig}) = 'object'`,
    ),
    check(
      'project_llm_routing_policies_disabled_models_array_check',
      sql`jsonb_typeof(${table.disabledModels}) = 'array'`,
    ),
    check(
      'project_llm_routing_policies_model_overrides_object_check',
      sql`jsonb_typeof(${table.modelOverrides}) = 'object'`,
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
    // Materialized schedule catalog. The repo manifest remains the source of
    // truth, but the timing path reads only these indexed columns. Nullable
    // columns keep mixed-version deploys safe while existing rows are cataloged.
    triggerType: varchar('trigger_type', { length: 16 }),
    enabled: boolean('enabled'),
    scheduleCron: text('schedule_cron'),
    scheduleRunAt: timestamp('schedule_run_at', { withTimezone: true }),
    scheduleTimezone: varchar('schedule_timezone', { length: 128 }),
    scheduleRevision: varchar('schedule_revision', { length: 64 }),
    scheduleSpec: jsonb('schedule_spec').$type<Record<string, unknown>>(),
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    lastScheduledFor: timestamp('last_scheduled_for', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.slug] }),
    index('idx_project_trigger_runtime_owner_user').on(table.ownerUserId),
    index('idx_project_trigger_runtime_due').on(table.enabled, table.nextFireAt),
  ],
);

/**
 * Durable execution queue for materialized cron slots.
 *
 * A unique project/slug/revision/slot key prevents duplicate execution across
 * scheduler ticks, pod restarts, and concurrent leaders. The schedule catalog
 * advances in the same transaction that inserts this row.
 */
export const projectTriggerExecutions = kortixSchema.table(
  'project_trigger_executions',
  {
    executionId: uuid('execution_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull(),
    slug: varchar('slug', { length: 128 }).notNull(),
    scheduleRevision: varchar('schedule_revision', { length: 64 }).notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 32 }).default('queued').notNull(),
    spec: jsonb('spec').notNull().$type<Record<string, unknown>>(),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    sessionId: text('session_id'),
    commandId: uuid('command_id'),
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.projectId],
      name: 'project_trigger_exec_project_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [projectSessions.sessionId],
      name: 'project_trigger_exec_session_fk',
    }).onDelete('set null'),
    uniqueIndex('idx_project_trigger_executions_slot').on(
      table.projectId,
      table.slug,
      table.scheduleRevision,
      table.scheduledFor,
    ),
    index('idx_project_trigger_executions_due').on(
      table.status,
      table.availableAt,
      table.lockedUntil,
    ),
    index('idx_project_trigger_executions_project').on(table.projectId, table.createdAt),
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

/**
 * The shared transcript of a live voice call — written by the realtime provider
 * as speech happens, read back by the Kortix session through `voice_read`.
 *
 * `cursor` (bigserial) is what makes the read non-blocking: the agent loop is
 * single-threaded and can never sit on a stream, so it asks "what is new since
 * X" and gets an answer immediately. Ordering is on the cursor, never
 * created_at — two turns can land in the same millisecond and a wall-clock tie
 * would silently drop one on the next poll.
 */
export const voiceCallTurns = kortixSchema.table(
  'voice_call_turns',
  {
    cursor: bigint('cursor', { mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    callId: text('call_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    /** 'user' (a human in the call) | 'agent' (the voice agent speaking) |
     *  'tool' (an ask_kortix/run_command call the worker made through the
     *  voice MCP — see mcp.ts's callTool). CHECK constraint enforces this set. */
    role: varchar('role', { length: 16 }).notNull(),
    speaker: text('speaker'),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_voice_call_turns_call_cursor').on(table.callId, table.cursor),
    index('idx_voice_call_turns_session').on(table.sessionId, table.cursor),
  ],
);

/**
 * The Kortix agent's read position in a call's transcript — the state that lets
 * a bare `read_transcript {}` mean "only what I have not been shown yet".
 *
 * Cursor-paging was already incremental, but only for an agent that threaded the
 * returned cursor back on every call; one that forgot passed 0 and re-read the
 * whole conversation. Keeping the position here makes the cheap path the DEFAULT
 * path and removes the agent's obligation to remember anything.
 *
 * `cursor` is the highest `voice_call_turns.cursor` actually handed over, and it
 * only ever moves forward (the upsert's `setWhere` refuses to lower it) — a race
 * between two reads in one call must not rewind it. Exactly one writer: the
 * agent-side `read_transcript`. The call page's poll (r7.ts,
 * public-join-routes.ts) passes its own explicit cursor and never touches this
 * row, so a human scrolling the transcript cannot consume the agent's unread.
 */
export const voiceCallReadCursors = kortixSchema.table('voice_call_read_cursors', {
  /** The call — which is also the session id. */
  callId: text('call_id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Short, ungessable join links that resolve server-side to a fresh LiveKit
 * access token — see `apps/api/src/channels/voice/join-links.ts`. Replaces
 * handing out the raw ~300-char LiveKit JWT itself in `voice_spawn`'s
 * `join_url` (fragile in transit: one corrupted character breaks the
 * signature and the browser gets "invalid token").
 *
 * `token_hash` (sha256 of the raw token), never the raw token, is the primary
 * key — same posture as `project_session_public_shares.token_hash`: a DB dump
 * should not itself be a bag of live capability tokens.
 *
 * DB-backed rather than a stateless encrypted envelope (compare
 * `setup-links/token.ts`) for the one property a self-contained token cannot
 * give: revocation. A live call can end while a copy of its link is still
 * sitting in someone's chat history, and that link must stop working the
 * moment the call does (`revoked_at`, set by `endCall`) -- not just whenever
 * its TTL happens to lapse.
 */
export const voiceJoinLinks = kortixSchema.table(
  'voice_join_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    callId: text('call_id').notNull(),
    projectId: uuid('project_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_voice_join_links_call').on(table.callId)],
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
    // Start of this box's CURRENT continuous running stretch, and the anchor
    // operand of the 24h cap. Assigned ONLY by the DB trigger
    // kortix.session_sandboxes_anchor_guard(), which carries it forward on EVERY
    // application UPDATE in EVERY status and re-anchors a new stretch only when
    // resuming a park it witnessed itself. Never write this from TypeScript — a
    // constraint on a difference whose left operand a caller can slide forward
    // is a suggestion, not a bound.
    activeSince: timestamp('active_since', { withTimezone: true }).defaultNow().notNull(),
    // When the control plane stops this box. Single TS writer:
    // apps/api/src/projects/sandbox-deadline.ts. Bounded by a DB CHECK at
    // active_since + 24h.
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).defaultNow().notNull(),
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

// Durable prepare → verify → activate record for switching a project's active
// sandbox provider (primary use: Daytona → Platinum). One row per switch
// request; survives API restarts (a worker resumes non-terminal rows). The
// active provider (projects.metadata.default_sandbox_provider) is only flipped
// once `snapshot_name` is built + verified on `target_provider`. `generation`
// is the monotonically-increasing CAS token: activation only wins if this
// transition's generation is the latest recorded for the project, so an older
// transition settling late can never overwrite newer intent.
export const providerTransitions = kortixSchema.table(
  'provider_transitions',
  {
    transitionId: uuid('transition_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    // Provider the project was on when the switch was requested (audit; the
    // rollback target on a failed prep).
    sourceProvider: sandboxProviderEnum('source_provider').notNull(),
    targetProvider: sandboxProviderEnum('target_provider').notNull(),
    // Monotonic per-project CAS token, reserved on the project row at
    // switch-REQUEST time. NULL for a PREBUILD row: a prebuild builds the image
    // but carries no switch-INTENT, so it never bumps projects.sandbox_provider_generation
    // and can never activate — it cannot starve a real user switch. An on-demand
    // switch that adopts a ready prebuild stamps it with a freshly-reserved
    // generation (+ mode=switch). Multiple NULLs coexist under the unique index.
    generation: integer('generation'),
    // 'switch' (user intent → auto-activates when ready) | 'prebuild' (image
    // only, invisible to routing until adopted). Kept in a column (not metadata)
    // so the reconciler filters on it cheaply.
    mode: varchar('mode', { length: 16 }).default('switch').notNull(),
    status: providerTransitionStatusEnum('status').default('pending').notNull(),
    // Resolved prep identity — the exact thing we build + verify before flipping.
    commitSha: text('commit_sha'),
    baseRuntimeIdentity: text('base_runtime_identity'),
    snapshotName: text('snapshot_name'),
    // Exact provider-side template/build id (Platinum returns one) — tracked so
    // readiness is checked by id, not a truncated name listing.
    externalTemplateId: text('external_template_id'),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    // Explicit persisted failure class (auth_terminal | vanished | transient |
    // none) so a resumed drive on another instance retries/dead-letters exactly
    // like the one that failed — never re-derived from an in-memory guess.
    errorClass: varchar('error_class', { length: 32 }),
    // Persisted backoff gate (DB now()). A retryable failure sets this to
    // now()+backoff; the resume worker skips a row until it passes. Survives
    // restarts so backoff is not lost with process memory.
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    // Lease heartbeat for the resume worker (stale ⇒ re-drivable). Mirrors
    // suna_account_migrations.heartbeat_at.
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    // Monotonic lease-fencing token. acquireLease bumps COALESCE(lease_epoch,0)+1
    // on every ownership take; every drive-time state write + the activation CAS
    // is predicated on the caller's acquired epoch, so a zombie drive whose lease
    // TTL expired (a 30-40 min build outruns the 10-min TTL) is fenced out — its
    // writes match 0 rows and it ceases instead of clobbering the fresh owner.
    leaseEpoch: bigint('lease_epoch', { mode: 'number' }).default(0).notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_provider_transitions_project_recent').on(table.projectId, table.requestedAt.desc()),
    index('idx_provider_transitions_status').on(table.status),
    index('idx_provider_transitions_resume').on(table.status, table.nextRetryAt, table.heartbeatAt),
    // Atomic generation allocation guard: one transition per (project,
    // generation). The request path reserves the generation on the project row
    // under a row lock; this unique index is the backstop that makes a
    // double-allocation a hard error rather than silent CAS corruption.
    unique('uq_provider_transitions_project_generation').on(table.projectId, table.generation),
    // Dedup key: at most one LIVE transition per exact prep identity, so repeated
    // switch calls collapse onto one build. Covers live statuses ONLY —
    // failed/superseded/cancelled rows must never block a fresh switch.
    uniqueIndex('uq_provider_transitions_live_identity')
      .on(table.projectId, table.targetProvider, table.commitSha, table.baseRuntimeIdentity)
      .where(sql`status in ('pending','building','ready','activating')`),
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
     *  rejected by account-level handlers. Session connector tokens also set
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
     *  CLI/API actions + connectors the running agent may use. Resolved
     *  from the kortix.yaml `agents` map at session birth. The launching
     *  user's role is still enforced by route IAM, so effective access is
     *  user role ∩ agentGrant. Null for non-agent tokens (laptop CLI PATs,
     *  etc.) — which keep role-only access. */
    agentGrant: jsonb('agent_grant').$type<AgentGrant>(),
    /** Session this token belongs to (sandbox connector token, session_id =
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
    // Deliberately no FK. Account deletion must not rewrite or delete forensic history.
    accountId: uuid('account_id'),
    projectId: uuid('project_id'),
    sessionId: text('session_id'),
    opencodeSessionId: text('opencode_session_id'),
    turnId: text('turn_id'),
    messageId: text('message_id'),
    toolCallId: text('tool_call_id'),
    executionId: text('execution_id'),
    sessionSequence: bigint('session_sequence', { mode: 'number' }),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type'),
    agentId: text('agent_id'),
    agentName: text('agent_name'),
    initiatorActorType: text('initiator_actor_type'),
    initiatorActorId: text('initiator_actor_id'),
    parentEventId: uuid('parent_event_id'),
    delegationDepth: integer('delegation_depth').default(0).notNull(),
    source: text('source'),
    authoritativeSource: text('authoritative_source'),
    clientReportedSource: text('client_reported_source'),
    outcome: text('outcome'),
    action: text('action').notNull(),
    phase: text('phase').default('completed').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    correlationId: text('correlation_id'),
    causationId: text('causation_id'),
    sourceLedger: text('source_ledger'),
    sourceRecordId: text('source_record_id'),
    sourceRevision: text('source_revision'),
    inputSummary: jsonb('input_summary').$type<Record<string, unknown> | null>(),
    outputSummary: jsonb('output_summary').$type<Record<string, unknown> | null>(),
    inputSha256: varchar('input_sha256', { length: 64 }),
    outputSha256: varchar('output_sha256', { length: 64 }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    integrityPreviousHash: varchar('integrity_previous_hash', { length: 64 }),
    integrityHash: varchar('integrity_hash', { length: 64 }),
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
    index('idx_audit_events_account_project_time').on(
      table.accountId,
      table.projectId,
      table.occurredAt,
    ),
    index('idx_audit_events_account_session_time').on(
      table.accountId,
      table.sessionId,
      table.occurredAt,
    ),
    index('idx_audit_events_account_project_sequence').on(
      table.accountId,
      table.projectId,
      table.sessionSequence,
    ),
    index('idx_audit_events_account_session_sequence').on(
      table.accountId,
      table.sessionId,
      table.sessionSequence,
    ),
    index('idx_audit_events_account_source_phase_time').on(
      table.accountId,
      table.authoritativeSource,
      table.phase,
      table.occurredAt,
    ),
    index('idx_audit_events_account_client_source_time')
      .on(table.accountId, table.clientReportedSource, table.occurredAt)
      .where(sql`${table.clientReportedSource} is not null`),
    uniqueIndex('idx_audit_events_source_phase')
      .on(
        table.sourceLedger,
        table.sourceRecordId,
        table.phase,
        sql`coalesce(${table.sourceRevision}, '')`,
      )
      .where(sql`${table.sourceLedger} is not null and ${table.sourceRecordId} is not null`),
    index('idx_audit_events_action_pattern').using('btree', sql`${table.action} text_pattern_ops`),
    index('idx_audit_events_request').on(table.requestId),
    index('idx_audit_events_correlation').on(table.correlationId),
    // Standalone index on occurred_at so the admin ops dashboard's account-
    // agnostic "audit events in the last 24h" count
    // (apps/api/src/ops/index.ts) is an index-only scan instead of a full
    // sequential scan. The composite indices above all have a different
    // leading column, so they can't serve a `WHERE occurred_at >= …` with no
    // account/actor/resource filter — the scan was exceeding statement_timeout
    // on the growing audit_events table and 500-ing /ops/overview (Better Stack
    // error 4ba74f8c17f3e48e13c07511fb802ec55ba07294237c0985f3df792729e8f4d8).
    index('idx_audit_events_occurred_at').on(table.occurredAt),
  ],
);

export const auditSessionSequences = kortixSchema.table('audit_session_sequences', {
  sessionId: text('session_id').primaryKey(),
  lastSequence: bigint('last_sequence', { mode: 'number' }).default(0).notNull(),
  lastIntegrityHash: varchar('last_integrity_hash', { length: 64 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const usageEvents = kortixSchema.table(
  'usage_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.projectId, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    /**
     * Kortix-as-a-Backend attribution: which of the wrapper's END-USERS this
     * spend belongs to. A server-derived COPY of project_sessions.origin_ref,
     * resolved from the session at emit time — never read from a request body.
     *
     * Denormalized rather than joined at read time on purpose: the legacy router
     * path takes session_id from the request (body / X-Session-ID), so joining
     * usage_events.session_id -> project_sessions would let one end-user's agent
     * bill spend to another end-user inside the same wrapper account.
     *
     * NULL = unattributed (any row written before this column existed, plus
     * non-session spend like the model playground).
     */
    originRef: text('origin_ref'),
    actorUserId: uuid('actor_user_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    route: text('route').notNull(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    cachedTokens: integer('cached_tokens').default(0).notNull(),
    cacheWriteTokens: integer('cache_write_tokens').default(0).notNull(),
    legacyCostUsd: numeric('cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
    costUsd: numeric('cost_usd_precise', { precision: 20, scale: 10 }).default('0').notNull(),
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
    // Per-end-user metering: "spend for origin_ref X in a window", and the
    // group_by=origin_ref rollup. Partial — the vast majority of rows are
    // non-backend spend with a NULL origin_ref and never match this predicate.
    index('idx_usage_events_account_origin_time')
      .on(table.accountId, table.originRef, table.createdAt)
      .where(sql`${table.originRef} is not null`),
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
    cacheWriteTokens: integer('cache_write_tokens').default(0).notNull(),
    legacyUpstreamCost: numeric('upstream_cost', { precision: 12, scale: 6 })
      .default('0')
      .notNull(),
    upstreamCost: numeric('upstream_cost_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    legacyFinalCost: numeric('final_cost', { precision: 12, scale: 6 }).default('0').notNull(),
    finalCost: numeric('final_cost_precise', { precision: 20, scale: 10 }).default('0').notNull(),
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
    legacyBalance: numeric('balance', { precision: 12, scale: 4 }).default('0').notNull(),
    balance: numeric('balance_precise', { precision: 20, scale: 10 }).default('0').notNull(),
    legacyLifetimeGranted: numeric('lifetime_granted', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    lifetimeGranted: numeric('lifetime_granted_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    legacyLifetimePurchased: numeric('lifetime_purchased', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    lifetimePurchased: numeric('lifetime_purchased_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    legacyLifetimeUsed: numeric('lifetime_used', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    lifetimeUsed: numeric('lifetime_used_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    lastGrantDate: timestamp('last_grant_date', { withTimezone: true, mode: 'string' }),
    tier: varchar('tier', { length: 50 }).default('free'),
    billingCycleAnchor: timestamp('billing_cycle_anchor', { withTimezone: true, mode: 'string' }),
    nextCreditGrant: timestamp('next_credit_grant', { withTimezone: true, mode: 'string' }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    legacyExpiringCredits: numeric('expiring_credits', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    expiringCredits: numeric('expiring_credits_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    legacyNonExpiringCredits: numeric('non_expiring_credits', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    nonExpiringCredits: numeric('non_expiring_credits_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
    legacyDailyCreditsBalance: numeric('daily_credits_balance', { precision: 10, scale: 2 })
      .default('0')
      .notNull(),
    dailyCreditsBalance: numeric('daily_credits_balance_precise', { precision: 20, scale: 10 })
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
    // Operator-set "enterprise entitled" flag for a contracted cloud Enterprise
    // customer. When true the account resolves ALL enterprise entitlements
    // (SAML SSO, SCIM, RBAC, audit) regardless of its billing tier — decoupling
    // feature entitlements from the billing model. This is what lets a deal
    // that is BOTH Enterprise (entitlements) AND per-seat (billing) hold both
    // at once: `tier`/`billing_model` can be `per_seat` for Stripe seat
    // reconciliation while `enterprise_entitled=true` keeps SSO/SCIM/RBAC/audit
    // on. Without it, the per-seat Stripe webhook reconciliation clobbers
    // `tier` to `per_seat` (see webhooks.ts syncSubscriptionState) and strips
    // the enterprise identity surface on every ordinary subscription update.
    // Set out-of-band by an operator (admin route / migration), like the
    // `tier='enterprise'` sales-assignment, but independent of it. Default
    // false → fail-closed. Distinct from `demo_enterprise` (a self-serve
    // preview) and from `config.ENTERPRISE_LICENSE_AVAILABLE` (a platform-wide
    // self-host license): this is the per-account, real-contract flag.
    enterpriseEntitled: boolean('enterprise_entitled').default(false).notNull(),
    // Operator-set concurrent-session cap for this account. NULL (the default)
    // means "no override" — the account's plan tier decides the limit
    // (TierConfig.concurrentSessionLimit). When set, it takes precedence over
    // the tier limit in BOTH directions (raise for enterprise deals, lower for
    // abuse containment). Set out-of-band (data migration / operator SQL),
    // like tier='enterprise'.
    maxConcurrentSessions: integer('max_concurrent_sessions'),
    // Admin-issued trial. The trial NEVER writes `tier` — the Stripe webhook
    // (webhooks.ts syncSubscriptionState) overwrites `tier` on every
    // subscription event, so a trial encoded there would be clobbered. Instead
    // the trial overlays at resolution time (billing/services/effective-tier):
    // while `trial_status='active'` AND `trial_ends_at` is in the future, the
    // account resolves entitlements/limits/models as `trial_tier`. Expiry is
    // lazy (the resolver checks the timestamp) so correctness never depends on
    // a cron; the billing cron only flips `trial_status` to 'expired' for
    // hygiene. Reuses the vestigial baseline columns `trial_status`,
    // `trial_started_at`, `trial_ends_at` (previously written by nothing).
    trialTier: varchar('trial_tier', { length: 50 }),
    // Seat allowance while the trial is active. Enforced on member add/invite
    // for non-per_seat accounts (per-seat accounts meter seats via Stripe).
    trialSeats: integer('trial_seats'),
    trialNote: text('trial_note'),
    trialGrantedBy: uuid('trial_granted_by'),
    // Operator-set managed-models override. NULL (default) = the effective
    // tier decides (TierConfig.models includes 'all'). true = account may use
    // Kortix-managed model credentials regardless of tier. false = BYOK only,
    // even on a tier that normally grants managed models. Resolved in
    // billing/services/entitlements alongside the tier cache.
    managedModelsOverride: boolean('managed_models_override'),
  },
  (table) => [
    index('kortix_credit_accounts_account_id_idx').on(table.accountId),
    index('idx_credit_accounts_billing_model').on(table.billingModel),
  ],
);

// Billing v2 — per-second sandbox compute metering.
// One row per active window. Hibernate closes the row; resume opens a new one.
// Cost flows into credit_ledger as 'compute_debit'; this table is the audit trail.
/**
 * A question the agent asked that nobody has answered yet.
 *
 * Persisted OUTSIDE the sandbox on purpose. A blocked turn makes no gateway LLM
 * calls, so it earns no deadline extension and its box is parked on schedule —
 * correct, and the invariant that only a control-plane observation may extend a
 * box depends on it. What was wrong is that parking DESTROYED the question:
 * opencode restarts cold, so the user came back to a session that had silently
 * forgotten what it asked.
 *
 * Keeping the question here lets the box die on time and the conversation
 * survive it. The row is the durable half of park-and-restore.
 */
export const sessionPendingQuestions = kortixSchema.table(
  'session_pending_questions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** `project_sessions.session_id`. Text, matching that table's PK. */
    sessionId: text('session_id').notNull(),
    /** opencode's `question.asked` request id — the dedupe key with sessionId. */
    requestId: text('request_id').notNull(),
    /** The opencode session that asked; survives an opencode restart changing it. */
    opencodeSessionId: text('opencode_session_id'),
    /** The raw QuestionInfo[] as opencode reported it. */
    questions: jsonb().notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    /** Null while the question is still open — the index keys on this. */
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'string' }),
    answers: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The relay is best-effort and retries, so the same question can arrive
    // twice. Upsert on this instead of inserting duplicates the UI would render
    // as two identical prompts.
    uniqueIndex('session_pending_questions_session_request_uniq').on(
      table.sessionId,
      table.requestId,
    ),
    // The only hot read: "does this session have an open question?"
    index('session_pending_questions_open_idx')
      .on(table.sessionId)
      .where(sql`answered_at IS NULL`),
  ],
);

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
    workloadType: varchar('workload_type', { length: 16 }).default('session').notNull(),
    appRuntimeId: uuid('app_runtime_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'sandbox_compute_sessions_workload_type_check',
      sql`${table.workloadType} IN ('session', 'app')`,
    ),
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

/**
 * Stable, user-facing Kortix Apps. A row owns one hostname and an atomic
 * pointer to the deployment currently receiving traffic. Provider selection
 * never lives here; it is recorded on the immutable deployment and runtime.
 */
export const apps = kortixSchema.table(
  'apps',
  {
    appId: uuid('app_id').defaultRandom().primaryKey().notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: text('name').notNull(),
    routeKey: varchar('route_key', { length: 20 }).notNull().unique(),
    accessMode: varchar('access_mode', { length: 16 }).default('private').notNull(),
    accessPasswordHash: text('access_password_hash'),
    accessRevision: integer('access_revision').default(1).notNull(),
    desiredState: varchar('desired_state', { length: 16 }).default('running').notNull(),
    activeDeploymentId: uuid('active_deployment_id'),
    cpuCores: integer('cpu_cores').default(1).notNull(),
    memoryGb: integer('memory_gb').default(2).notNull(),
    diskGb: integer('disk_gb').default(10).notNull(),
    idleTimeoutSeconds: integer('idle_timeout_seconds').default(300).notNull(),
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 2 })
      .default('5.00')
      .notNull(),
    lastRequestAt: timestamp('last_request_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('apps_desired_state_check', sql`${table.desiredState} IN ('running', 'stopped')`),
    check(
      'apps_access_mode_check',
      sql`${table.accessMode} IN ('private', 'project', 'restricted', 'public', 'password')`,
    ),
    check('apps_access_revision_check', sql`${table.accessRevision} > 0`),
    check('apps_cpu_check', sql`${table.cpuCores} BETWEEN 1 AND 64`),
    check('apps_memory_check', sql`${table.memoryGb} BETWEEN 1 AND 512`),
    check('apps_disk_check', sql`${table.diskGb} BETWEEN 1 AND 2048`),
    check('apps_idle_timeout_check', sql`${table.idleTimeoutSeconds} BETWEEN 120 AND 86400`),
    check('apps_budget_check', sql`${table.monthlyBudgetUsd} >= 0`),
    uniqueIndex('apps_project_slug_live_unique')
      .on(table.projectId, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    index('apps_account_idx').on(table.accountId),
    index('apps_route_key_idx').on(table.routeKey),
  ],
);

/** Member and group allow-list for an App with restricted access. */
export const appAccessGrants = kortixSchema.table(
  'app_access_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.appId, { onDelete: 'cascade' }),
    principalType: secretGrantPrincipalEnum('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('app_access_grants_app_idx').on(table.appId),
    uniqueIndex('app_access_grants_unique').on(
      table.appId,
      table.principalType,
      table.principalId,
    ),
  ],
);

/** Immutable uploaded source archive or OCI reference. */
export const appArtifacts = kortixSchema.table(
  'app_artifacts',
  {
    artifactId: uuid('artifact_id').defaultRandom().primaryKey().notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).default('uploading').notNull(),
    objectPath: text('object_path').unique(),
    imageReference: text('image_reference'),
    sha256: varchar('sha256', { length: 64 }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mediaType: text('media_type'),
    metadata: jsonb().default({}).notNull(),
    error: text('error'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('app_artifacts_kind_check', sql`${table.kind} IN ('archive', 'oci_image')`),
    check(
      'app_artifacts_status_check',
      sql`${table.status} IN ('uploading', 'uploaded', 'ready', 'rejected', 'deleted')`,
    ),
    check('app_artifacts_size_check', sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} > 0`),
    index('app_artifacts_project_idx').on(table.projectId, table.createdAt),
    index('app_artifacts_sha_idx').on(table.accountId, table.sha256),
  ],
);

/** Immutable deployment version. Active routing remains an Apps-row pointer. */
export const appDeployments = kortixSchema.table(
  'app_deployments',
  {
    deploymentId: uuid('deployment_id').defaultRandom().primaryKey().notNull(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.appId, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => appArtifacts.artifactId, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: varchar('status', { length: 20 }).default('queued').notNull(),
    sourceKind: varchar('source_kind', { length: 16 }).notNull(),
    hostingType: varchar('hosting_type', { length: 16 }).default('sandbox').notNull(),
    hostingProvider: varchar('hosting_provider', { length: 32 }),
    providerBuildId: text('provider_build_id'),
    runtimeSpec: jsonb('runtime_spec').default({}).notNull(),
    buildSpec: jsonb('build_spec').default({}).notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    errorCode: text('error_code'),
    error: text('error'),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    sourceSessionId: text('source_session_id').references(() => projectSessions.sessionId, {
      onDelete: 'set null',
    }),
    actorType: varchar('actor_type', { length: 24 })
      .$type<'human' | 'agent' | 'service_account' | 'system'>()
      .default('human')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'app_deployments_status_check',
      sql`${table.status} IN ('queued', 'validating', 'building', 'provisioning', 'checking', 'ready', 'failed', 'cancelled')`,
    ),
    check(
      'app_deployments_source_kind_check',
      sql`${table.sourceKind} IN ('static', 'bundle', 'dockerfile', 'oci_image')`,
    ),
    check('app_deployments_hosting_type_check', sql`${table.hostingType} = 'sandbox'`),
    check(
      'app_deployments_actor_type_check',
      sql`${table.actorType} IN ('human', 'agent', 'service_account', 'system')`,
    ),
    check('app_deployments_version_check', sql`${table.version} > 0`),
    uniqueIndex('app_deployments_app_version_unique').on(table.appId, table.version),
    index('app_deployments_queue_idx').on(table.status, table.nextAttemptAt, table.createdAt),
    index('app_deployments_app_idx').on(table.appId, table.createdAt),
  ],
);

/** Provider sandbox executing one deployment. */
export const appRuntimes = kortixSchema.table(
  'app_runtimes',
  {
    runtimeId: uuid('runtime_id').defaultRandom().primaryKey().notNull(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => appDeployments.deploymentId, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    externalId: text('external_id').notNull(),
    status: varchar('status', { length: 20 }).default('provisioning').notNull(),
    controlPort: integer('control_port').default(7331).notNull(),
    ingressPort: integer('ingress_port').default(8080).notNull(),
    controlTokenHash: text('control_token_hash').notNull(),
    idleDeadlineAt: timestamp('idle_deadline_at', { withTimezone: true }),
    activityLeaseUntil: timestamp('activity_lease_until', { withTimezone: true }),
    wakeLeaseOwner: text('wake_lease_owner'),
    wakeLeaseUntil: timestamp('wake_lease_until', { withTimezone: true }),
    lastRequestAt: timestamp('last_request_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb().default({}).notNull(),
  },
  (table) => [
    check(
      'app_runtimes_status_check',
      sql`${table.status} IN ('provisioning', 'starting', 'running', 'stopping', 'stopped', 'error', 'deleted')`,
    ),
    index('app_runtimes_deployment_idx').on(table.deploymentId, table.createdAt),
    index('app_runtimes_external_idx').on(table.provider, table.externalId),
    uniqueIndex('app_runtimes_one_live_per_deployment')
      .on(table.deploymentId)
      .where(sql`${table.status} IN ('provisioning', 'starting', 'running', 'stopping')`),
  ],
);

/** Append-only deployment and runtime event stream. */
export const appDeploymentEvents = kortixSchema.table(
  'app_deployment_events',
  {
    eventId: uuid('event_id').defaultRandom().primaryKey().notNull(),
    deploymentId: uuid('deployment_id').notNull(),
    runtimeId: uuid('runtime_id').references(() => appRuntimes.runtimeId, { onDelete: 'set null' }),
    level: varchar('level', { length: 8 }).default('info').notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    data: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'app_deployment_events_deployment_fk',
      columns: [table.deploymentId],
      foreignColumns: [appDeployments.deploymentId],
    }).onDelete('cascade'),
    check(
      'app_deployment_events_level_check',
      sql`${table.level} IN ('debug', 'info', 'warn', 'error')`,
    ),
    index('app_deployment_events_deployment_idx').on(table.deploymentId, table.createdAt),
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
    legacyAmount: numeric('amount', { precision: 12, scale: 4 }).default('0').notNull(),
    amount: numeric('amount_precise', { precision: 20, scale: 10 }).default('0').notNull(),
    legacyBalanceAfter: numeric('balance_after', { precision: 12, scale: 4 })
      .default('0')
      .notNull(),
    balanceAfter: numeric('balance_after_precise', { precision: 20, scale: 10 })
      .default('0')
      .notNull(),
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
    // NOTE: several more indexes exist on this table than are declared here,
    // all created by hand-written migrations. Relevant to the admin credit-burn
    // dashboard: `idx_credit_ledger_created_at` (created_at), added by
    // migrations/20260807202731278_admin_analytics_ledger_time_index.concurrent.ts.
    // Every other time-ordered index leads with account_id and so cannot serve
    // a platform-wide time-range scan.
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
    projectId: uuid('project_id'),
    sessionId: text('session_id'),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type'),
    capability: tunnelCapabilityEnum('capability').notNull(),
    operation: varchar('operation', { length: 100 }).notNull(),
    requestSummary: jsonb('request_summary').default({}).$type<Record<string, unknown>>(),
    phase: varchar('phase', { length: 24 }).default('completed').notNull(),
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
// requests and connector/tunnel approvals are folded in by adapters in a later
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

/** Durable audit webhook queue. One row per webhook and canonical event. */
export const auditWebhookDeliveries = kortixSchema.table(
  'audit_webhook_deliveries',
  {
    deliveryId: uuid('delivery_id').defaultRandom().primaryKey(),
    webhookId: uuid('webhook_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: varchar('status', { length: 24 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'audit_delivery_webhook_fk',
      columns: [table.webhookId],
      foreignColumns: [auditWebhooks.webhookId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'audit_delivery_event_fk',
      columns: [table.eventId],
      foreignColumns: [auditEvents.eventId],
    }).onDelete('cascade'),
    uniqueIndex('idx_audit_webhook_delivery_event').on(table.webhookId, table.eventId),
    index('idx_audit_webhook_delivery_due').on(
      table.status,
      table.nextAttemptAt,
      table.lockedUntil,
    ),
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
    /** When true, the unified auth flow refuses password/email-code logins for
     *  this provider's primaryDomain — /access/check-email answers mode='sso'
     *  and the web auth actions turn the request away, so the IdP is the only
     *  door. Off by default: pre-SSO password accounts keep working until the
     *  org explicitly flips enforcement. */
    enforceSso: boolean('enforce_sso').default(false).notNull(),
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

/* ─── Connector (connectors) ───────────────────────────────────────────────
 * One unified connector layer the agent reaches via the Connector (CLI/MCP/SDK).
 * Physical table, enum, index, constraint, and connection-column identifiers
 * use the same connector and connection terms as the public product surface.
 * Connectors are DEFINED in kortix.yaml (`connectors`) and materialized here
 * on push (manifest = config source of truth, like triggers). Credentials are
 * project_secrets (scope handled by sharing above); the Pipedream connection
 * binding is also a project secret. See docs/specs/connector.md.
 */
export const connectorProviderEnum = kortixSchema.enum('connector_provider', [
  'pipedream',
  'mcp',
  'openapi',
  'postman',
  'graphql',
  'http',
  // Chat platforms (Slack, later Telegram/Teams) as first-class connectors. The
  // catalog is a fixed per-platform action set; the credential is the platform's
  // existing install token (resolved server-side, no connector_credential row).
  'channel',
  // Connected machines reached over the Agent Computer Tunnel. Each machine is
  // one auto-materialized connector bound to its tunnel id. Its catalog is the
  // tunnel RPC method set, and it has no credential — the live WS relay IS the
  // credential, with per-machine auth/scope enforced by the tunnel permission
  // layer. See docs/specs/computer-connector.md.
  'computer',
]);

export const connectorStatusEnum = kortixSchema.enum('connector_status', [
  'active',
  'disabled',
  'needs_auth',
  'error',
]);

export const connectorPolicyActionEnum = kortixSchema.enum('connector_policy_action', [
  'always_run',
  'require_approval',
  'block',
]);

export const connectorRiskEnum = kortixSchema.enum('connector_risk', [
  'read',
  'write',
  'destructive',
]);

export const connectorCallStatusEnum = kortixSchema.enum('connector_call_status', [
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
 * `per_user` row to `shared`, deleted the per-member `connection_credentials`
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
export const connectorCredentialModeEnum = kortixSchema.enum('connector_credential_mode', [
  'shared',
  'per_user',
]);

export const connectorAuthorizationStrategyEnum = kortixSchema.enum(
  'connector_authorization_strategy',
  ['project', 'user'],
);

export const connectors = kortixSchema.table(
  'connectors',
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
    providerType: connectorProviderEnum('provider_type').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    /** Provider-specific config: app/account | url/transport | endpoint | base_url | spec | auth. */
    config: jsonb('config').default({}).$type<Record<string, unknown>>().notNull(),
    /** Legacy reference to a project_secrets row (kept; credentials now in connection_credentials). */
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
     *  anymore (kept, like `per_user` on connectorCredentialModeEnum, because
     *  Postgres can't cleanly drop a column's meaning without a bigger change). */
    agentScope: text('agent_scope').array(),
    /** Credential storage model. `shared` only — see connectorCredentialModeEnum
     *  doc comment for why `per_user` is gone but the enum literal lingers. A
     *  DB CHECK constraint (added by the removal migration) enforces `shared`. */
    credentialMode: connectorCredentialModeEnum('credential_mode').default('shared').notNull(),
    /** Exclusive authorization owner model for this connector. */
    authorizationStrategy: connectorAuthorizationStrategyEnum('authorization_strategy')
      .default('project')
      .notNull(),
    /** Hash over config+auth — skip catalog re-sync when unchanged. */
    manifestHash: varchar('manifest_hash', { length: 64 }),
    status: connectorStatusEnum('status').default('active').notNull(),
    lastError: text('last_error'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_connectors_project').on(table.projectId),
    index('idx_connectors_account').on(table.accountId),
    uniqueIndex('idx_connectors_project_slug').on(table.projectId, table.slug),
    uniqueIndex('idx_connectors_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.connectorId,
    ),
    uniqueIndex('idx_connectors_tenant_alias').on(
      table.accountId,
      table.projectId,
      table.connectorId,
      table.slug,
    ),
  ],
);

export const connectorConnectionOwnerTypeEnum = kortixSchema.enum(
  'connector_connection_owner_type',
  ['project', 'agent', 'member', 'subject', 'external'],
);

export const connectorConnectionStatusEnum = kortixSchema.enum('connector_connection_status', [
  'active',
  'revoked',
  'error',
]);

/** A concrete server-side identity behind one logical connector definition. */
export const connectorConnections = kortixSchema.table(
  'connector_connections',
  {
    connectionId: uuid('connection_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    ownerType: connectorConnectionOwnerTypeEnum('owner_type').default('project').notNull(),
    ownerId: text('owner_id'),
    label: varchar('label', { length: 255 }).notNull(),
    status: connectorConnectionStatusEnum('status').default('active').notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId],
      foreignColumns: [connectors.accountId, connectors.projectId, connectors.connectorId],
      name: 'connector_connections_connector_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_connector_connections_tenant_identity').on(
      table.accountId,
      table.projectId,
      table.connectorId,
      table.connectionId,
    ),
    uniqueIndex('idx_connector_connections_connector_identity').on(
      table.connectorId,
      table.connectionId,
    ),
    // A connector may hold MANY connections (e.g. support@ and sales@ for the
    // project, plus each member's own). The default marker is therefore scoped PER
    // OWNER, not per connector: exactly one project default, and at most one default
    // per member/agent/external owner. Split into two partial indexes so the
    // project case (owner_id IS NULL, where SQL NULLs would compare distinct)
    // is still capped at one.
    uniqueIndex('idx_connector_connections_default_project')
      .on(table.connectorId)
      .where(sql`${table.isDefault} = true and ${table.ownerType} = 'project'`),
    uniqueIndex('idx_connector_connections_default_owner')
      .on(table.connectorId, table.ownerType, table.ownerId)
      .where(sql`${table.isDefault} = true and ${table.ownerId} is not null`),
    // Identity is (connector, owner, LABEL) — the label is the discriminator that
    // lets one owner hold several connections ("Work", "Personal") while keeping
    // reconcile idempotent: the same label updates in place, a new label adds a
    // new connection.
    uniqueIndex('idx_connector_connections_owner_label')
      .on(table.connectorId, table.ownerType, table.ownerId, table.label)
      .where(sql`${table.ownerId} is not null`),
    // Project-owned rows carry owner_id NULL, so the index above (partial on
    // owner_id IS NOT NULL) can't dedupe them. Several project connections per
    // connector are allowed, distinguished by label — this keeps that set unique.
    uniqueIndex('idx_connector_connections_project_label')
      .on(table.connectorId, table.label)
      .where(sql`${table.ownerId} is null`),
    index('idx_connector_connections_project').on(table.projectId),
    index('idx_connector_connections_connector').on(table.connectorId),
    check(
      'connector_connections_owner_check',
      sql`(${table.ownerType} = 'project' AND ${table.ownerId} IS NULL) OR (${table.ownerType} <> 'project' AND ${table.ownerId} IS NOT NULL AND btrim(${table.ownerId}) <> '')`,
    ),
    check(
      'connector_connections_metadata_check',
      sql`jsonb_typeof(${table.metadata}) = 'object' AND octet_length(${table.metadata}::text) <= 16384`,
    ),
  ],
);

export const projectSessionConnectorBindingSourceEnum = kortixSchema.enum(
  'project_session_connector_binding_source',
  ['request', 'default'],
);

/** Durable alias -> concrete connection selection for one project session. */
export const projectSessionConnectorBindings = kortixSchema.table(
  'project_session_connector_bindings',
  {
    sessionId: text('session_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectorAlias: varchar('connector_alias', { length: 128 }).notNull(),
    connectorId: uuid('connector_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
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
        connectors.accountId,
        connectors.projectId,
        connectors.connectorId,
        connectors.slug,
      ],
      name: 'project_session_connector_bindings_alias_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId, table.connectionId],
      foreignColumns: [
        connectorConnections.accountId,
        connectorConnections.projectId,
        connectorConnections.connectorId,
        connectorConnections.connectionId,
      ],
      name: 'project_session_connector_bindings_connection_tenant_fk',
    }).onDelete('restrict'),
    index('idx_project_session_connector_bindings_connection').on(table.connectionId),
    index('idx_project_session_connector_bindings_project').on(table.projectId),
  ],
);

/** ORPHANED 2026-07-06 — the per-connector member/department "who can access"
 *  allow-list was retired (connectors are project-wide now); the retirement
 *  migration deleted every row and nothing in the app writes to this table
 *  anymore. Kept (empty) rather than dropped — see the shareScope/agentScope
 *  comments on connectors. */
export const connectorGrants = kortixSchema.table(
  'connector_grants',
  {
    grantId: uuid('grant_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.connectorId, { onDelete: 'cascade' }),
    principalType: secretGrantPrincipalEnum('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_connector_grants_connector').on(table.connectorId),
    uniqueIndex('idx_connector_grants_unique').on(
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
export const connectionCredentials = kortixSchema.table(
  'connection_credentials',
  {
    credentialId: uuid('credential_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.connectorId, { onDelete: 'cascade' }),
    /** Connection identity. Nullable only during legacy dual-read rollout. */
    connectionId: uuid('connection_id'),
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
    index('idx_connection_credentials_connector').on(table.connectorId),
    index('idx_connection_credentials_connection').on(table.connectionId),
    uniqueIndex('idx_connection_credentials_connection_unique')
      .on(table.connectionId)
      .where(sql`${table.connectionId} is not null`),
    foreignKey({
      columns: [table.connectorId, table.connectionId],
      foreignColumns: [connectorConnections.connectorId, connectorConnections.connectionId],
      name: 'connection_credentials_connector_connection_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_connection_credentials_legacy_connector_unique')
      .on(table.connectorId)
      .where(sql`${table.connectionId} is null`),
  ],
);

/** Encrypted provider-independent OAuth2 application configuration per connection. */
export const connectionOAuthApplications = kortixSchema.table(
  'connection_oauth_applications',
  {
    applicationId: uuid('application_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectorId: uuid('connector_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    configEnc: text('config_enc').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.projectId, table.connectorId, table.connectionId],
      foreignColumns: [
        connectorConnections.accountId,
        connectorConnections.projectId,
        connectorConnections.connectorId,
        connectorConnections.connectionId,
      ],
      name: 'connection_oauth_applications_connection_tenant_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_connection_oauth_applications_connection').on(table.connectionId),
    index('idx_connection_oauth_applications_project').on(table.projectId),
  ],
);

/**
 * Short-lived Authorization Code or Device Authorization transaction.
 * State is hashed. PKCE verifiers and device codes are encrypted.
 */
export const connectionOAuthSessions = kortixSchema.table(
  'connection_oauth_sessions',
  {
    sessionId: uuid('session_id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id').notNull(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    initiatedBy: uuid('initiated_by').notNull(),
    flow: varchar('flow', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    stateHash: varchar('state_hash', { length: 64 }),
    pkceVerifierEnc: text('pkce_verifier_enc'),
    deviceCodeEnc: text('device_code_enc'),
    successRedirectUri: text('success_redirect_uri'),
    errorRedirectUri: text('error_redirect_uri'),
    scopes: text('scopes').array(),
    intervalSeconds: integer('interval_seconds'),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.applicationId],
      foreignColumns: [connectionOAuthApplications.applicationId],
      name: 'connection_oauth_sessions_application_fk',
    }).onDelete('cascade'),
    uniqueIndex('idx_connection_oauth_sessions_state_hash')
      .on(table.stateHash)
      .where(sql`${table.stateHash} is not null`),
    index('idx_connection_oauth_sessions_connection').on(table.connectionId),
    index('idx_connection_oauth_sessions_expires').on(table.expiresAt),
    check(
      'connection_oauth_sessions_flow_check',
      sql`${table.flow} IN ('authorization_code', 'device_authorization')`,
    ),
    check(
      'connection_oauth_sessions_status_check',
      sql`${table.status} IN ('pending', 'active', 'consumed', 'error', 'expired')`,
    ),
    check(
      'connection_oauth_sessions_material_check',
      sql`(${table.flow} = 'authorization_code' AND ${table.stateHash} IS NOT NULL AND ${table.pkceVerifierEnc} IS NOT NULL AND ${table.deviceCodeEnc} IS NULL) OR (${table.flow} = 'device_authorization' AND ${table.stateHash} IS NULL AND ${table.pkceVerifierEnc} IS NULL AND ${table.deviceCodeEnc} IS NOT NULL)`,
    ),
  ],
);

export const connectorActions = kortixSchema.table(
  'connector_actions',
  {
    actionId: uuid('action_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.connectorId, { onDelete: 'cascade' }),
    /** Connector-namespaced tool path, e.g. "stripe.charges.create". */
    path: varchar('path', { length: 512 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown> | null>(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
    risk: connectorRiskEnum('risk').default('read').notNull(),
    /** Provider invocation metadata (method+path, operationId, field, mcp tool name…). */
    binding: jsonb('binding').default({}).$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_connector_actions_connector').on(table.connectorId),
    uniqueIndex('idx_connector_actions_path').on(table.connectorId, table.path),
  ],
);

/** Connector-scoped tool-call policies, materialized from [[connectors.policies]]. */
/**
 * One ARGUMENT condition on a tool-call policy.
 *
 * A `match` pattern can only gate a tool NAME ("may the agent call
 * `gmail.send_email`"). It cannot gate the call's target ("…but only to these
 * addresses"), which is what a real guardrail needs to express. A policy row
 * carrying `conditions` applies only when its tool pattern matches AND every
 * condition holds.
 *
 * `arg` is a dot path into the call arguments; `match` uses the same
 * glob-or-`/regex/` grammar as the tool pattern. Semantics (including how an
 * unevaluable condition fails closed) live in apps/api/src/connectors/policy.ts —
 * this is only the stored shape.
 */
export interface ConnectorPolicyCondition {
  arg: string;
  match: string;
  negate?: boolean;
}

export const connectorPolicies = kortixSchema.table(
  'connector_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.connectorId, { onDelete: 'cascade' }),
    /** Glob over the connector's tool paths. */
    match: varchar('match', { length: 512 }).notNull(),
    action: connectorPolicyActionEnum('action').notNull(),
    /** Authoring order — evaluated top-to-bottom, first match wins. */
    position: integer('position').default(0).notNull(),
    /** Optional ARGUMENT conditions — see `connectorPolicyConditions`. */
    conditions: jsonb('conditions').$type<ConnectorPolicyCondition[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_connector_policies_connector').on(table.connectorId)],
);

/**
 * Legacy authorization-policy storage.
 *
 * The runtime does not read or write this table. Connector policies
 * live in connector_policies. Keep this table until a later contract
 * migration removes the stored rows and physical schema.
 */
export const connectionPolicies = kortixSchema.table(
  'connection_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    connectionId: uuid('connection_id').notNull(),
    /** Connector-relative glob, same grammar as the connector-scoped rules. */
    match: varchar('match', { length: 512 }).notNull(),
    action: connectorPolicyActionEnum('action').notNull(),
    /** Authoring order — evaluated top-to-bottom, first match wins. */
    position: integer('position').default(0).notNull(),
    /** Optional ARGUMENT conditions — see `connectorPolicyConditions`. */
    conditions: jsonb('conditions').$type<ConnectorPolicyCondition[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_connection_policies_connection').on(table.connectionId),
    // Named explicitly: the derived name would exceed Postgres's 63-char
    // identifier limit and be silently truncated.
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connectorConnections.connectionId],
      name: 'connection_policies_connection_id_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Project-scoped tool-call policies — materialized from top-level [[policies]]
 * in kortix.yaml. Patterns are fully-qualified (`<slug>.<path>` globs) and apply
 * across ALL connectors in the project; evaluated BEFORE any connector-scoped
 * rule. See docs/specs/connector.md §8.
 */
export const connectorProjectPolicies = kortixSchema.table(
  'connector_project_policies',
  {
    policyId: uuid('policy_id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    /** Glob over fully-qualified tool paths (e.g. `stripe.charges.create`). */
    match: varchar('match', { length: 512 }).notNull(),
    action: connectorPolicyActionEnum('action').notNull(),
    /** Authoring order — evaluated top-to-bottom, first match wins. */
    position: integer('position').default(0).notNull(),
    /** Optional ARGUMENT conditions — see `connectorPolicyConditions`. */
    conditions: jsonb('conditions').$type<ConnectorPolicyCondition[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_connector_project_policies_project').on(table.projectId)],
);

export const connectorDefaultModeEnum = kortixSchema.enum('connector_default_mode', [
  'risk',
  'allow_all',
]);

/**
 * One row per project — non-policy connector settings (just `default_mode`
 * today). Materialized from `policy` in kortix.yaml; missing block = allow_all
 * for back-compat with existing projects.
 */
export const connectorProjectSettings = kortixSchema.table('connector_project_settings', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.projectId, { onDelete: 'cascade' }),
  defaultMode: connectorDefaultModeEnum('default_mode').default('allow_all').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Audit + approval ledger for every connector call. */
export const connectorCalls = kortixSchema.table(
  'connector_calls',
  {
    executionId: uuid('execution_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.accountId, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.projectId, { onDelete: 'cascade' }),
    connectorId: uuid('connector_id').references(() => connectors.connectorId, {
      onDelete: 'set null',
    }),
    connectionId: uuid('connection_id').references(() => connectorConnections.connectionId, {
      onDelete: 'set null',
    }),
    actionPath: varchar('action_path', { length: 512 }).notNull(),
    /** Who: the acting user (the connector token's principal). */
    actingUserId: uuid('acting_user_id'),
    sessionId: uuid('session_id'),
    status: connectorCallStatusEnum('status').notNull(),
    risk: connectorRiskEnum('risk'),
    /** Hash of the inputs (never raw secrets). */
    requestDigest: varchar('request_digest', { length: 64 }),
    /** Redacted result summary / error. */
    resultSummary: jsonb('result_summary').$type<Record<string, unknown> | null>(),
    approvedBy: uuid('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_connector_calls_project').on(table.projectId),
    index('idx_connector_calls_project_session_created').on(
      table.projectId,
      table.sessionId,
      table.createdAt.desc(),
    ),
    index('idx_connector_calls_connector').on(table.connectorId),
    index('idx_connector_calls_connection').on(table.connectionId),
    index('idx_connector_calls_status').on(table.status),
  ],
);

/**
 * Private, short-lived files staged for one Connector email call.
 *
 * The sandbox receives only `attachment_id`. Raw bytes remain in private
 * object storage. Ownership fields are checked again when the email gateway
 * claims the row, after any approval wait and immediately before provider
 * execution. `claim_token` makes provider ingestion single-flight. Successful
 * calls mark rows consumed before the signed-URL grace window and object
 * deletion, so retries cannot replay an attachment while AgentMail completes
 * provider-side ingestion. Account/project ids intentionally are not foreign
 * keys: deleting either owner must not cascade away the only object-storage
 * key before the expiry sweeper can remove the private blob.
 */
export const connectorAttachments = kortixSchema.table(
  'connector_attachments',
  {
    attachmentId: uuid('attachment_id').defaultRandom().primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sessionId: text('session_id'),
    userId: uuid('user_id').notNull(),
    objectPath: text('object_path').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    contentDisposition: varchar('content_disposition', { length: 16 })
      .default('attachment')
      .notNull(),
    contentId: text('content_id'),
    sizeBytes: integer('size_bytes').notNull(),
    status: varchar('status', { length: 16 }).default('uploaded').notNull(),
    claimToken: uuid('claim_token'),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'connector_attachments_disposition_check',
      sql`${table.contentDisposition} IN ('attachment', 'inline')`,
    ),
    check(
      'connector_attachments_status_check',
      sql`${table.status} IN ('uploaded', 'claimed', 'consumed')`,
    ),
    check('connector_attachments_size_check', sql`${table.sizeBytes} > 0`),
    index('idx_connector_attachments_scope').on(table.projectId, table.sessionId, table.userId),
    index('idx_connector_attachments_expiry').on(table.expiresAt),
  ],
);

/**
 * "Allow for this session" decisions on `require_approval` connector calls. When
 * a human approves a gated action and picks "allow for the rest of this
 * session", (session, connector, action) is recorded here; the connector gateway
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
      .references(() => connectors.connectorId, { onDelete: 'cascade' }),
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

export const connectorsRelations = relations(connectors, ({ one, many }) => ({
  project: one(projects, {
    fields: [connectors.projectId],
    references: [projects.projectId],
  }),
  actions: many(connectorActions),
  policies: many(connectorPolicies),
}));

export const connectorActionsRelations = relations(connectorActions, ({ one }) => ({
  connector: one(connectors, {
    fields: [connectorActions.connectorId],
    references: [connectors.connectorId],
  }),
}));

export const connectorPoliciesRelations = relations(connectorPolicies, ({ one }) => ({
  connector: one(connectors, {
    fields: [connectorPolicies.connectorId],
    references: [connectors.connectorId],
  }),
}));

export const connectorProjectPoliciesRelations = relations(connectorProjectPolicies, ({ one }) => ({
  project: one(projects, {
    fields: [connectorProjectPolicies.projectId],
    references: [projects.projectId],
  }),
}));

export const connectorProjectSettingsRelations = relations(connectorProjectSettings, ({ one }) => ({
  project: one(projects, {
    fields: [connectorProjectSettings.projectId],
    references: [projects.projectId],
  }),
}));
