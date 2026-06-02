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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { buildStarterFiles } from './starter';
import { uploadOpencodeArchive } from './legacy-migration-storage';
import {
  execOnLegacyVm,
  execOnLegacyVmOrThrow,
  RESOLVE_WS_OC_SH,
  resolveLegacyVmEndpoint,
  type LegacyVmEndpoint,
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
  if (!Array.isArray(ctx.progress.opencode_sessions)) {
    const { sessions, archiveB64 } = await enumerateOpencodeSessions(ctx);
    let archivePath: string | null = null;
    if (archiveB64) {
      archivePath = await uploadOpencodeArchive(ctx.legacy.sandboxId, Buffer.from(archiveB64, 'base64'));
    }
    await ctx.checkpoint({ opencode_sessions: sessions, opencode_archive_path: archivePath });
    ctx.log('extract: enumerated opencode sessions', { count: sessions.length, archived_to: archivePath ?? 'none' });
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

const STARTER_TEMPLATE = 'general-knowledge-worker';
const STARTER_REMOTE_B64 = '/tmp/kortix-starter.tar.gz.b64';
const STARTER_B64_CHUNK = 96 * 1024;

function buildStarterTarB64(projectName: string, repoFullName?: string): string {
  const files = buildStarterFiles({ projectName, repoFullName, template: STARTER_TEMPLATE });
  const dir = mkdtempSync(join(tmpdir(), 'kortix-starter-'));
  try {
    for (const f of files) {
      const full = join(dir, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.content);
    }
    const tar = Bun.spawnSync(['tar', 'czf', '-', '-C', dir, '.']);
    if (tar.exitCode !== 0) {
      throw new Error(`starter: tar failed: ${new TextDecoder().decode(tar.stderr)}`);
    }
    return Buffer.from(tar.stdout).toString('base64');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function shipStarterToVm(
  ctx: MigrationContext,
  endpoint: LegacyVmEndpoint,
  b64: string,
): Promise<void> {
  const total = Math.ceil(b64.length / STARTER_B64_CHUNK);
  for (let n = 0; n * STARTER_B64_CHUNK < b64.length; n++) {
    const chunk = b64.slice(n * STARTER_B64_CHUNK, (n + 1) * STARTER_B64_CHUNK);
    const op = n === 0 ? '>' : '>>';
    await execOnLegacyVmOrThrow(
      endpoint,
      `bash -c ${sq(`printf %s '${chunk}' ${op} ${STARTER_REMOTE_B64}`)}`,
      60,
    );
    await ctx.heartbeat();
  }
  ctx.log('push: shipped starter base config to VM', { bytes_b64: b64.length, chunks: total });
}
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

  const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);

  const repoFullName = ref.repoOwner && ref.repoName ? `${ref.repoOwner}/${ref.repoName}` : undefined;
  await shipStarterToVm(ctx, endpoint, buildStarterTarB64(ctx.plan.project_name, repoFullName));

  const script = [
    'set -euo pipefail',
    RESOLVE_WS_OC_SH,
    'cd "$WS"',
    'export HOME="$(mktemp -d)"',
    `git config --global --add safe.directory ${sq('*')}`,
    'rm -rf .kortix/opencode kortix.toml',
    '__ST="$(mktemp -d)"',
    `base64 -d ${sq(STARTER_REMOTE_B64)} | tar xzf - -C "$__ST"`,
    'cp -a -n "$__ST"/. .',
    `rm -rf "$__ST" ${sq(STARTER_REMOTE_B64)}`,
    `printf '%s\\n' ${excludeLine} > .gitignore`,
    'rm -rf .git',
    // Strip EMBEDDED git repos (a nested .git anywhere in the tree — a cloned
    // sub-project). Left in place, `git add -A` records them as submodule
    // gitlinks and their file contents are silently dropped from the migrated
    // repo. Removing the inner .git flattens them into ordinary files so the
    // user's work is actually preserved.
    'find . -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true',
    'git init -q',
    `printf '%s\\n' ${excludeLine} > .git/info/exclude`,
    // GitHub HARD-rejects any file >100MB, which aborts the whole push (exit 1)
    // and dead-letters the migration. Exclude such files (leave them on disk,
    // just don't track them) so the push succeeds; log each so the drop is never
    // silent. Skip dirs already excluded above to avoid noise/wasted walking.
    "find . -type f -size +100M -not -path './.git/*' -not -path './.persistent-system/*' -not -path './node_modules/*' -not -path './.cache/*' -printf '%P\\n' 2>/dev/null | while IFS= read -r f; do printf '%s\\n' \"$f\" >> .git/info/exclude; echo \"push: excluding >100MB file (GitHub limit): $f\"; done || true",
    `git checkout -qB ${sq(defaultBranch)}`,
    'git add -A',
    `git -c user.email=migrations@kortix.com -c user.name=Kortix commit -q --allow-empty -m ${sq('Import legacy workspace')}`,
    `git push --force ${sq(authedUrl)} HEAD:${sq(defaultBranch)}`,
    'echo "PUSH_OK files=$(git ls-files | wc -l) bytes=$(git ls-files -z | du -ch --files0-from=- 2>/dev/null | tail -1 | cut -f1)"',
  ].join('\n');

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
