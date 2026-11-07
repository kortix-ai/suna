/**
 * Project transfer — move a project (and everything it owns) to another
 * account. KRTX-1747.
 *
 * The permission gates live in the route (`routes/project-settings.ts`, the
 * same convention as deletion): the caller must hold the destructive tier on
 * the SOURCE project (`project.delete`) and `project.create` on the TARGET
 * account — which `authorize()` denies outright for a non-member. This module
 * is the data movement and its own guards only.
 *
 * Which rows follow the project: every table that copies the owning account's
 * id next to the project id is either MOVED (the row belongs to the project —
 * reads like `session-costs` join `project_sessions.account_id` directly, so
 * a stale copy hides the project's own history inside its new account) or
 * LEFT with a reason in {@link PROJECT_TRANSFER_LEAVE_TABLES} (ledgers and
 * user-facing history belong to the account that lived them). The
 * completeness test in `project-transfer.integration.test.ts` fails when a
 * schema table carrying both columns is in neither list, so a future table
 * cannot be silently forgotten here. App hosting rows that carry only
 * `account_id` follow by `app_id` ({@link PROJECT_TRANSFER_APP_TABLES}).
 *
 * The workspace split (Workspaces design.md §2) reuses this engine in split
 * mode (`workspace-split-copy.ts`): the target is a fresh account holding a
 * copy of the source directory, so grants are remapped instead of dropped.
 */
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { artifacts, projectGoals, sessionSandboxIdentities, projectSessionGroups, projectSpaces, rooms, sessionIdleWatches, accountModelPreferences, accountSecretResources, accountSecretGrants, accountTokens, appArtifacts, apps, changeRequests, connectorAttachments, connectorCalls, connectorHeldCalls, connectorConnections, connectionOAuthApplications, connectionOAuthSessions, connectors, drives, gatewayApiKeys, projectAccessRequests, projectGitConnections, projectGitCredentials, projectMonitorBoxes, projectSessionConnectorBindings, projectSessionPublicShares, projectSessions, projectSnapshotBuilds, projectTriggerEventSubscriptions, projectTriggerEventPolls, iamRoles, promptAttachments, providerTransitions, reviewItems, roleAssignments, sandboxTemplates, serviceAccounts, sessionContentPurges, sessionLifecycleCommands, sessionLogs, sessionPendingPermissions, sessionPendingQuestions, sessionRuntimeProjections, sessionSandboxes, sessionTurns } from '@kortix/db';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { workspaceHasProjectDenial } from '../../workspaces/surface';
import { blobKey, supabaseSiteStorage, type SiteStorage } from '../../apps/static-site';
import { mapWithConcurrency } from '../../shared/map-with-concurrency';
import { accountsView, moveProjectRowAccount, projectsView } from '../../workspaces/rows';

/**
 * Tables the transfer UPDATES (`account_id` → the target account) for the
 * moved project's rows, after the project row itself
 * (`moveProjectRowAccount`, the workspaces store). Rows whose `project_id`
 * is NULL (account-scoped secrets, templates, personal drives, manual service
 * accounts, unbound tokens) never match the `project_id = :projectId`
 * predicate and stay put.
 */
export const PROJECT_TRANSFER_TABLES: readonly PgTable[] = [
  projectSessions,
  projectGitConnections,
  projectGitCredentials,
  projectAccessRequests,
  accountSecretResources,
  accountModelPreferences,
  projectSessionPublicShares,
  projectTriggerEventSubscriptions,
  projectTriggerEventPolls,
  projectMonitorBoxes,
  projectSessionGroups,
  projectSpaces,
  // Retired with Rooms (2026-11): no code reads them; they move until
  // packages/db/migrations-pending/*_drop_rooms.sql.pending drops them.
  rooms,
  sessionIdleWatches,
  sessionLifecycleCommands,
  // Move receipts before the sandbox UPDATE trigger captures its destination identity.
  sessionSandboxIdentities,
  sessionSandboxes,
  sessionTurns,
  sessionLogs,
  sessionContentPurges,
  sessionRuntimeProjections,
  sessionPendingQuestions,
  // A parked tool call waits in its session; a person of the project decides it.
  sessionPendingPermissions,
  sandboxTemplates,
  projectSnapshotBuilds,
  providerTransitions,
  accountTokens,
  gatewayApiKeys,
  apps,
  appArtifacts,
  changeRequests,
  reviewItems,
  serviceAccounts,
  connectors,
  connectorConnections,
  projectSessionConnectorBindings,
  connectionOAuthApplications,
  connectionOAuthSessions,
  connectorCalls,
  connectorHeldCalls,
  promptAttachments,
  connectorAttachments,
  drives,
  // An artifact is a path in the project drive: it moves with the drive.
  artifacts,
  // A goal belongs to the project (its folder is in the project drive). Its
  // event log carries project_id only and needs no move.
  projectGoals,
];

