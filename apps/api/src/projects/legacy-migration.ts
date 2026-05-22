import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  accountInvitations,
  accountMembers,
  accounts,
  legacySandboxMigrations,
  projectMembers,
  projectSessions,
  projects,
  sandboxInvites,
  sandboxMembers,
  sandboxes,
  sessionSandboxes,
  type Database,
} from '@kortix/db';

export type LegacyMigrationMode = 'dry_run' | 'apply' | 'verify' | 'rollback';
export type LegacyMigrationStatus = 'planned' | 'applied' | 'verified' | 'rolled_back' | 'failed';

type LegacySandboxRow = typeof sandboxes.$inferSelect;
type LegacyMigrationRow = typeof legacySandboxMigrations.$inferSelect;

const MIGRATABLE_SANDBOX_STATUSES = ['provisioning', 'active', 'stopped', 'error'] as const;
const ACTIVE_MIGRATION_STATUSES = ['applied', 'verified'] as const;

export interface LegacySandboxMigrationOptions {
  database?: Database;
  mode: LegacyMigrationMode;
  runId?: string;
  accountId?: string;
  sandboxId?: string;
  limit?: number;
  repoUrlTemplate?: string;
  now?: Date;
}

export interface LegacySandboxMigrationPlan {
  source_sandbox_id: string;
  account_id: string;
  project_id: string;
  session_id: string;
  project_name: string;
  repo_url: string;
  branch_name: string;
  provider: string;
  external_id: string | null;
  base_url: string;
  source_status: string;
  target_session_status: string;
  target_sandbox_status: string;
  member_user_ids: string[];
  pending_invite_emails: string[];
}

export interface LegacySandboxMigrationResultItem {
  sandbox_id: string;
  status: LegacyMigrationStatus | 'skipped';
  plan?: LegacySandboxMigrationPlan;
  error?: string;
  checks?: Record<string, boolean>;
}

