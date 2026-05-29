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
 *   repo:    create the Freestyle managed repo (+ identity/permission) that
 *            becomes the project's durable file home.
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
  sessionSandboxes,
} from '@kortix/db';
import { provisionSessionSandbox } from '../platform/services/session-sandbox';
import {
  createIdentity,
  createManagedRepo,
  freestyleAuthedGitUrl,
  grantRepoPermission,
  isFreestyleGitConfigured,
  mintIdentityToken,
} from './freestyle-git';
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

/** Shell-safe single-quote wrap for embedding a value in a VM command. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeBranch(title: string, id: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${slug || 'session'}-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
}

export interface LegacyOpencodeSession { id: string; title: string }

/**
 * Enumerate the legacy machine's OpenCode conversations. This build stores
 * sessions inside opencode.db (SQLite, no storage/message tree) and sqlite3
 * isn't on the host, so we pull the db (it's small, ~1-5MB incl. WAL) over the
 * toolbox as base64 and read it locally with bun:sqlite. Returns top-level,
 * non-archived sessions newest-first.
 */
async function enumerateOpencodeSessions(ctx: MigrationContext): Promise<LegacyOpencodeSession[]> {
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
    return [];
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
      return rows.map((r) => ({ id: r.id, title: String(r.title).slice(0, 200) }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Thrown by steps whose external wiring is not yet implemented. Distinct type
 *  so we can tell "not built yet" from a genuine runtime failure in logs. */
export class MigrationStepNotImplemented extends Error {
  constructor(phase: string) {
    super(`Migration phase "${phase}" is not yet wired up`);
    this.name = 'MigrationStepNotImplemented';
  }
}

// ── extract ──────────────────────────────────────────────────────────────────
// Back up the legacy VM to durable storage: a tarball of the workspace files
// (node_modules/.git excluded — regenerable / re-pushed via git) plus the full
// OpenCode chat-history store. Also enumerate the OpenCode session ids so the
// `db` phase can create one project_session per real conversation.
//
// Layout inside the bundle (top-level dirs, relied on by rehydrate):
//   workspace/   ← contents of $KORTIX_WORKSPACE
//   opencode/    ← the OpenCode store (opencode.db + storage/message/<id>/...)
export async function extractStep(ctx: MigrationContext): Promise<void> {
  const sandboxId = ctx.legacy.sandboxId;

  // Test-only escape hatch: skip the durable backup upload (e.g. when the
  // operator's storage isn't reachable from the VM, as with a local Supabase).
  // NEVER set this in production — it forgoes chat-history preservation.
  if (process.env.LEGACY_MIGRATION_SKIP_BACKUP === '1') {
    ctx.log('extract: LEGACY_MIGRATION_SKIP_BACKUP=1 — skipping backup upload (TEST ONLY)');
    if (ctx.progress.backup_skipped !== true) await ctx.checkpoint({ backup_skipped: true, backup_path: null });
  } else if (ctx.progress.backup_path && (await backupExists(sandboxId))) {
    // Idempotent: a prior attempt may have finished the upload before crashing.
    ctx.log('extract: backup already present, skipping upload', { path: ctx.progress.backup_path });
  } else {
    const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);
    const target = await createBackupUploadTarget(sandboxId);

    // One shell script on the VM: resolve paths, tar workspace + opencode store,
    // PUT the tarball straight to the signed URL (no Supabase creds on the VM).
    const script = [
      'set -euo pipefail',
      RESOLVE_WS_OC_SH,
      'BUNDLE=/tmp/kortix-migration-bundle.tar.gz',
      // basename of WS becomes "workspace" and of OC becomes "opencode" for the
      // canonical paths; tar stores them as those top-level dirs.
      'tar czf "$BUNDLE" --exclude=node_modules --exclude=.git --warning=no-file-changed' +
        ' -C "$(dirname "$WS")" "$(basename "$WS")"' +
        ' ${OC:+-C "$(dirname "$OC")" "$(basename "$OC")"}',
      `curl -fsS -X PUT -H 'x-upsert: true' -H 'Content-Type: application/octet-stream' --data-binary @"$BUNDLE" ${sq(target.url)}`,
      'rm -f "$BUNDLE"',
      'echo OK',
    ].join('\n');

    ctx.log('extract: backing up VM', { externalId: ctx.legacy.externalId });
    await execOnLegacyVmOrThrow(endpoint, `bash -c ${sq(script)}`, 900);
    await ctx.checkpoint({ backup_path: target.path, backup_bucket_uploaded_at: new Date().toISOString() });
  }

  // Enumerate OpenCode conversations from opencode.db so the db phase can create
  // one project_session per real chat. Empty list → a single default session.
  if (!Array.isArray(ctx.progress.opencode_sessions)) {
    const sessions = await enumerateOpencodeSessions(ctx);
    await ctx.checkpoint({ opencode_sessions: sessions });
    ctx.log('extract: enumerated opencode sessions', { count: sessions.length });
  }
}

// ── repo ─────────────────────────────────────────────────────────────────────
// Provision the Freestyle managed repo that will hold the project's files. Real
// implementation: idempotent on the recorded repo_id.
export async function repoStep(ctx: MigrationContext): Promise<void> {
  if (typeof ctx.progress.repo_id === 'string' && ctx.progress.repo_id) {
    ctx.log('repo: already created, skipping', { repo_id: ctx.progress.repo_id });
    return;
  }

  if (!(await isFreestyleGitConfigured())) {
    throw new Error('Freestyle git is not configured (missing API key); cannot provision project repo');
  }

  const defaultBranch = 'main';
  const repo = await createManagedRepo({ name: ctx.plan.project_name, defaultBranch });
  // Mint a write identity scoped to this repo so the push phase can authenticate.
  const identity = await createIdentity();
  await grantRepoPermission(identity, repo.repoId, 'write');

  await ctx.checkpoint({
    repo_id: repo.repoId,
    git_url: repo.gitUrl,
    git_identity: identity,
    default_branch: repo.defaultBranch ?? defaultBranch,
  });
  ctx.log('repo: created', { repo_id: repo.repoId });
}

// ── push ───────────────────────────────────────────────────────────────────--
// Publish the workspace to the Freestyle repo by running git FROM THE VM (the
// files + git + network are already there; no need to move bytes through the
// backend). Synthesizes kortix.toml / .gitignore / .kortix/Dockerfile if the
// legacy workspace lacked them so the migrated project can build new sessions.
// Idempotent on progress.pushed.
export async function pushStep(ctx: MigrationContext): Promise<void> {
  if (ctx.progress.pushed === true) {
    ctx.log('push: already pushed, skipping');
    return;
  }

  const repoId = ctx.progress.repo_id;
  const identity = ctx.progress.git_identity;
  const defaultBranch = typeof ctx.progress.default_branch === 'string' ? ctx.progress.default_branch : 'main';
  if (typeof repoId !== 'string' || typeof identity !== 'string') {
    throw new Error('push: repo phase did not record repo_id/git_identity');
  }

  // Fresh write token each attempt — tokens are short-lived and not worth
  // persisting/reusing across retries.
  const token = await mintIdentityToken(identity);
  const authedUrl = freestyleAuthedGitUrl(repoId, token);

  const script = [
    'set -euo pipefail',
    'WS="${KORTIX_WORKSPACE:-/workspace}"',
    'cd "$WS"',
    // Minimal manifest with NO [sandbox] section — a freshly migrated project
    // has no project-specific template row, so session boot resolves the shared
    // platform-default template (correct base image + agent). We deliberately do
    // NOT synthesize a Dockerfile: guessing a base produces a broken sandbox.
    `[ -f kortix.toml ] || printf '%s\\n' ${sq('[project]')} ${sq(`name = "${ctx.plan.project_name.replace(/"/g, "'")}"`)} ${sq('description = "Migrated from a legacy Kortix sandbox."')} > kortix.toml`,
    `[ -f .gitignore ] || printf '%s\\n' node_modules .git .kortix/secrets .local '*.log' > .gitignore`,
    'git init -q 2>/dev/null || true',
    `git checkout -B ${sq(defaultBranch)} 2>/dev/null || true`,
    'git add -A',
    `git -c user.email=migrations@kortix.com -c user.name=Kortix commit -q -m ${sq('Import legacy workspace')} || true`,
    `git push --force ${sq(authedUrl)} HEAD:${sq(defaultBranch)}`,
    'echo OK',
  ].join('\n');

  const endpoint = await resolveLegacyVmEndpoint(ctx.legacy);
  ctx.log('push: pushing workspace to Freestyle', { repoId });
  await execOnLegacyVmOrThrow(endpoint, `bash -c ${sq(script)}`, 600);
  await ctx.checkpoint({ pushed: true });
}