/**
 * Tables carrying both columns that the transfer deliberately leaves with the
 * SOURCE account, keyed by their SQL name with the reason. Kept in step with
 * {@link PROJECT_TRANSFER_TABLES} by the classification test.
 */
export const PROJECT_TRANSFER_LEAVE_TABLES: Readonly<Record<string, string>> = {
  // Financial / request ledgers: the record of what the SOURCE account
  // consumed while the project lived there. Re-pointing them would rewrite
  // billing attribution. New rows after the transfer attribute to the target
  // naturally (writes resolve the account from the project).
  usage_events:
    'billing ledger — spend stays with the account that consumed it',
  gateway_request_logs:
    'request log ledger — history stays with the account that paid for it',
  storage_charges:
    'storage billing ledger — a day already charged stays with the account that paid; later days attribute to the new owner',
  // Immutable audit evidence: the audit_events table's own comment says
  // account deletion must not rewrite forensic history; a transfer follows
  // the same rule for both audit tables.
  audit_events: 'forensic audit history — events stay where they happened',
  tunnel_audit_logs: 'audit evidence stays where the action happened',
  // A derived rollup of audit_events (worker/jobs/audit-activity.ts): it
  // follows the events it sums, which stay with the source account.
  audit_activity_daily: 'derived audit rollup — recomputed from audit_events, which stay where they happened',
  // Transient device-pairing requests; they expire on their own and the
  // approver's project access is re-checked at approval time.
  tunnel_device_auth_requests: 'transient pending device auth, self-expiring',
  // A Claude sign-in lives 10 minutes (FLOW_TTL_MS), and its pasted code is
  // sealed with the source account's key, so a moved row could not be read.
  claude_subscription_login_flows: 'transient Claude sign-in, self-expiring, sealed with the source account key',
  // Per-user inbox items: what a user saw while the project lived in the
  // source account stays in the source account's view.
  notifications: 'user inbox history, not project-owned data',
  // Completed one-off migration runs — operations history, not live state.
  legacy_sandbox_migrations: 'completed ops migration run record',
  suna_account_migrations: 'completed ops migration run record',
};

/**
 * App hosting rows that carry `account_id` but no `project_id`. They follow the
 * project through their App: `app_volumes.app_id`, and `app_deployments.app_id`
 * for `app_site_files` and `app_runtimes`. Left behind, a moved static App
 * reads its files under the old account's blob prefix and the old account keeps
 * paying its compute (faq.md "split" item 2). `app_site_blobs` is keyed
 * `(account_id, sha256)` and shared by every App of the account, so the
 * transfer COPIES the moved Apps' blob rows and objects to the target and
 * leaves the source rows to `reclaimAppSiteBlobs`.
 */
export const PROJECT_TRANSFER_APP_TABLES: Readonly<Record<string, string>> = {
  app_site_files: 'moved by app_deployments.app_id → apps.project_id',
  app_runtimes: 'moved by app_deployments.app_id → apps.project_id',
  app_volumes: 'moved by app_id → apps.project_id',
  app_site_blobs: 'copied for the moved Apps\' sha256 set; source rows stay for reclaimAppSiteBlobs',
  oauth_clients: 'the implicit client of each moved App (oauth_clients.app_id), so the source never lists or deletes it',
  oauth_authorization_codes: 'the codes of those clients',
  oauth_access_tokens: 'the viewer tokens of those clients',
};

/**
 * Moved tables with no index leading on `project_id` but an index on a NOT
 * NULL session column (checked 2026-11-05: `session_logs`, `session_turns`
 * are large). Every row's session belongs to the row's project.
 */