export interface LegacySandboxMigrationResult {
  mode: LegacyMigrationMode;
  run_id: string;
  scanned: number;
  planned: number;
  applied: number;
  verified: number;
  rolled_back: number;
  skipped: number;
  failed: number;
  items: LegacySandboxMigrationResultItem[];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeSlug(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `legacy-${fallback.slice(0, 8)}`;
}

export function renderLegacyRepoUrl(template: string, plan: Omit<LegacySandboxMigrationPlan, 'repo_url'>): string {
  const slug = safeSlug(plan.project_name, plan.source_sandbox_id);
  return template
    .replaceAll('{account_id}', plan.account_id)
    .replaceAll('{sandbox_id}', plan.source_sandbox_id)
    .replaceAll('{session_id}', plan.session_id)
    .replaceAll('{project_id}', plan.project_id)
    .replaceAll('{slug}', slug);
}

function mapProjectSessionStatus(status: LegacySandboxRow['status']): NonNullable<(typeof projectSessions.$inferInsert)['status']> {
  if (status === 'active') return 'running';
  if (status === 'provisioning') return 'provisioning';
  if (status === 'error') return 'failed';
  return 'stopped';
}

function mapSessionSandboxStatus(status: LegacySandboxRow['status']): NonNullable<(typeof sessionSandboxes.$inferInsert)['status']> {
  if (status === 'active') return 'active';
  if (status === 'provisioning') return 'provisioning';
  if (status === 'error') return 'error';
  return 'stopped';
}

function emptyResult(mode: LegacyMigrationMode, runId: string): LegacySandboxMigrationResult {
  return {
    mode,
    run_id: runId,
    scanned: 0,
    planned: 0,
    applied: 0,
    verified: 0,
    rolled_back: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
}

function pushItem(result: LegacySandboxMigrationResult, item: LegacySandboxMigrationResultItem) {
  result.items.push(item);
  if (item.status === 'planned') result.planned += 1;
  else if (item.status === 'applied') result.applied += 1;
  else if (item.status === 'verified') result.verified += 1;
  else if (item.status === 'rolled_back') result.rolled_back += 1;
  else if (item.status === 'failed') result.failed += 1;
  else if (item.status === 'skipped') result.skipped += 1;
}

async function withTransaction<T>(database: Database, fn: (tx: Database) => Promise<T>): Promise<T> {
  const transaction = (database as unknown as {
    transaction?: <Result>(fn: (tx: Database) => Promise<Result>) => Promise<Result>;
  }).transaction;
  if (!transaction) return fn(database);
  return transaction.call(database, fn) as Promise<T>;
}

async function resolveDatabase(database?: Database): Promise<Database> {
  if (database) return database;
  const module = await import('../shared/db');
  return module.db;
}

async function selectLegacyCandidates(database: Database, options: LegacySandboxMigrationOptions) {
  const clauses = [
    inArray(sandboxes.status, [...MIGRATABLE_SANDBOX_STATUSES]),
  ];
  if (options.accountId) clauses.push(eq(sandboxes.accountId, options.accountId));
  if (options.sandboxId) clauses.push(eq(sandboxes.sandboxId, options.sandboxId));

  return database
    .select()
    .from(sandboxes)
    .where(and(...clauses))
    .orderBy(sandboxes.createdAt)
    .limit(options.limit && options.limit > 0 ? options.limit : 100);
}

async function selectActiveMigration(database: Database, sandboxId: string) {
  const [row] = await database
    .select()
    .from(legacySandboxMigrations)
    .where(and(
      eq(legacySandboxMigrations.sandboxId, sandboxId),
      inArray(legacySandboxMigrations.status, [...ACTIVE_MIGRATION_STATUSES]),
    ))
    .limit(1);
  return row ?? null;
}

async function buildPlan(
  database: Database,
  legacy: LegacySandboxRow,
  repoUrlTemplate: string | undefined,
): Promise<LegacySandboxMigrationPlan> {
  const members = await database
    .select()
    .from(sandboxMembers)
    .where(eq(sandboxMembers.sandboxId, legacy.sandboxId));
  const invites = await database
    .select()
    .from(sandboxInvites)
    .where(eq(sandboxInvites.sandboxId, legacy.sandboxId));

  const sourceSandboxId = legacy.sandboxId;
  const accountId = legacy.accountId;
  const projectId = randomUUID();
  const sessionId = sourceSandboxId;
  const projectName = legacy.name || `Migrated ${sourceSandboxId.slice(0, 8)}`;
  const basePlan = {
    source_sandbox_id: sourceSandboxId,
    account_id: accountId,
    project_id: projectId,
    session_id: sessionId,
    project_name: projectName,
    branch_name: sessionId,
    provider: legacy.provider,
    external_id: legacy.externalId,
    base_url: legacy.baseUrl,
    source_status: legacy.status,
    target_session_status: mapProjectSessionStatus(legacy.status),
    target_sandbox_status: mapSessionSandboxStatus(legacy.status),
    member_user_ids: Array.from(new Set([accountId, ...members.map((member) => member.userId)])),
    pending_invite_emails: invites
      .filter((invite) => !invite.acceptedAt)
      .map((invite) => invite.email),
  };

  return {
    ...basePlan,
    repo_url: repoUrlTemplate
      ? renderLegacyRepoUrl(repoUrlTemplate, basePlan)
      : `pending://legacy-sandbox/${sourceSandboxId}`,
  };
}

async function ensureAccountAndMembers(tx: Database, legacy: LegacySandboxRow, userIds: string[]) {
  const createdAccountMemberUserIds: string[] = [];
  const [existingAccount] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, legacy.accountId))
    .limit(1);

  if (!existingAccount) {
    await tx.insert(accounts).values({
      accountId: legacy.accountId,
      name: `Migrated ${legacy.name || legacy.accountId.slice(0, 8)}`,
      personalAccount: true,
    });
  }