// ── db ─────────────────────────────────────────────────────────────────────--
// One transaction: ensure the account + members, create the project (repoUrl =
// the Freestyle repo), project_members, and one project_session per preserved
// OpenCode conversation, then archive the legacy sandbox. Sessions are created
// STOPPED with no live sandbox — opening one in the new app provisions a fresh
// Daytona sandbox from git and rehydrates chat history from the backup bundle.
// The db_committed flag is flipped INSIDE the transaction so a crash/retry never
// double-creates (also belt-and-suspenders onConflictDoNothing on every insert).
export async function dbStep(ctx: MigrationContext): Promise<void> {
  if (ctx.progress.db_committed === true) {
    ctx.log('db: already committed, skipping');
    return;
  }

  const { plan, legacy } = ctx;
  const gitUrl = typeof ctx.progress.git_url === 'string' ? ctx.progress.git_url : null;
  if (!gitUrl) throw new Error('db: repo phase did not record git_url');
  const repoId = typeof ctx.progress.repo_id === 'string' ? ctx.progress.repo_id : null;
  const gitIdentity = typeof ctx.progress.git_identity === 'string' ? ctx.progress.git_identity : null;
  const defaultBranch = typeof ctx.progress.default_branch === 'string' ? ctx.progress.default_branch : 'main';
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
    // 1. Account + members. plan.member_user_ids includes the accountId as a
    // legacy stand-in for the owner — only valid in the old system where
    // account_id == user_id. Filter it out and use the account's REAL members
    // (kortix.account_members) so the actual user, not the account id, owns the
    // migrated project.
    const [existingAccount] = await tx.select().from(accounts).where(eq(accounts.accountId, plan.account_id)).limit(1);
    const createdAccount = !existingAccount;
    if (!existingAccount) {
      await tx.insert(accounts).values({
        accountId: plan.account_id,
        name: `Migrated ${legacy.name || plan.account_id.slice(0, 8)}`,
        personalAccount: true,
      }).onConflictDoNothing({ target: accounts.accountId });
    }

    // Genuine legacy collaborators (from sandbox_members) — real user ids.
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

    // Project members = the account's current members (real users) ∪ legacy
    // collaborators. Owners -> manager, everyone else -> editor.
    const accountMemberRows = await tx.select({ userId: accountMembers.userId, role: accountMembers.accountRole })
      .from(accountMembers).where(eq(accountMembers.accountId, plan.account_id));
    const ownerSet = new Set(accountMemberRows.filter((r) => r.role === 'owner').map((r) => r.userId));
    const projectUserIds = Array.from(new Set([...accountMemberRows.map((r) => r.userId), ...legacyMemberUserIds]));
    const grantedBy = [...ownerSet][0] ?? projectUserIds[0] ?? plan.account_id;

    // 2. Project (repo = Freestyle).
    await tx.insert(projects).values({
      projectId: plan.project_id,
      accountId: plan.account_id,
      name: plan.project_name,
      repoUrl: gitUrl,
      defaultBranch,
      manifestPath: 'kortix.toml',
      status: 'active',
      metadata: {
        legacy_migration: {
          run_id: ctx.runId,
          source_sandbox_id: plan.source_sandbox_id,
          source_provider: legacy.provider,
          backup_path: backupPath,
          migrated_at: now.toISOString(),
        },
      },
    }).onConflictDoNothing({ target: projects.projectId });

    // Persist the Freestyle git connection so resolveProjectGitAuth can mint
    // clone/push tokens later (clone-credential on session boot). Without this,
    // sandboxes hit git.freestyle.sh unauthed and the clone fails.
    if (repoId && gitIdentity) {
      await tx.insert(projectGitConnections).values({
        accountId: plan.account_id,
        projectId: plan.project_id,
        provider: 'freestyle',
        repoUrl: gitUrl,
        externalRepoId: repoId,
        defaultBranch,
        authMethod: 'managed',
        credentialRef: gitIdentity,
        status: 'connected',
      }).onConflictDoNothing({ target: projectGitConnections.projectId });
    }

    for (const userId of projectUserIds) {
      await tx.insert(projectMembers).values({
        accountId: plan.account_id,
        projectId: plan.project_id,
        userId,
        projectRole: ownerSet.has(userId) ? 'manager' : 'editor',
        grantedBy,
      }).onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.userId] });
    }

    // 3. One stopped session per OpenCode conversation (or a single default
    //    session when the VM had no chat store). Each carries a rehydrate ref.
    // sessionId MUST be a UUID v4 — the session API endpoints validate the path
    // param against UUID_V4_REGEX, and session_sandboxes.sandbox_id (= sessionId)
    // is a uuid column. The real OpenCode id lives in opencode_session_id.
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
        // Dormant but listable (the list filters by visibility, not status). A
        // sandbox is provisioned + chat rehydrated on-demand when opened.
        status: 'stopped',
        // Migrated sessions belong to the whole project (the list view filters
        // by visibility; without this they'd be invisible private/no-owner rows).
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

    // 4. Archive the legacy sandbox row.
    await tx.update(sandboxes).set({
      status: 'archived',
      metadata: {
        ...legacyMeta,
        legacy_migration: { run_id: ctx.runId, project_id: plan.project_id, archived_at: now.toISOString() },
      },
      updatedAt: now,
    }).where(eq(sandboxes.sandboxId, legacy.sandboxId));

    // 5. Flip the durable flag + record handles ATOMICALLY with the writes.
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

