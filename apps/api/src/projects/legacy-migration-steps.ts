/**
 * Phase implementations for the durable legacy-sandbox migration. Each function
 * is one step in the pipeline driven by legacy-migration-runner.ts.
 *
 * CONTRACT for every step:
 *   1. Idempotent — re-running after a crash must be harmless. Read `ctx.progress`
 *      to detect work already done and skip it.
 *   2. Checkpoint — after each externally-visible side effect, record its handle
 *      (url, repo id, ...) via `ctx.checkpoint` so a later run can find it.
 *   3. Heartbeat — inside long loops, call `ctx.heartbeat()` so the lease doesn't
 *      go stale and get reclaimed mid-step.
 *   4. Throw on failure — the runner handles retry/backoff/dead-lettering.
 *
 * Pipeline: extract -> repo -> push -> db
 *   extract: SSH the JustAVPS VM, tar /workspace files + .kortix + the OpenCode
 *            store, upload the bundle to object storage, record session ids.
 *   repo:    create the managed repo (via the configured git backend — GitHub)
 *            that becomes the project's durable file home.
 *   push:    materialize the extracted files, synthesize kortix.toml/Dockerfile/
 *            .gitignore if absent, push to the repo's default branch.
 *   db:      one transaction — create project + project_members + one
 *            project_session per preserved OpenCode session, archive the legacy
 *            sandbox, and let the runner flip the row to completed.
 */
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  legacySandboxMigrations,
  projectGitConnections,
  projectMembers,
  projectSessions,
  projects,
  sandboxes,
} from '@kortix/db';
import {
  type GitConnectionRef,
  getBackend,
  getDefaultManagedBackend,
} from './git-backends';
import {
  backupExists,
  backupObjectPath,
  createBackupUploadTarget,
} from './legacy-migration-storage';
import {
  execOnLegacyVm,
  execOnLegacyVmOrThrow,
  RESOLVE_WS_OC_SH,
  resolveLegacyVmEndpoint,
} from './legacy-vm-access';
import type { MigrationContext } from './legacy-migration-runner';

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeBranch(title: string, id: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'session'}-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
}

function progressStr(ctx: MigrationContext, key: string): string | null {
  const v = ctx.progress[key];
  return typeof v === 'string' && v ? v : null;
}

function gitRefFromProgress(ctx: MigrationContext): GitConnectionRef {
  const upstreamUrl = progressStr(ctx, 'git_url');
  if (!upstreamUrl) throw new Error('git: repo phase did not record git_url');
  return {
    provider: progressStr(ctx, 'git_provider') ?? 'github',
    upstreamUrl,
    externalRepoId: progressStr(ctx, 'git_external_repo_id'),
    repoOwner: progressStr(ctx, 'git_repo_owner'),
    repoName: progressStr(ctx, 'git_repo_name'),
    installationId: progressStr(ctx, 'git_installation_id'),
    credentialRef: progressStr(ctx, 'git_credential_ref'),
    defaultBranch: progressStr(ctx, 'default_branch') ?? 'main',
    managed: true,
    metadata: {},
  };
}

export interface LegacyOpencodeSession { id: string; title: string }