  for (const userId of userIds) {
    const [existingMember] = await tx
      .select()
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, legacy.accountId), eq(accountMembers.userId, userId)))
      .limit(1);
    if (existingMember) continue;

    await tx.insert(accountMembers).values({
      accountId: legacy.accountId,
      userId,
      accountRole: userId === legacy.accountId ? 'owner' : 'member',
    }).onConflictDoNothing({
      target: [accountMembers.userId, accountMembers.accountId],
    });
    createdAccountMemberUserIds.push(userId);
  }

  return {
    createdAccount: !existingAccount,
    createdAccountMemberUserIds,
  };
}

async function applyOne(
  database: Database,
  runId: string,
  legacy: LegacySandboxRow,
  plan: LegacySandboxMigrationPlan,
  now: Date,
): Promise<LegacySandboxMigrationResultItem> {
  if (await selectActiveMigration(database, legacy.sandboxId)) {
    return { sandbox_id: legacy.sandboxId, status: 'skipped', plan };
  }

  try {
    await withTransaction(database, async (tx) => {
      const membership = await ensureAccountAndMembers(tx, legacy, plan.member_user_ids);
      const createdInvitationIds: string[] = [];
      const legacyMetadata = normalizeJsonObject(legacy.metadata);

      await tx.insert(projects).values({
        projectId: plan.project_id,
        accountId: plan.account_id,
        name: plan.project_name,
        repoUrl: plan.repo_url,
        defaultBranch: 'main',
        manifestPath: 'kortix.toml',
        status: 'active',
        metadata: {
          legacy_migration: {
            run_id: runId,
            source_sandbox_id: plan.source_sandbox_id,
            source_provider: plan.provider,
            source_external_id: plan.external_id,
            migrated_at: now.toISOString(),
          },
        },
      });

      for (const userId of plan.member_user_ids) {
        await tx.insert(projectMembers).values({
          accountId: plan.account_id,
          projectId: plan.project_id,
          userId,
          projectRole: userId === plan.account_id ? 'manager' : 'editor',
          grantedBy: plan.account_id,
        }).onConflictDoNothing({
          target: [projectMembers.projectId, projectMembers.userId],
        });
      }

      const invites = await tx
        .select()
        .from(sandboxInvites)
        .where(eq(sandboxInvites.sandboxId, legacy.sandboxId));
      for (const invite of invites.filter((row) => !row.acceptedAt)) {
        const inviteId = randomUUID();
        await tx.insert(accountInvitations).values({
          inviteId,
          accountId: plan.account_id,
          email: invite.email,
          invitedBy: invite.invitedBy,
          initialRole: invite.initialRole,
          expiresAt: invite.expiresAt,
        }).onConflictDoNothing({
          target: [accountInvitations.accountId, accountInvitations.email],
        });
        createdInvitationIds.push(inviteId);
      }

      await tx.insert(projectSessions).values({
        sessionId: plan.session_id,
        accountId: plan.account_id,
        projectId: plan.project_id,
        branchName: plan.branch_name,
        baseRef: 'main',
        sandboxProvider: legacy.provider,
        sandboxId: plan.session_id,
        sandboxUrl: plan.base_url,
        agentName: 'default',
        status: plan.target_session_status as NonNullable<(typeof projectSessions.$inferInsert)['status']>,
        error: legacy.status === 'error' ? 'Migrated from legacy sandbox in error state' : null,
        metadata: {
          legacy_migration: {
            run_id: runId,
            source_sandbox_id: plan.source_sandbox_id,
          },
        },
      });

      await tx.insert(sessionSandboxes).values({
        sandboxId: plan.source_sandbox_id,
        sessionId: plan.session_id,
        accountId: plan.account_id,
        projectId: plan.project_id,
        provider: legacy.provider,
        externalId: plan.external_id,
        baseUrl: plan.base_url,
        status: plan.target_sandbox_status as NonNullable<(typeof sessionSandboxes.$inferInsert)['status']>,
        config: normalizeJsonObject(legacy.config),
        metadata: {
          ...legacyMetadata,
          legacy_migration: {
            run_id: runId,
            source_sandbox_id: plan.source_sandbox_id,
          },
        },
        lastUsedAt: legacy.lastUsedAt,
      });

      await tx.update(sandboxes).set({
        status: 'archived',
        metadata: {
          ...legacyMetadata,
          legacy_migration: {
            run_id: runId,
            project_id: plan.project_id,
            session_id: plan.session_id,
            archived_at: now.toISOString(),
          },
        },
        updatedAt: now,
      }).where(eq(sandboxes.sandboxId, legacy.sandboxId));

      await tx.insert(legacySandboxMigrations).values({
        runId,
        sandboxId: legacy.sandboxId,
        accountId: legacy.accountId,
        projectId: plan.project_id,
        sessionId: plan.session_id,
        status: 'applied',
        mode: 'apply',
        plan: plan as unknown as Record<string, unknown>,
        rollback: {
          original_sandbox_status: legacy.status,
          original_sandbox_metadata: legacyMetadata,
          created_account: membership.createdAccount,
          created_account_member_user_ids: membership.createdAccountMemberUserIds,
          created_invitation_ids: createdInvitationIds,
        },
        appliedAt: now,
        updatedAt: now,
      });
    });

    return { sandbox_id: legacy.sandboxId, status: 'applied', plan };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.insert(legacySandboxMigrations).values({
      runId,
      sandboxId: legacy.sandboxId,
      accountId: legacy.accountId,
      status: 'failed',
      mode: 'apply',
      plan: plan as unknown as Record<string, unknown>,
      error: message,
    }).onConflictDoNothing();
    return { sandbox_id: legacy.sandboxId, status: 'failed', plan, error: message };
  }
}