// ── provision ────────────────────────────────────────────────────────────────
// Spin up a real Daytona sandbox per migrated session and attach it (insert the
// session_sandboxes row). The app's `wake` only RESTARTS an existing paused
// sandbox — it never provisions — so a session with no session_sandboxes row
// can't be opened. provisionSessionSandbox clones the Freestyle repo we pushed
// and boots from the shared platform-default template (the migrated repo has no
// [sandbox] section, so no project-specific template shadows it). Returns once
// the row is inserted; the provider boot continues in the background and the
// dashboard's health poll picks up readiness. Idempotent on progress.provisioned
// and on the per-session session_sandboxes row.
export async function provisionStep(ctx: MigrationContext): Promise<void> {
  if (ctx.progress.provisioned === true) {
    ctx.log('provision: already done, skipping');
    return;
  }

  const gitUrl = typeof ctx.progress.git_url === 'string' ? ctx.progress.git_url : null;
  const identity = typeof ctx.progress.git_identity === 'string' ? ctx.progress.git_identity : null;
  const defaultBranch = typeof ctx.progress.default_branch === 'string' ? ctx.progress.default_branch : 'main';
  if (!gitUrl || !identity) throw new Error('provision: repo phase did not record git_url/git_identity');

  // Attribute the sandbox to an account owner.
  const [owner] = await ctx.database
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, ctx.plan.account_id), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  const ownerUserId = owner?.userId;
  if (!ownerUserId) throw new Error('provision: account has no owner to attribute the sandbox to');

  const sessions = await ctx.database
    .select({ sessionId: projectSessions.sessionId, baseRef: projectSessions.baseRef })
    .from(projectSessions)
    .where(eq(projectSessions.projectId, ctx.plan.project_id));

  for (const session of sessions) {
    const [existing] = await ctx.database
      .select({ sandboxId: sessionSandboxes.sandboxId })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, session.sessionId))
      .limit(1);
    if (existing) {
      ctx.log('provision: sandbox already exists, skipping', { sessionId: session.sessionId });
      continue;
    }

    await ctx.heartbeat();
    await provisionSessionSandbox({
      sandboxId: session.sessionId,
      accountId: ctx.plan.account_id,
      projectId: ctx.plan.project_id,
      userId: ownerUserId,
      provider: 'daytona',
      metadata: { session_id: session.sessionId, project_id: ctx.plan.project_id, legacy_migration: { run_id: ctx.runId } },
      gitProject: {
        projectId: ctx.plan.project_id,
        repoUrl: gitUrl,
        defaultBranch,
        manifestPath: 'kortix.toml',
        gitAuthToken: null,
      },
      resolveGitAuthToken: async () => mintIdentityToken(identity),
      baseRef: session.baseRef ?? defaultBranch,
    });
    ctx.log('provision: kicked sandbox boot', { sessionId: session.sessionId });
  }

  await ctx.checkpoint({ provisioned: true });
}
