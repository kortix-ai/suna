/**
 * Suna migration phases (extract → repo → push → db), driven by
 * suna-migration-runner. Reuses the committed building blocks. Mirrors the
 * legacy-migration-steps inserts.
 *
 * ⚠️ DRAFT — extract/repo are exercised by the standalone script (--build /
 * --push-repo ran on real data), but the `db` phase (project + sessions inserts)
 * and the on-open chat ship have NOT been run end-to-end against a live sandbox.
 * Validate the `db` transaction + that opening a migrated session rehydrates the
 * chat before enabling the button in prod.
 *
 * Resumability note: the bundle is assembled in an ephemeral /tmp dir keyed by
 * migrationId. The durable checkpoints are the REPO (created once, idempotent)
 * and the uploaded opencode archive + the DB rows. A crash before `repo`
 * re-extracts (idempotent: un-archive + tar again).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { projects, projectGitConnections, projectSessions } from '@kortix/db';
import { uploadOpencodeArchive } from '../legacy-migration-storage';
import { extractWorkspace, slugify } from './suna-extract';
import { normalizeAgentpressThread, type AgentpressMessageRow } from './agentpress-mapper';
import { writeConversations, type SessionToWrite } from './opencode-db-writer';
import { pushBundleAsRepo } from './suna-push';
import { Database as Sqlite } from 'bun:sqlite';
import type { SunaMigrationContext } from './suna-migration-runner';

interface SessionSpec { slug: string; title: string; opencodeSessionId: string; messageCount: number; }

function bundlePath(migrationId: string): string {
  return join(tmpdir(), `suna-mig-${migrationId}`);
}

function seedOpencodeSchema(path: string) {
  const d = new Sqlite(path);
  d.exec(`
    CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, time_created INTEGER, time_initialized INTEGER);
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
  `);
  d.close();
}

/** extract: discover the account's Suna projects, pull each sandbox's files into
 *  bundle/legacy/<slug>/, build the N-session opencode.db, capture session ids. */
export async function extractStep(ctx: SunaMigrationContext): Promise<void> {
  const out = bundlePath(ctx.migrationId);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'legacy'), { recursive: true });

  // Window over the account's projects, newest-first: plan.{limit,offset}.
  // Default = latest 25. offset lets a later run grab the next batch (25–50, …).
  const limit = Number(ctx.plan.limit) > 0 ? Number(ctx.plan.limit) : 25;
  const offset = Number(ctx.plan.offset) >= 0 ? Number(ctx.plan.offset) : 0;
  const sunaProjects = (await ctx.database.execute(sql`
    SELECT p.project_id, COALESCE(NULLIF(p.name,''),'Untitled') AS name, r.external_id
    FROM public.projects p
    LEFT JOIN public.resources r ON r.id = p.sandbox_resource_id AND r.type = 'sandbox'
    WHERE p.account_id = ${ctx.accountId} ORDER BY p.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `)) as unknown as Array<{ project_id: string; name: string; external_id: string | null }>;

  const used = new Set<string>();
  const sessions: SessionToWrite[] = [];
  const slugs: string[] = [];
  for (const p of sunaProjects) {
    const threads = (await ctx.database.execute(sql`
      SELECT thread_id FROM public.threads WHERE project_id = ${p.project_id}
    `)) as unknown as Array<{ thread_id: string }>;
    const messages = [];
    for (const t of threads) {
      const rows = (await ctx.database.execute(sql`
        SELECT message_id, type, is_llm_message, content, created_at FROM public.messages
        WHERE thread_id = ${t.thread_id} ORDER BY created_at ASC
      `)) as unknown as AgentpressMessageRow[];
      messages.push(...normalizeAgentpressThread(rows.map((r) => ({ ...r, created_at: String(r.created_at) }))));
    }
    if (!messages.length) continue;

    let slug = slugify(p.name, p.project_id.slice(0, 8));
    if (used.has(slug)) slug = `${slug}-${p.project_id.slice(0, 6)}`;
    used.add(slug);

    const dest = join(out, 'legacy', slug);
    mkdirSync(dest, { recursive: true });
    if (p.external_id) {
      const ex = await extractWorkspace(p.external_id);
      if (ex.tarball) {
        const tmp = join(out, '.tar.gz');
        writeFileSync(tmp, ex.tarball);
        Bun.spawnSync(['tar', 'xzf', tmp, '-C', dest]);
        rmSync(tmp, { force: true });
      }
    }
    sessions.push({ title: p.name.slice(0, 200), messages });
    slugs.push(slug);
    await ctx.heartbeat();
  }

  const dbPath = join(out, 'opencode.db');
  seedOpencodeSchema(dbPath);
  const res = writeConversations(dbPath, `proj_${ctx.migrationId}`, sessions);
  const specs: SessionSpec[] = res.sessionIds.map((s, i) => ({
    slug: slugs[i]!, title: s.title, opencodeSessionId: s.id, messageCount: sessions[i]!.messages.length,
  }));
  await ctx.checkpoint({ bundle_dir: out, sessions: specs });
  ctx.log('extract: bundle built', { sessions: specs.length, parts: res.parts });
}

