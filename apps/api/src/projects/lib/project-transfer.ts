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
import {
  artifacts,
  artifactCommentThreads,
  artifactEvents,
  jobQueue,
  sessionSandboxIdentities,
  projectSessionGroups,
  projectSpaces,
  rooms,
  sessionIdleWatches,
  accountModelPreferences,
  accountSecretResources,
  accountSecretGrants,
  accountTokens,
  appArtifacts,
  apps,
  changeRequests,
  connectorAttachments,
  connectorCalls,
  connectorHeldCalls,
  connectorConnections,
  connectionOAuthApplications,
  connectionOAuthSessions,
  connectors,
  drives,
  gatewayApiKeys,
  projectAccessRequests,
  projectGitConnections,
  projectGitCredentials,
  projectMonitorBoxes,
  projectSessionConnectorBindings,
  projectSessionPublicShares,
  projectSessions,
  projectSnapshotBuilds,
  projectTriggerEventSubscriptions,
  projectTriggerEventPolls,
  projects,
  accounts,
  iamRoles,
  promptAttachments,
  providerTransitions,
  reviewItems,
  roleAssignments,
  sandboxTemplates,
  serviceAccounts,
  sessionContentPurges,
  sessionLifecycleCommands,
  sessionLogs,
  sessionPendingPermissions,
  sessionPendingQuestions,
  sessionRuntimeProjections,
  sessionSandboxes,
  sessionTurns,
} from '@kortix/db';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { isUuid } from '../../shared/validate';
import { maxProjectsForAccount } from '../../shared/account-limits';
import { blobKey, supabaseSiteStorage, type SiteStorage } from '../../apps/static-site';
import { mapWithConcurrency } from '../../shared/map-with-concurrency';

/**
 * Tables the transfer UPDATES (`account_id` → the target account) for the
 * moved project's rows. `projects` is first: the row that owns the move.
 * Rows whose `project_id` is NULL (account-scoped secrets, templates,
 * personal drives, manual service accounts, unbound tokens) never match the
 * `project_id = :projectId` predicate and stay put.
 */