async function enumerateOpencodeSessions(ctx: MigrationContext): Promise<{ sessions: LegacyOpencodeSession[]; archiveB64: string | null }> {
  const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);
  const script = [
    RESOLVE_WS_OC_SH,
    '[ -z "$OC" ] && exit 0',
    'cd "$OC" 2>/dev/null && tar czf - opencode.db opencode.db-wal opencode.db-shm 2>/dev/null | base64 | tr -d "\\n"',
  ].join('\n');
  const out = await execOnLegacyVm(endpoint, `bash -c ${sq(script)}`, 180);
  const b64 = out.stdout.trim();
  if (!b64) {
    ctx.log('extract: no opencode.db on machine — nothing to enumerate');
    return { sessions: [], archiveB64: null };
  }
  const dir = mkdtempSync(join(tmpdir(), 'kortix-oc-'));
  try {
    writeFileSync(join(dir, 'oc.tar.gz'), Buffer.from(b64, 'base64'));
    const untar = Bun.spawnSync(['tar', 'xzf', join(dir, 'oc.tar.gz'), '-C', dir]);
    if (untar.exitCode !== 0) throw new Error(`extract: failed to unpack opencode.db: ${new TextDecoder().decode(untar.stderr)}`);
    const db = new Database(join(dir, 'opencode.db'), { readonly: true });
    try {
      const rows = db.query(
        "select id, coalesce(nullif(title,''), slug, id) as title from session where parent_id is null and time_archived is null order by time_updated desc",
      ).all() as Array<{ id: string; title: string }>;
      return { sessions: rows.map((r) => ({ id: r.id, title: String(r.title).slice(0, 200) })), archiveB64: b64 };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class MigrationStepNotImplemented extends Error {
  constructor(phase: string) {
    super(`Migration phase "${phase}" is not yet wired up`);
    this.name = 'MigrationStepNotImplemented';
  }
}

export async function extractStep(ctx: MigrationContext): Promise<void> {
  const sandboxId = ctx.legacy.sandboxId;

  if (process.env.LEGACY_MIGRATION_SKIP_BACKUP === '1') {
    ctx.log('extract: LEGACY_MIGRATION_SKIP_BACKUP=1 — skipping backup upload (TEST ONLY)');
    if (ctx.progress.backup_skipped !== true) await ctx.checkpoint({ backup_skipped: true, backup_path: null });
  } else if (ctx.progress.backup_path && (await backupExists(sandboxId))) {
    ctx.log('extract: backup already present, skipping upload', { path: ctx.progress.backup_path });
  } else {
    const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);
    const target = await createBackupUploadTarget(sandboxId);

    const script = [
      'set -euo pipefail',
      RESOLVE_WS_OC_SH,
      'BUNDLE=/tmp/kortix-migration-bundle.tar.gz',
      'tar czf "$BUNDLE" --warning=no-file-changed --warning=no-file-ignored' +
        ' --exclude=node_modules --exclude=.git --exclude=.persistent-system' +
        ' --exclude=.cache --exclude=.local --exclude=.config --exclude=.browser-profile' +
        ' --exclude=.npm --exclude=.bun --exclude=.cargo --exclude=.ssh --exclude=.gnupg' +
        ' -C "$(dirname "$WS")" "$(basename "$WS")"' +
        ' ${OC:+-C "$(dirname "$OC")" "$(basename "$OC")"}' +
        ' || [ $? -le 1 ]',
      `curl -fsS -X PUT -H 'x-upsert: true' -H 'Content-Type: application/octet-stream' --data-binary @"$BUNDLE" ${sq(target.url)}`,
      'rm -f "$BUNDLE"',
      'echo OK',
    ].join('\n');

    ctx.log('extract: backing up VM', { externalId: ctx.legacy.externalId });
    await execOnLegacyVmOrThrow(endpoint, `bash -c ${sq(script)}`, 900);
    await ctx.checkpoint({ backup_path: target.path, backup_bucket_uploaded_at: new Date().toISOString() });
  }

  if (!Array.isArray(ctx.progress.opencode_sessions)) {
    const { sessions, archiveB64 } = await enumerateOpencodeSessions(ctx);
    if (archiveB64) {
      await ctx.database.update(legacySandboxMigrations)
        .set({ opencodeArchive: archiveB64, updatedAt: new Date() })
        .where(eq(legacySandboxMigrations.migrationId, ctx.migrationId));
    }
    await ctx.checkpoint({ opencode_sessions: sessions });
    ctx.log('extract: enumerated opencode sessions', { count: sessions.length, captured: Boolean(archiveB64) });
  }
}

export async function repoStep(ctx: MigrationContext): Promise<void> {
  if (typeof ctx.progress.git_url === 'string' && ctx.progress.git_url) {
    ctx.log('repo: already created, skipping', { git_url: ctx.progress.git_url });
    return;
  }

  const backend = getDefaultManagedBackend();
  if (!(await backend.isConfigured())) {
    throw new Error(`Managed git provider "${backend.id}" is not configured; cannot provision project repo`);
  }

  const defaultBranch = 'main';
  const baseSlug = (
    ctx.plan.project_name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') ||
    'kortix-project'
  ).slice(0, 40);
  const provisioned = await backend.createRepo({
    accountId: ctx.plan.account_id,
    projectId: ctx.plan.project_id,
    slug: `${baseSlug}-${ctx.plan.project_id}`,
    defaultBranch,
    isPrivate: true,
  });

  await ctx.checkpoint({
    git_provider: provisioned.provider,
    git_url: provisioned.upstreamUrl,
    git_external_repo_id: provisioned.externalRepoId,
    git_repo_owner: provisioned.repoOwner,
    git_repo_name: provisioned.repoName,
    git_installation_id: provisioned.installationId,
    git_credential_ref: provisioned.credentialRef,
    default_branch: provisioned.defaultBranch || defaultBranch,
  });
  ctx.log('repo: created', { provider: provisioned.provider, repo: provisioned.repoName });
}


const PUSH_EXCLUDES = [
  '.persistent-system', '.kortix/services', '.kortix/backups',
  'node_modules', '.cache', '.npm', '.npm-global', '.bun', '.cargo', '.rustup',
  '.pnpm-store', '.local', '.config', '.mozilla', '.browser-profile',
  '.cursor-server', '.vscode-server', '.dbus', '.XDG', '__pycache__', '.venv', 'venv',
  '.ssh', '.gnupg', 'ssl', '.secrets', '.kortix/secrets', '*.pem', '*.key', '*.log',
];
export async function pushStep(ctx: MigrationContext): Promise<void> {
  if (ctx.progress.pushed === true) {
    ctx.log('push: already pushed, skipping');
    return;
  }

  const ref = gitRefFromProgress(ctx);
  const defaultBranch = ref.defaultBranch;

  const backend = getBackend(ref.provider);
  if (!backend.authedPushUrl) {
    throw new Error(`push: managed git provider "${ref.provider}" cannot mint a push URL`);
  }
  const authedUrl = await backend.authedPushUrl(ref);
  const excludeLine = PUSH_EXCLUDES.map(sq).join(' ');

  const script = [
    'set -euo pipefail',
    RESOLVE_WS_OC_SH,
    'cd "$WS"',
    'export HOME="$(mktemp -d)"',
    `git config --global --add safe.directory ${sq('*')}`,
    `[ -f kortix.toml ] || printf '%s\\n' ${sq('[project]')} ${sq(`name = "${ctx.plan.project_name.replace(/"/g, "'")}"`)} ${sq('description = "Migrated from a legacy Kortix sandbox."')} > kortix.toml`,
    `printf '%s\\n' ${excludeLine} > .gitignore`,
    'rm -rf .git',
    'git init -q',
    `printf '%s\\n' ${excludeLine} > .git/info/exclude`,
    `git checkout -qB ${sq(defaultBranch)}`,
    'git add -A',
    `git -c user.email=migrations@kortix.com -c user.name=Kortix commit -q --allow-empty -m ${sq('Import legacy workspace')}`,
    `git push --force ${sq(authedUrl)} HEAD:${sq(defaultBranch)}`,
    'echo "PUSH_OK files=$(git ls-files | wc -l) bytes=$(git ls-files -z | du -ch --files0-from=- 2>/dev/null | tail -1 | cut -f1)"',
  ].join('\n');

  const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);
  ctx.log('push: pushing workspace to managed repo', { provider: ref.provider, repo: ref.repoName });
  const out = await execOnLegacyVmOrThrow(endpoint, `bash -c ${sq(script)}`, 900);
  ctx.log('push: done', { summary: out.trim().split('\n').pop() });
  await ctx.checkpoint({ pushed: true });
}