/** repo: create ONE managed repo, push the bundle, upload the opencode.db so the
 *  on-open rehydrate can ship it (keyed by the new projectId). */
export async function repoStep(ctx: SunaMigrationContext): Promise<void> {
  if (typeof ctx.progress.project_id === 'string') { ctx.log('repo: already done'); return; }
  const out = bundlePath(ctx.migrationId);
  const repo = await pushBundleAsRepo(ctx.accountId, out);

  // opencode.db was moved aside by pushBundleAsRepo → tar it in the legacy
  // archive format and upload keyed by projectId; on-open rehydrate downloads it.
  const dbAside = join(tmpdir(), `${repo.projectId}.opencode.db`);
  const tar = Bun.spawnSync(['tar', 'czf', '-', '-C', tmpdir(), `${repo.projectId}.opencode.db`]);
  if (tar.exitCode === 0) await uploadOpencodeArchive(repo.projectId, Buffer.from(tar.stdout));
  rmSync(dbAside, { force: true });

  await ctx.checkpoint({
    project_id: repo.projectId, repo_url: repo.upstreamUrl, repo_owner: repo.repoOwner,
    repo_name: repo.repoName, default_branch: repo.defaultBranch, provider: repo.provider,
    external_repo_id: repo.externalRepoId, installation_id: repo.installationId, credential_ref: repo.credentialRef,
  });
  ctx.log('repo: pushed + opencode archive uploaded', { repo: repo.upstreamUrl });
}

/** push: folded into repo (kept as a no-op phase to match PHASE_ORDER). */
export async function pushStep(_ctx: SunaMigrationContext): Promise<void> {}

/** db: create the project + git connection + N dormant sessions, each pinned to
 *  its opencode session id + the uploaded archive for on-open rehydrate.
 *  ⚠️ DRAFT — mirrors legacy dbStep; validate the inserts + the on-open ship. */
export async function dbStep(ctx: SunaMigrationContext): Promise<void> {
  if (ctx.progress.db_committed === true) { ctx.log('db: already committed'); return; }
  const projectId = ctx.progress.project_id as string;
  const repoUrl = ctx.progress.repo_url as string;
  const defaultBranch = (ctx.progress.default_branch as string) ?? 'main';
  const provider = (ctx.progress.provider as string) ?? 'github';
  const specs = (ctx.progress.sessions as SessionSpec[]) ?? [];
  const now = new Date();

  await (ctx.database as any).transaction(async (tx: any) => {
    await tx.insert(projects).values({
      projectId, accountId: ctx.accountId, name: 'Legacy (Suna) projects',
      repoUrl, defaultBranch, manifestPath: 'kortix.toml', status: 'active',
      metadata: {
        git: { url: repoUrl, upstream_url: repoUrl, default_branch: defaultBranch, provider, managed: true,
               owner: ctx.progress.repo_owner, name: ctx.progress.repo_name },
        suna_migration: { run_id: ctx.runId, migrated_at: now.toISOString(), sessions: specs.length },
      },
    }).onConflictDoNothing({ target: projects.projectId });

    await tx.insert(projectGitConnections).values({
      accountId: ctx.accountId, projectId, provider, repoUrl, upstreamUrl: repoUrl, managed: true,
      repoOwner: ctx.progress.repo_owner as string, repoName: ctx.progress.repo_name as string,
      externalRepoId: (ctx.progress.external_repo_id as string) ?? null,
      defaultBranch,
      authMethod: provider === 'github' ? 'github_app' : 'managed',
      installationId: (ctx.progress.installation_id as string) ?? null,
      credentialRef: (ctx.progress.credential_ref as string) ?? null,
      visibility: 'private',
      status: 'connected',
    } as any).onConflictDoNothing({ target: projectGitConnections.projectId });

    for (const s of specs) {
      await tx.insert(projectSessions).values({
        sessionId: crypto.randomUUID(), accountId: ctx.accountId, projectId,
        branchName: `migrated/${s.slug}`, baseRef: defaultBranch, sandboxProvider: 'daytona',
        sandboxId: null, sandboxUrl: null, opencodeSessionId: s.opencodeSessionId,
        agentName: 'default', status: 'stopped', createdBy: ctx.accountId, visibility: 'project',
        metadata: {
          legacy_migration: {
            run_id: ctx.runId,
            // Reuse the legacy on-open ship: archive is keyed by projectId.
            source_sandbox_id: projectId,
            rehydrate: { opencode_session_id: s.opencodeSessionId },
          },
        },
      } as any).onConflictDoNothing({ target: projectSessions.sessionId });
    }
  });

  rmSync(bundlePath(ctx.migrationId), { recursive: true, force: true });
  await ctx.checkpoint({ db_committed: true });
  ctx.log('db: committed', { project_id: projectId, sessions: specs.length });
}