async function selectMigrationRows(database: Database, options: LegacySandboxMigrationOptions) {
  const clauses = [inArray(legacySandboxMigrations.status, [...ACTIVE_MIGRATION_STATUSES])];
  if (options.runId) clauses.push(eq(legacySandboxMigrations.runId, options.runId));
  if (options.accountId) clauses.push(eq(legacySandboxMigrations.accountId, options.accountId));
  if (options.sandboxId) clauses.push(eq(legacySandboxMigrations.sandboxId, options.sandboxId));

  return database
    .select()
    .from(legacySandboxMigrations)
    .where(and(...clauses))
    .orderBy(legacySandboxMigrations.createdAt)
    .limit(options.limit && options.limit > 0 ? options.limit : 100);
}

async function verifyOne(database: Database, row: LegacyMigrationRow, now: Date): Promise<LegacySandboxMigrationResultItem> {
  const [project] = row.projectId
    ? await database.select().from(projects).where(eq(projects.projectId, row.projectId)).limit(1)
    : [];
  const [session] = row.sessionId
    ? await database.select().from(projectSessions).where(eq(projectSessions.sessionId, row.sessionId)).limit(1)
    : [];
  const [runtime] = await database
    .select()
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
    .limit(1);
  const [legacy] = await database
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.sandboxId, row.sandboxId))
    .limit(1);

  const checks = {
    project_exists: Boolean(project),
    session_exists: Boolean(session),
    runtime_exists: Boolean(runtime),
    legacy_archived: legacy?.status === 'archived',
    ids_match: Boolean(session && runtime && session.sessionId === runtime.sessionId && session.sandboxId === runtime.sandboxId),
  };
  const ok = Object.values(checks).every(Boolean);

  await database.update(legacySandboxMigrations).set({
    status: ok ? 'verified' : 'failed',
    mode: 'verify',
    verifiedAt: ok ? now : null,
    error: ok ? null : `Verification failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`,
    updatedAt: now,
  }).where(eq(legacySandboxMigrations.migrationId, row.migrationId));

  return {
    sandbox_id: row.sandboxId,
    status: ok ? 'verified' : 'failed',
    plan: row.plan as unknown as LegacySandboxMigrationPlan,
    checks,
    error: ok ? undefined : 'Verification failed',
  };
}