const SESSION_KEYED_TRANSFER_TABLES: Readonly<Record<string, string>> = {
  session_turns: 'session_id',
  session_logs: 'session_id',
  session_content_purges: 'session_id',
  session_pending_questions: 'session_id',
  session_idle_watches: 'target_session_id',
};

export type ProjectTransferErrorCode =
  | 'project_missing'
  | 'not_active'
  | 'same_account'
  | 'target_missing'
  | 'concurrent_move'
  | 'workspace_has_project';

export class ProjectTransferError extends Error {
  constructor(
    readonly code: ProjectTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTransferError';
  }
}

export interface TransferProjectOwnershipInput {
  projectId: string;
  /** The account the caller saw the project in — re-verified under the row
   *  lock, so a concurrent transfer is detected instead of double-applied. */
  fromAccountId: string;
  toAccountId: string;
}

export type TransferTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The directory copy a workspace split made in the fresh target account
 * (`workspace-split-copy.ts`): source group id → copy, source custom role id →
 * copy. With it, the transfer REMAPS the project's group, custom-role and
 * pending grants and keeps its secrets' member grants, instead of dropping
 * them: every source member, group and custom role exists in the target.
 */
export interface SplitDirectoryMap {
  groups: Readonly<Record<string, string>>;
  roles: Readonly<Record<string, string>>;
}

export interface TransferProjectOwnershipOptions {
  /** Set only by the workspace split: the target is a fresh account holding a
   *  copy of the source directory. Skips the target project-limit check (a
   *  split target is a new Free account). */
  split?: SplitDirectoryMap;
  /** Where static App blobs live. Default: the `app-sites` bucket. */
  siteStorage?: SiteStorage;
}

/** The distinct blobs (hash, content type) the project's static App deployments name. */
export async function projectSiteBlobs(projectId: string, accountId: string): Promise<{ sha256: string; contentType: string }[]> {
  const rows = await db.execute<{ sha256: string; content_type: string }>(sql`
    SELECT f.sha256, min(f.content_type) AS content_type FROM kortix.app_site_files f
      JOIN kortix.app_deployments d ON d.deployment_id = f.deployment_id
      JOIN kortix.apps a ON a.app_id = d.app_id
     WHERE a.project_id = ${projectId} AND f.account_id = ${accountId}
     GROUP BY f.sha256 ORDER BY f.sha256`);
  return rows.map((row) => ({ sha256: row.sha256, contentType: row.content_type }));
}

/**
 * Copy the project's static App blobs from `<from>/<sha>` to `<to>/<sha>` in
 * site storage. Runs BEFORE the transfer transaction (object storage is not
 * transactional): a copy is idempotent (upsert), and the source object stays
 * for the source account's other Apps and for a rollback. Returns the copied
 * hashes; a hash storage no longer has is skipped and counted.
 */
export async function copyProjectSiteBlobs(
  input: { projectId: string; fromAccountId: string; toAccountId: string },
  storage: SiteStorage = supabaseSiteStorage,
): Promise<{ copied: string[]; missing: string[] }> {
  const blobs = await projectSiteBlobs(input.projectId, input.fromAccountId);
  const missing = new Set<string>();
  await mapWithConcurrency(blobs, 4, async ({ sha256, contentType }) => {
    const body = await storage.open(blobKey(input.fromAccountId, sha256));
    if (!body) {
      missing.add(sha256);
      return;
    }
    await storage.put(blobKey(input.toAccountId, sha256), await new Response(body).blob(), contentType);
  });
  return { copied: blobs.map((b) => b.sha256).filter((sha) => !missing.has(sha)), missing: [...missing] };
}

const jsonMap = (map: Readonly<Record<string, string>>) => JSON.stringify(map);

/**
 * Move `projectId` from `fromAccountId` to `toAccountId` in ONE transaction.
 *
 * Owned rows are re-pointed, preserving ids and timestamps. Account-salted
 * secrets are re-encrypted. App hosting rows follow by `app_id`, and the
 * Apps' site blobs are copied to the target prefix first.
 *
 * A plain transfer (into an existing account): source member grants on the
 * project's secrets are revoked; project-scoped system role assignments follow
 * the project; pending, custom-role and group grants are removed: a group is a
 * directory object of the source account and its grant cannot be re-resolved
 * inside the target (and keeping the row would hand the source group's members
 * access through the target's assignment).
 *
 * A split transfer (`options.split`, the target holds a copy of the source
 * directory): every grant is kept and remapped to the copies.
 */