export const PROJECT_TRANSFER_TABLES: readonly PgTable[] = [
  projects,
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
  | 'project_limit_reached';

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

const transferDeliveryError = 'Project ownership changed before Artifact comment delivery.';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function cancelArtifactDeliveries(tx: TransferTx, projectId: string, accountId: string) {
  const owned = await tx.select({ id: artifacts.artifactId }).from(artifacts)
    .where(and(eq(artifacts.projectId, projectId), eq(artifacts.accountId, accountId))).for('update');
  const ids = owned.map((row) => row.id);
  if (!ids.length) return;
  const [commands, jobs] = await Promise.all([
    tx.select().from(sessionLifecycleCommands).where(and(eq(sessionLifecycleCommands.projectId, projectId), eq(sessionLifecycleCommands.accountId, accountId),
      inArray(sessionLifecycleCommands.artifactId, ids), eq(sessionLifecycleCommands.source, 'system:artifact-comment'), inArray(sessionLifecycleCommands.status, ['queued', 'running']))),
    tx.select().from(jobQueue).where(and(inArray(jobQueue.artifactId, ids), inArray(jobQueue.queue, ['artifact-comment-agents', 'artifact-comment-people']))),
  ]);
  const references = new Set<string>();
  const keys = new Set<string>();
  const add = (value: unknown) => {
    if (!object(value)) return;
    if (typeof value.job_id === 'string') references.add(value.job_id);
    if (typeof value.target_key === 'string') keys.add(value.target_key);
  };
  for (const command of commands) {
    if (command.idempotencyKey) keys.add(command.idempotencyKey);
    add(command.payload.artifactCommentDelivery);
    if (object(command.payload.metadata)) add(command.payload.metadata.artifactCommentDelivery);
    const digest = command.payload.artifactCommentDigest;
    if (object(digest) && Array.isArray(digest.deliveries)) for (const reference of digest.deliveries) add(reference);
    if (object(digest) && Array.isArray(digest.keys)) for (const key of digest.keys) if (typeof key === 'string') keys.add(key);
  }
  const threadIds = new Set<string>();
  for (const job of jobs) if (job.queue === 'artifact-comment-agents' && (job.status === 'queued' || references.has(job.jobId)) && Array.isArray(job.payload.threadIds)) {
    for (const id of job.payload.threadIds) if (typeof id === 'string' && isUuid(id)) threadIds.add(id);
  }
  if (keys.size) {
    const events = await tx.select({ data: artifactEvents.data }).from(artifactEvents).where(and(inArray(artifactEvents.artifactId, ids), eq(artifactEvents.type, 'sent_to_agent')));
    for (const { data } of events) if (typeof data.delivery_key === 'string' && keys.has(data.delivery_key) && typeof data.thread_id === 'string' && isUuid(data.thread_id)) threadIds.add(data.thread_id);
  }
  await tx.update(jobQueue).set({ status: 'dead', lastError: transferDeliveryError, lockedUntil: null, updatedAt: new Date() })
    .where(and(inArray(jobQueue.artifactId, ids), eq(jobQueue.status, 'queued'), inArray(jobQueue.queue, ['artifact-comment-agents', 'artifact-comment-people'])));
  if (commands.length) await tx.update(sessionLifecycleCommands).set({ status: 'dead_lettered', result: sql`coalesce(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"status":"cancelled","reason":"project_transferred"}'::jsonb`, lastError: transferDeliveryError, lockedBy: null, lockedUntil: null, updatedAt: new Date() })
    .where(and(inArray(sessionLifecycleCommands.commandId, commands.map((command) => command.commandId)), inArray(sessionLifecycleCommands.status, ['queued', 'running'])));
  if (threadIds.size) await tx.update(artifactCommentThreads).set({ agentState: 'paused', agentError: transferDeliveryError, updatedAt: new Date() })
    .where(and(inArray(artifactCommentThreads.artifactId, ids), inArray(artifactCommentThreads.threadId, [...threadIds]), inArray(artifactCommentThreads.agentState, ['pending', 'sent'])));
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

/**
 * Keep `projects.split_pending` true exactly while the account holds 2+
 * active projects (a legacy multi-project account), false once it holds one.
 * The 1:1 index `uq_projects_workspace_account` skips split-pending rows.
 */
export async function recomputeSplitPending(tx: TransferTx, accountId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE kortix.projects p SET split_pending = sub.multi
      FROM (SELECT count(*) > 1 AS multi FROM kortix.projects
             WHERE account_id = ${accountId} AND status = 'active') sub
     WHERE p.account_id = ${accountId} AND p.status = 'active' AND p.split_pending IS DISTINCT FROM sub.multi`);
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
): Promise<{ projectId: string; accountId: string; undecryptableSecrets: string[] }> {
  if (input.fromAccountId === input.toAccountId) {
    throw new ProjectTransferError('same_account', 'Project is already in that account');
  }
  await copyProjectSiteBlobs(input, options.siteStorage);
  return db.transaction((tx) => moveProjectInTransaction(tx, input, options));
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
  const [row] = await tx.select({ account_id: projects.accountId, status: projects.status })
    .from(projects).where(eq(projects.projectId, projectId)).for('update');
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

  const [target] = await tx.select({ accountId: accounts.accountId }).from(accounts)
    .where(eq(accounts.accountId, toAccountId)).for('update');
  if (!target) throw new ProjectTransferError('target_missing', 'Target account not found');

  if (!split) {
    const limit = await maxProjectsForAccount(toAccountId);
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(projects)
      .where(sql`${projects.accountId} = ${toAccountId} AND ${projects.status} = 'active'`);
    if ((counted?.count ?? 0) >= limit) {
      throw new ProjectTransferError('project_limit_reached', 'Target account project limit reached');
    }
  }

  await cancelArtifactDeliveries(tx, projectId, fromAccountId);

  if (!split) {
    // Source directory objects and invitation activation remain account-scoped.
    // Custom roles must not let source admins retain control after the move.
    await tx.execute(sql`DELETE FROM ${roleAssignments}
      WHERE account_id = ${fromAccountId} AND scope_type = 'project' AND scope_id = ${projectId}
        AND (principal_type IN ('group', 'pending') OR role_id IN (
          SELECT role_id FROM ${iamRoles} WHERE account_id = ${fromAccountId}
        ))`);
  }

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

  // Both ends contain account_id. Defer only this graph's tenant checks;
  // ordinary connector writes retain immediate foreign-key enforcement.
  await tx.execute(sql`SET CONSTRAINTS
    kortix.connector_connections_connector_tenant_fk,
    kortix.project_session_connector_bindings_session_tenant_fk,
    kortix.project_session_connector_bindings_alias_tenant_fk,
    kortix.project_session_connector_bindings_connection_tenant_fk,
    kortix.connection_oauth_applications_connection_tenant_fk DEFERRED`);

  for (const table of PROJECT_TRANSFER_TABLES) {
    const sessionColumn = SESSION_KEYED_TRANSFER_TABLES[getTableName(table)];
    // A session-keyed table without a project_id index is reached through its
    // (NOT NULL, indexed) session column instead of a sequential scan.
    const bySession = sessionColumn
      ? sql` AND ${sql.identifier(sessionColumn)} IN (SELECT session_id FROM kortix.project_sessions WHERE project_id = ${projectId})`
      : sql``;
    await tx.execute(
      sql`UPDATE ${table} SET account_id = ${toAccountId}
           WHERE project_id = ${projectId} AND account_id = ${fromAccountId}${bySession}`,
    );
  }

  await tx.execute(sql`SET CONSTRAINTS
    kortix.connector_connections_connector_tenant_fk,
    kortix.project_session_connector_bindings_session_tenant_fk,
    kortix.project_session_connector_bindings_alias_tenant_fk,
    kortix.project_session_connector_bindings_connection_tenant_fk,
    kortix.connection_oauth_applications_connection_tenant_fk IMMEDIATE`);

  await moveAppHostingRows(tx, projectId, fromAccountId, toAccountId);

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

  await recomputeSplitPending(tx, fromAccountId);
  await recomputeSplitPending(tx, toAccountId);

  logger.info('[project-transfer] project moved', {
    projectId,
    fromAccountId,
    toAccountId,
    split: Boolean(split),
  });
  return { projectId, accountId: toAccountId, undecryptableSecrets };
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
}