export async function dbStep(ctx: MigrationContext): Promise<void> {
  if (ctx.progress.db_committed === true) {
    ctx.log('db: already committed, skipping');
    return;
  }

  const { plan, legacy } = ctx;
  const ref = gitRefFromProgress(ctx);
  const gitUrl = ref.upstreamUrl;
  const defaultBranch = ref.defaultBranch;
  const authMethod = ref.provider === 'github' ? 'github_app' : 'managed';
  const backupPath = typeof ctx.progress.backup_path === 'string' ? ctx.progress.backup_path : null;
  const ocSessions = Array.isArray(ctx.progress.opencode_sessions)
    ? (ctx.progress.opencode_sessions as Array<{ id?: unknown; title?: unknown }>)
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({ id: s.id as string, title: typeof s.title === 'string' && s.title ? s.title : (s.id as string) }))
    : [];

  const now = new Date();
  const legacyMeta = (legacy.metadata && typeof legacy.metadata === 'object' && !Array.isArray(legacy.metadata)
    ? legacy.metadata : {}) as Record<string, unknown>;

  await (ctx.database as unknown as {
    transaction: <T>(fn: (tx: typeof ctx.database) => Promise<T>) => Promise<T>;
  }).transaction(async (tx) => {
    const [existingAccount] = await tx.select().from(accounts).where(eq(accounts.accountId, plan.account_id)).limit(1);
    const createdAccount = !existingAccount;
    if (!existingAccount) {
      await tx.insert(accounts).values({
        accountId: plan.account_id,
        name: `Migrated ${legacy.name || plan.account_id.slice(0, 8)}`,
        personalAccount: true,
      }).onConflictDoNothing({ target: accounts.accountId });
    }

    const legacyMemberUserIds = plan.member_user_ids.filter((id) => id !== plan.account_id);
    const createdMemberUserIds: string[] = [];
    for (const userId of legacyMemberUserIds) {
      const [exists] = await tx.select().from(accountMembers)
        .where(and(eq(accountMembers.accountId, plan.account_id), eq(accountMembers.userId, userId))).limit(1);
      if (exists) continue;
      await tx.insert(accountMembers).values({ accountId: plan.account_id, userId, accountRole: 'member' })
        .onConflictDoNothing({ target: [accountMembers.userId, accountMembers.accountId] });
      createdMemberUserIds.push(userId);
    }

    const accountMemberRows = await tx.select({ userId: accountMembers.userId, role: accountMembers.accountRole })
      .from(accountMembers).where(eq(accountMembers.accountId, plan.account_id));
    const ownerSet = new Set(accountMemberRows.filter((r) => r.role === 'owner').map((r) => r.userId));
    const projectUserIds = Array.from(new Set([...accountMemberRows.map((r) => r.userId), ...legacyMemberUserIds]));
    const grantedBy = [...ownerSet][0] ?? projectUserIds[0] ?? plan.account_id;

    await tx.insert(projects).values({
      projectId: plan.project_id,
      accountId: plan.account_id,
      name: plan.project_name,
      repoUrl: gitUrl,
      defaultBranch,
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        git: {
          url: gitUrl,
          upstream_url: gitUrl,
          default_branch: defaultBranch,
          provider: ref.provider,
          managed: true,
          auth: { method: authMethod, ref: ref.credentialRef, installation_id: ref.installationId },
          repo_id: ref.externalRepoId,
          owner: ref.repoOwner,
          name: ref.repoName,
        },
        legacy_migration: {
          run_id: ctx.runId,
          source_sandbox_id: plan.source_sandbox_id,
          source_provider: legacy.provider,
          backup_path: backupPath,
          migrated_at: now.toISOString(),
        },
      },
    }).onConflictDoNothing({ target: projects.projectId });

    await tx.insert(projectGitConnections).values({
      accountId: plan.account_id,
      projectId: plan.project_id,
      provider: ref.provider,
      repoUrl: gitUrl,
      upstreamUrl: gitUrl,
      managed: true,
      repoOwner: ref.repoOwner,
      repoName: ref.repoName,
      externalRepoId: ref.externalRepoId,
      defaultBranch,
      authMethod,
      installationId: ref.installationId,
      credentialRef: ref.credentialRef,
      visibility: 'private',
      status: 'connected',
    }).onConflictDoNothing({ target: projectGitConnections.projectId });

    for (const userId of projectUserIds) {
      await tx.insert(projectMembers).values({
        accountId: plan.account_id,
        projectId: plan.project_id,
        userId,
        projectRole: ownerSet.has(userId) ? 'manager' : 'editor',
        grantedBy,
      }).onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.userId] });
    }

    const sessionSpecs = ocSessions.length > 0
      ? ocSessions.map((s) => ({
          sessionId: randomUUID(),
          branchName: safeBranch(s.title, s.id),
          opencodeSessionId: s.id,
        }))
      : [{ sessionId: plan.source_sandbox_id, branchName: plan.branch_name, opencodeSessionId: null as string | null }];

    for (const spec of sessionSpecs) {
      await tx.insert(projectSessions).values({
        sessionId: spec.sessionId,
        accountId: plan.account_id,
        projectId: plan.project_id,
        branchName: spec.branchName,
        baseRef: defaultBranch,
        sandboxProvider: 'daytona',
        sandboxId: null,
        sandboxUrl: null,
        opencodeSessionId: spec.opencodeSessionId,
        agentName: 'default',
        status: 'stopped',
        createdBy: grantedBy,
        visibility: 'project',
        metadata: {
          legacy_migration: {
            run_id: ctx.runId,
            source_sandbox_id: plan.source_sandbox_id,
            rehydrate: backupPath ? { bucket_path: backupPath, opencode_session_id: spec.opencodeSessionId } : null,
          },
        },
      }).onConflictDoNothing({ target: projectSessions.sessionId });
    }

    await tx.update(sandboxes).set({
      status: 'archived',
      metadata: {
        ...legacyMeta,
        legacy_migration: { run_id: ctx.runId, project_id: plan.project_id, archived_at: now.toISOString() },
      },
      updatedAt: now,
    }).where(eq(sandboxes.sandboxId, legacy.sandboxId));

    await tx.update(legacySandboxMigrations).set({
      projectId: plan.project_id,
      sessionId: sessionSpecs[0]!.sessionId,
      appliedAt: now,
      progress: { ...ctx.progress, db_committed: true },
      rollback: {
        created_account: createdAccount,
        created_account_member_user_ids: createdMemberUserIds,
        session_ids: sessionSpecs.map((s) => s.sessionId),
        original_sandbox_status: legacy.status,
        original_sandbox_metadata: legacyMeta,
      },
      updatedAt: now,
    }).where(eq(legacySandboxMigrations.migrationId, ctx.migrationId));
  });

  ctx.progress.db_committed = true;
  ctx.log('db: committed', { project_id: plan.project_id, sessions: ocSessions.length || 1 });
}