export async function transferProjectOwnership(
  input: TransferProjectOwnershipInput,
  options: TransferProjectOwnershipOptions = {},
): Promise<{ projectId: string; accountId: string }> {
  if (input.fromAccountId === input.toAccountId) {
    throw new ProjectTransferError('same_account', 'Project is already in that account');
  }
  await copyProjectSiteBlobs(input, options.siteStorage);
  const moved = await db.transaction((tx) => moveProjectInTransaction(tx, input, options));
  await afterProjectMoved(input);
  return { projectId: moved.projectId, accountId: moved.accountId };
}

/**
 * After a move committed: the caches keyed by the project's old account. The
 * project-scoped IAM bust (the workspace → account memo, the object grants)
 * crosses replicas over LISTEN/NOTIFY; the default-model cache is
 * process-local with a 30 s TTL. Best effort: a failed bust leaves the TTLs.
 */
export async function afterProjectMoved(input: { projectId: string; fromAccountId: string; toAccountId: string }): Promise<void> {
  try {
    const { invalidateIamCacheForProjectResources } = await import('../../iam/cache-invalidation');
    const { invalidateAccountModelDefaults } = await import('../../llm-gateway/resolution/default-model');
    invalidateIamCacheForProjectResources(input.projectId);
    invalidateAccountModelDefaults(input.fromAccountId);
    invalidateAccountModelDefaults(input.toAccountId);
  } catch (error) {
    logger.warn('[project-transfer] cache bust after the move failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The transfer's data movement inside the caller's transaction. The workspace
 * split calls it after copying the directory in the same transaction; copy the
 * site blobs first ({@link copyProjectSiteBlobs}).
 */
export async function moveProjectInTransaction(
  tx: TransferTx,
  input: TransferProjectOwnershipInput,
  options: Pick<TransferProjectOwnershipOptions, 'split'> = {},
): Promise<{ projectId: string; accountId: string; undecryptableSecrets: string[] }> {
  const { projectId, fromAccountId, toAccountId } = input;
  const split = options.split;
  if (fromAccountId === toAccountId) {
    throw new ProjectTransferError('same_account', 'Project is already in that account');
  }
  // Lock the row: the CAS against a concurrent move happens under this lock.
  const [row] = await tx.select({ account_id: projectsView.accountId, status: projectsView.status })
    .from(projectsView).where(eq(projectsView.projectId, projectId)).for('update');
  if (!row) throw new ProjectTransferError('project_missing', 'Project not found');
  if (row.status !== 'active') {
    throw new ProjectTransferError('not_active', 'Archived projects cannot be transferred');
  }
  if (row.account_id === toAccountId) {
    // The caller's loaded row was already stale — the project moved first.
    throw new ProjectTransferError('concurrent_move', 'Project was already transferred');
  }
  if (row.account_id !== fromAccountId) {
    throw new ProjectTransferError('concurrent_move', 'Project moved while the transfer was prepared');
  }

  const [target] = await tx.select({ accountId: accountsView.accountId }).from(accountsView)
    .where(eq(accountsView.accountId, toAccountId)).for('update');
  if (!target) throw new ProjectTransferError('target_missing', 'Target account not found');

  // One workspace = one project: a plain transfer lands only in an account
  // with no active project (the create gate's own check; the target row is
  // locked above). The unique index uq_projects_workspace_account backstops
  // a create that races past it. A split target is a fresh account.
  if (!split && (await workspaceHasProjectDenial(toAccountId))) {
    throw new ProjectTransferError('workspace_has_project', 'The target workspace already has its project');
  }


  if (!split) {
    // Source directory objects and invitation activation remain account-scoped.
    // Custom roles must not let source admins retain control after the move.
    await tx.execute(sql`DELETE FROM ${roleAssignments}
      WHERE account_id = ${fromAccountId} AND scope_type = 'project' AND scope_id = ${projectId}
        AND (principal_type IN ('group', 'pending') OR role_id IN (
          SELECT role_id FROM ${iamRoles} WHERE account_id = ${fromAccountId}
        ))`);
  }

  const { undecryptableSecrets } = await moveOwnedRows(tx, input, split);

  // `projects.split_pending` follows the account shape through the
  // projects_split_pending_sync trigger (design.md §3.1 row 27).

  logger.info('[project-transfer] project moved', {
    projectId,
    fromAccountId,
    toAccountId,
    split: Boolean(split),
  });
  return { projectId, accountId: toAccountId, undecryptableSecrets };
}

/**
 * Everything the project owns, from `fromAccountId` to `toAccountId`, inside
 * the caller's transaction: project secrets (re-sealed for the target), the
 * owned rows ({@link moveProjectRows}), and the project-scoped grants. In
 * split mode (`split`) the secrets' member grants are kept and group and
 * custom-role grants are remapped to the target's copies.
 *
 * Idempotent: every statement matches only what is still on the source. The
 * split's repair pass runs it again after the move for rows a request wrote
 * with the old account while the move committed.
 */
export async function moveOwnedRows(
  tx: TransferTx,
  input: { projectId: string; fromAccountId: string; toAccountId: string },
  split?: SplitDirectoryMap,
): Promise<{ rows: Record<string, number>; undecryptableSecrets: string[] }> {
  const { projectId, fromAccountId, toAccountId } = input;
  // Lock credentials before reading their envelopes: concurrent refreshes must
  // not overwrite a destination envelope with ciphertext salted by the source.
  const secrets = await tx.select().from(accountSecretResources)
    .where(sql`${accountSecretResources.projectId} = ${projectId} AND ${accountSecretResources.accountId} = ${fromAccountId}`)
    .for('update');
  const keptGrants: (typeof accountSecretGrants.$inferSelect)[] = [];
  const undecryptableSecrets: string[] = [];
  for (const secret of secrets) {
    // Grants reference (secret_id, account_id): delete before changing the
    // resource's composite FK identity. A plain transfer revokes them (member
    // grants belong to the source directory); a split re-adds them below,
    // since every source member is a member of the target.
    const deleted = await tx.delete(accountSecretGrants).where(eq(accountSecretGrants.secretId, secret.secretId)).returning();
    if (split) keptGrants.push(...deleted);
    let valueEnc: string;
    try {
      valueEnc = encryptAccountSecret(toAccountId, decryptAccountSecret(fromAccountId, secret.valueEnc));
    } catch (error) {
      // A plain transfer is one user action: it refuses and rolls back. A
      // split is a background run that must finish: an envelope that is
      // unusable in the source too (an old or wrong key) moves unchanged,
      // marked for a reconnect, and the run reports its id.
      if (!split) throw error;
      undecryptableSecrets.push(secret.secretId);
      await tx.update(accountSecretResources).set({ needsReauthAt: new Date() })
        .where(eq(accountSecretResources.secretId, secret.secretId));
      continue;
    }
    await tx.update(accountSecretResources).set({ valueEnc })
      .where(eq(accountSecretResources.secretId, secret.secretId));
  }

  const rows = await moveProjectRows(tx, input);

  if (keptGrants.length) {
    await tx.insert(accountSecretGrants).values(keptGrants.map((grant) => ({ ...grant, accountId: toAccountId })));
  }

  // Project-scoped grants follow the project; in a plain transfer, group
  // grants die with the source account's directory (see the doc comment).
  await tx.execute(
    sql`UPDATE ${roleAssignments} SET account_id = ${toAccountId}
         WHERE account_id = ${fromAccountId}
           AND scope_type = 'project' AND scope_id = ${projectId}
           AND principal_type IN ('user', 'service_account', 'project')
           AND role_id NOT IN (SELECT role_id FROM ${iamRoles} WHERE account_id = ${fromAccountId})`,
  );
  if (split) {
    // Every remaining project-scoped grant: groups and custom roles point at
    // their copies; a pending invitee keeps the grant its split invite carries.
    await tx.execute(sql`
      UPDATE ${roleAssignments} SET account_id = ${toAccountId},
        principal_id = CASE WHEN principal_type = 'group'
          THEN COALESCE((${jsonMap(split.groups)}::jsonb ->> principal_id::text)::uuid, principal_id)
          ELSE principal_id END,
        role_id = COALESCE((${jsonMap(split.roles)}::jsonb ->> role_id::text)::uuid, role_id),
        updated_at = now()
       WHERE account_id = ${fromAccountId} AND scope_type = 'project' AND scope_id = ${projectId}`);
  }
  return { rows, undecryptableSecrets };
}

/**
 * Re-point every row the project owns from `fromAccountId` to `toAccountId`:
 * the {@link PROJECT_TRANSFER_TABLES} by `project_id`, the project default
 * model (keyed by `scope_key`, its `project_id` is NULL), the App hosting rows
 * and the open compute rows. Idempotent: a second run matches only rows still
 * on the source. Returns the rows changed per table (0 entries omitted).
 *
 * The move calls it once; the split's repair pass calls it again 120 s after
 * the move committed for the rows a request that started before the move
 * wrote with the old account (design.md §3.1 row 32).
 */
export async function moveProjectRows(
  tx: TransferTx,
  input: { projectId: string; fromAccountId: string; toAccountId: string },
): Promise<Record<string, number>> {
  const { projectId, fromAccountId, toAccountId } = input;
  const changed: Record<string, number> = {};
  const count = (name: string, rows: unknown) => {
    const n = Number((rows as { count?: number } | null)?.count ?? (Array.isArray(rows) ? rows.length : 0));
    if (n > 0) changed[name] = (changed[name] ?? 0) + n;
  };
  // Both ends contain account_id. Defer only this graph's tenant checks;
  // ordinary connector writes retain immediate foreign-key enforcement.
  await tx.execute(sql`SET CONSTRAINTS
    kortix.connector_connections_connector_tenant_fk,
    kortix.project_session_connector_bindings_session_tenant_fk,
    kortix.project_session_connector_bindings_alias_tenant_fk,
    kortix.project_session_connector_bindings_connection_tenant_fk,
    kortix.connection_oauth_applications_connection_tenant_fk DEFERRED`);

  // The row that owns the move goes first.
  count('projects', { count: await moveProjectRowAccount(input, tx) });
  for (const table of PROJECT_TRANSFER_TABLES) {
    const sessionColumn = SESSION_KEYED_TRANSFER_TABLES[getTableName(table)];
    // A session-keyed table without a project_id index is reached through its
    // (NOT NULL, indexed) session column instead of a sequential scan.
    const bySession = sessionColumn
      ? sql` AND ${sql.identifier(sessionColumn)} IN (SELECT session_id FROM kortix.project_sessions WHERE project_id = ${projectId})`
      : sql``;
    count(getTableName(table), await tx.execute(
      sql`UPDATE ${table} SET account_id = ${toAccountId}
           WHERE project_id = ${projectId} AND account_id = ${fromAccountId}${bySession}`,
    ));
  }

  await tx.execute(sql`SET CONSTRAINTS
    kortix.connector_connections_connector_tenant_fk,
    kortix.project_session_connector_bindings_session_tenant_fk,
    kortix.project_session_connector_bindings_alias_tenant_fk,
    kortix.project_session_connector_bindings_connection_tenant_fk,
    kortix.connection_oauth_applications_connection_tenant_fk IMMEDIATE`);

  count('account_model_preferences', await moveProjectDefaultModel(tx, input));
  await moveAppHostingRows(tx, projectId, fromAccountId, toAccountId);
  await moveOpenComputeSessions(tx, projectId, fromAccountId, toAccountId);
  return changed;
}

/**
 * The project default model is `account_model_preferences(scope='project',
 * scope_key=<project_id>, project_id NULL)`: the table loop's `project_id`
 * predicate never matches it. A stale target row for the same project (an
 * earlier transfer or reverse left it) goes first, so the unique
 * (account_id, scope, scope_key) index takes the moved row.
 */
async function moveProjectDefaultModel(tx: TransferTx, input: { projectId: string; fromAccountId: string; toAccountId: string }) {
  const { projectId, fromAccountId, toAccountId } = input;
  const [source] = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM kortix.account_model_preferences
     WHERE account_id = ${fromAccountId} AND scope = 'project' AND scope_key = ${projectId} AND project_id IS NULL`);
  if (!source?.n) return [];
  await tx.execute(sql`DELETE FROM kortix.account_model_preferences
    WHERE account_id = ${toAccountId} AND scope = 'project' AND scope_key = ${projectId} AND project_id IS NULL`);
  return tx.execute(sql`UPDATE kortix.account_model_preferences SET account_id = ${toAccountId}, updated_at = now()
    WHERE account_id = ${fromAccountId} AND scope = 'project' AND scope_key = ${projectId} AND project_id IS NULL
    RETURNING scope_key`);
}

/**
 * Box metering rows that carry `account_id` but no `project_id`. Compute
 * metering settles each window against the row's own `account_id`
 * (`billing/services/compute-metering.ts`), and one box keeps one open row
 * for as long as it runs. Left behind, the source keeps paying a moved
 * always-on App runtime or monitor box with no end.
 */
export const PROJECT_TRANSFER_COMPUTE_TABLES: Readonly<Record<string, string>> = {
  sandbox_compute_sessions:
    'OPEN rows of the moved boxes (session sandboxes, App runtimes, monitor boxes) re-pointed; closed rows stay with the account that paid them',
};

/**
 * The open compute rows of the project's boxes follow the project
 * ({@link PROJECT_TRANSFER_COMPUTE_TABLES}). The window since the row's last
 * settle (at most one metering tick) bills the target; every settled window
 * stays on the source's ledger.
 */
async function moveOpenComputeSessions(tx: TransferTx, projectId: string, fromAccountId: string, toAccountId: string): Promise<void> {
  await tx.execute(sql`UPDATE kortix.sandbox_compute_sessions SET account_id = ${toAccountId}, updated_at = now()
    WHERE account_id = ${fromAccountId} AND ended_at IS NULL AND sandbox_id IN (
      SELECT sandbox_id FROM kortix.session_sandboxes WHERE project_id = ${projectId} AND sandbox_id IS NOT NULL
      UNION SELECT r.runtime_id FROM kortix.app_runtimes r
        JOIN kortix.app_deployments d ON d.deployment_id = r.deployment_id
        JOIN kortix.apps a ON a.app_id = d.app_id WHERE a.project_id = ${projectId}
      UNION SELECT box_id FROM kortix.project_monitor_boxes WHERE project_id = ${projectId})`);
}

/** App hosting rows follow the project by `app_id` ({@link PROJECT_TRANSFER_APP_TABLES}). */
async function moveAppHostingRows(tx: TransferTx, projectId: string, fromAccountId: string, toAccountId: string): Promise<void> {
  const deployments = sql`SELECT d.deployment_id FROM kortix.app_deployments d
    JOIN kortix.apps a ON a.app_id = d.app_id WHERE a.project_id = ${projectId}`;
  await tx.execute(sql`
    INSERT INTO kortix.app_site_blobs (account_id, sha256, size_bytes)
    SELECT DISTINCT ON (b.sha256) ${toAccountId}::uuid, b.sha256, b.size_bytes
      FROM kortix.app_site_blobs b
      JOIN kortix.app_site_files f ON f.account_id = b.account_id AND f.sha256 = b.sha256
     WHERE b.account_id = ${fromAccountId} AND f.deployment_id IN (${deployments})
    ON CONFLICT (account_id, sha256) DO NOTHING`);
  await tx.execute(sql`UPDATE kortix.app_site_files SET account_id = ${toAccountId}
    WHERE account_id = ${fromAccountId} AND deployment_id IN (${deployments})`);
  await tx.execute(sql`UPDATE kortix.app_runtimes SET account_id = ${toAccountId}
    WHERE account_id = ${fromAccountId} AND deployment_id IN (${deployments})`);
  await tx.execute(sql`UPDATE kortix.app_volumes SET account_id = ${toAccountId}
    WHERE account_id = ${fromAccountId} AND app_id IN (SELECT app_id FROM kortix.apps WHERE project_id = ${projectId})`);
  // The App's implicit OAuth client (and what it minted) belongs to the App.
  const appClients = sql`SELECT client_id FROM kortix.oauth_clients
    WHERE account_id = ${fromAccountId} AND app_id IN (SELECT app_id FROM kortix.apps WHERE project_id = ${projectId})`;
  await tx.execute(sql`UPDATE kortix.oauth_access_tokens SET account_id = ${toAccountId}
    WHERE account_id = ${fromAccountId} AND client_id IN (${appClients})`);
  await tx.execute(sql`UPDATE kortix.oauth_authorization_codes SET account_id = ${toAccountId}
    WHERE account_id = ${fromAccountId} AND client_id IN (${appClients})`);
  await tx.execute(sql`UPDATE kortix.oauth_clients SET account_id = ${toAccountId}, updated_at = now()
    WHERE client_id IN (${appClients})`);
}