async function rollbackOne(database: Database, row: LegacyMigrationRow, now: Date): Promise<LegacySandboxMigrationResultItem> {
  const rollback = normalizeJsonObject(row.rollback);
  const originalSandboxStatus = typeof rollback.original_sandbox_status === 'string'
    ? rollback.original_sandbox_status as LegacySandboxRow['status']
    : 'stopped';
  const originalSandboxMetadata = normalizeJsonObject(rollback.original_sandbox_metadata);
  const createdAccountMemberUserIds = asStringArray(rollback.created_account_member_user_ids);
  const createdInvitationIds = asStringArray(rollback.created_invitation_ids);
  const createdAccount = rollback.created_account === true;

  try {
    await withTransaction(database, async (tx) => {
      await tx.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      if (row.sessionId) {
        await tx.delete(projectSessions).where(eq(projectSessions.sessionId, row.sessionId));
      }
      if (row.projectId) {
        await tx.delete(projects).where(eq(projects.projectId, row.projectId));
      }
      for (const inviteId of createdInvitationIds) {
        await tx.delete(accountInvitations).where(eq(accountInvitations.inviteId, inviteId));
      }
      for (const userId of createdAccountMemberUserIds) {
        await tx.delete(accountMembers).where(and(
          eq(accountMembers.accountId, row.accountId),
          eq(accountMembers.userId, userId),
        ));
      }
      if (createdAccount) {
        await tx.delete(accounts).where(eq(accounts.accountId, row.accountId));
      }
      await tx.update(sandboxes).set({
        status: originalSandboxStatus,
        metadata: originalSandboxMetadata,
        updatedAt: now,
      }).where(eq(sandboxes.sandboxId, row.sandboxId));
      await tx.update(legacySandboxMigrations).set({
        status: 'rolled_back',
        mode: 'rollback',
        rolledBackAt: now,
        updatedAt: now,
      }).where(eq(legacySandboxMigrations.migrationId, row.migrationId));
    });

    return {
      sandbox_id: row.sandboxId,
      status: 'rolled_back',
      plan: row.plan as unknown as LegacySandboxMigrationPlan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database.update(legacySandboxMigrations).set({
      status: 'failed',
      mode: 'rollback',
      error: message,
      updatedAt: now,
    }).where(eq(legacySandboxMigrations.migrationId, row.migrationId));
    return {
      sandbox_id: row.sandboxId,
      status: 'failed',
      plan: row.plan as unknown as LegacySandboxMigrationPlan,
      error: message,
    };
  }
}

export async function runLegacySandboxMigration(options: LegacySandboxMigrationOptions): Promise<LegacySandboxMigrationResult> {
  const database = await resolveDatabase(options.database);
  const runId = options.runId ?? `legacy-sandbox-${Date.now()}`;
  const now = options.now ?? new Date();
  const result = emptyResult(options.mode, runId);

  if (options.mode === 'verify') {
    const rows = await selectMigrationRows(database, options);
    result.scanned = rows.length;
    for (const row of rows) pushItem(result, await verifyOne(database, row, now));
    return result;
  }

  if (options.mode === 'rollback') {
    const rows = await selectMigrationRows(database, options);
    result.scanned = rows.length;
    for (const row of rows) pushItem(result, await rollbackOne(database, row, now));
    return result;
  }

  const candidates = await selectLegacyCandidates(database, options);
  result.scanned = candidates.length;

  if (options.mode === 'apply' && !options.repoUrlTemplate) {
    throw new Error('--repo-url-template is required for apply');
  }

  for (const legacy of candidates) {
    const plan = await buildPlan(database, legacy, options.repoUrlTemplate);
    if (options.mode === 'dry_run') {
      const existing = await selectActiveMigration(database, legacy.sandboxId);
      pushItem(result, {
        sandbox_id: legacy.sandboxId,
        status: existing ? 'skipped' : 'planned',
        plan,
      });
      continue;
    }
    pushItem(result, await applyOne(database, runId, legacy, plan, now));
  }

  return result;
}
