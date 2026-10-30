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
 * cannot be silently forgotten here.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  // Immutable audit evidence: the audit_events table's own comment says
  // account deletion must not rewrite forensic history; a transfer follows
  // the same rule for both audit tables.
  audit_events: 'forensic audit history — events stay where they happened',
  tunnel_audit_logs: 'audit evidence stays where the action happened',
  // Transient device-pairing requests; they expire on their own and the
  // approver's project access is re-checked at approval time.
  tunnel_device_auth_requests: 'transient pending device auth, self-expiring',
  // Per-user inbox items: what a user saw while the project lived in the
  // source account stays in the source account's view.
  notifications: 'user inbox history, not project-owned data',
  // Completed one-off migration runs — operations history, not live state.
  legacy_sandbox_migrations: 'completed ops migration run record',
  suna_account_migrations: 'completed ops migration run record',
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

async function cancelArtifactDeliveries(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], projectId: string, accountId: string) {
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

/**
 * Move `projectId` from `fromAccountId` to `toAccountId` in ONE transaction.
 *
 * Owned rows are re-pointed, preserving ids and timestamps. Account-salted
 * secrets are re-encrypted and source member grants are revoked atomically. Project-
 * scoped system role assignments follow the project; pending, custom-role
 * and group grants are removed: a group is a directory object of the source account and its
 * grant cannot be re-resolved inside the target (and keeping the row would
 * hand the source group's members access through the target's assignment).
 */
export async function transferProjectOwnership(
  input: TransferProjectOwnershipInput,
): Promise<{ projectId: string; accountId: string }> {
  const { projectId, fromAccountId, toAccountId } = input;

  if (fromAccountId === toAccountId) {
    throw new ProjectTransferError('same_account', 'Project is already in that account');
  }
  return db.transaction(async (tx) => {
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

    const limit = await maxProjectsForAccount(toAccountId);
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(projects)
      .where(sql`${projects.accountId} = ${toAccountId} AND ${projects.status} = 'active'`);
    if ((counted?.count ?? 0) >= limit) {
      throw new ProjectTransferError('project_limit_reached', 'Target account project limit reached');
    }

    await cancelArtifactDeliveries(tx, projectId, fromAccountId);

    // Source directory objects and invitation activation remain account-scoped.
    // Custom roles must not let source admins retain control after the move.
    await tx.execute(sql`DELETE FROM ${roleAssignments}
      WHERE account_id = ${fromAccountId} AND scope_type = 'project' AND scope_id = ${projectId}
        AND (principal_type IN ('group', 'pending') OR role_id IN (
          SELECT role_id FROM ${iamRoles} WHERE account_id = ${fromAccountId}
        ))`);

    // Lock credentials before reading their envelopes: concurrent refreshes must
    // not overwrite a destination envelope with ciphertext salted by the source.
    const secrets = await tx.select().from(accountSecretResources)
      .where(sql`${accountSecretResources.projectId} = ${projectId} AND ${accountSecretResources.accountId} = ${fromAccountId}`)
      .for('update');
    for (const secret of secrets) {
      // Member grants belong to the source directory, not the destination.
      // Delete before changing the resource's composite FK identity.
      await tx.delete(accountSecretGrants).where(eq(accountSecretGrants.secretId, secret.secretId));
      await tx.update(accountSecretResources).set({
        valueEnc: encryptAccountSecret(toAccountId, decryptAccountSecret(fromAccountId, secret.valueEnc)),
      }).where(eq(accountSecretResources.secretId, secret.secretId));
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
      await tx.execute(
        sql`UPDATE ${table} SET account_id = ${toAccountId}
             WHERE project_id = ${projectId} AND account_id = ${fromAccountId}`,
      );
    }

    await tx.execute(sql`SET CONSTRAINTS
      kortix.connector_connections_connector_tenant_fk,
      kortix.project_session_connector_bindings_session_tenant_fk,
      kortix.project_session_connector_bindings_alias_tenant_fk,
      kortix.project_session_connector_bindings_connection_tenant_fk,
      kortix.connection_oauth_applications_connection_tenant_fk IMMEDIATE`);

    // Project-scoped grants follow the project; group grants die with the
    // source account's directory (see the doc comment).
    await tx.execute(
      sql`UPDATE ${roleAssignments} SET account_id = ${toAccountId}
           WHERE account_id = ${fromAccountId}
             AND scope_type = 'project' AND scope_id = ${projectId}
             AND principal_type IN ('user', 'service_account', 'project')`,
    );

    logger.info('[project-transfer] project moved', {
      projectId,
      fromAccountId,
      toAccountId,
    });
    return { projectId, accountId: toAccountId };
  });
}
