#!/usr/bin/env bun
/**
 * Backfill and reconcile repository snapshots.
 *
 * Walks every GitHub-backed project, resolves the revisions that must be
 * prepared, and queues them. Idempotent: enqueueing is deduplicated by
 * (repository id, SHA, format), so re-running only queues what is genuinely
 * missing. The worker does the building; this only decides what to build.
 *
 * Revisions covered per project:
 *   - the default branch tip
 *   - every non-default ref a live session pinned (so a resume finds its base)
 *
 * NOT covered on purpose: history. Archiving every past commit is out of scope.
 *
 * Usage:
 *   cd apps/api
 *   dotenvx run -f .env.local -f .env -- bun run scripts/backfill-repo-snapshots.ts --dry-run
 *   … --limit 200 --project <uuid> --json out.json
 *
 * Flags:
 *   --dry-run        report what would be queued; writes NOTHING, including
 *                    the repository id an unregistered project would gain
 *   --limit <n>      stop after n projects (default: all)
 *   --page <n>       projects per database page (default 100)
 *   --project <uuid> one project only
 *   --requeue-failed reset exhausted rows for the revisions it touches
 *   --json <path>    write the per-project report as JSON
 */
import { writeFileSync } from 'node:fs';
import { projectSessions, projects } from '@kortix/db';
import { and, asc, eq, gt, ne, notInArray } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { getBranchCommitSha, parseGitHubRepoUrl } from '../src/projects/github';
import { withProjectGitAuth } from '../src/projects/lib/git';
import type { ProjectRow } from '../src/projects/lib/serializers';
import {
  ensureRepoSnapshotRepository,
  loadRepoSnapshotRepository,
  withCommit,
} from '../src/repo-snapshots/identity';
import {
  enqueueRepoSnapshot,
  findRepoSnapshot,
  observeRepoRef,
  requeueRepoSnapshot,
} from '../src/repo-snapshots/store';
import { repoSnapshotWorkerEnabled, triggerRepoSnapshotWorker } from '../src/repo-snapshots/worker';

interface Args {
  dryRun: boolean;
  limit: number;
  page: number;
  projectId: string | null;
  requeueFailed: boolean;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const read = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1]! : null;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    limit: Number(read('--limit') ?? 0) || Number.POSITIVE_INFINITY,
    page: Math.max(1, Number(read('--page') ?? 100) || 100),
    projectId: read('--project'),
    requeueFailed: argv.includes('--requeue-failed'),
    json: read('--json'),
  };
}

type ProjectOutcome = {
  projectId: string;
  name: string;
  status: 'queued' | 'already_ready' | 'skipped' | 'error';
  repositoryId?: string;
  refs: Array<{ ref: string; sha: string | null; state: string }>;
  reason?: string;
};

/** Every ref this project needs prepared: the default branch plus live pins. */
async function refsForProject(project: ProjectRow): Promise<string[]> {
  const refs = new Set<string>([project.defaultBranch]);
  // Live sessions only. `project_session_status` has no `deleted` value — the
  // terminal states are `stopped`, `failed` and `completed` — and naming one
  // that does not exist makes Postgres reject the whole query (22P02).
  const rows = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, project.projectId),
        notInArray(projectSessions.status, ['stopped', 'failed', 'completed']),
      ),
    )
    .limit(200);
  for (const row of rows) {
    const baseRef = (row.metadata as Record<string, unknown> | null)?.base_ref;
    if (typeof baseRef === 'string' && baseRef.trim()) refs.add(baseRef.trim());
  }
  return [...refs];
}

async function processProject(project: ProjectRow, args: Args): Promise<ProjectOutcome> {
  const outcome: ProjectOutcome = { projectId: project.projectId, name: project.name, status: 'skipped', refs: [] };
  // A dry run WRITES NOTHING, including here. `ensureRepoSnapshotRepository`
  // persists the repository id it learns, which is a real change to project
  // metadata — and a deployment reviewer reading "--dry-run" has every right to
  // expect the database untouched. So a dry run reads what is already recorded
  // and reports an unregistered project as exactly that, rather than quietly
  // registering it.
  const resolved = args.dryRun
    ? await loadRepoSnapshotRepository(project)
    : await ensureRepoSnapshotRepository(project);
  if (!resolved.repository) {
    outcome.reason = args.dryRun && resolved.githubBacked
      ? `${resolved.unsupportedReason ?? 'unregistered'} (a real run would resolve and record it)`
      : resolved.unsupportedReason ?? 'not GitHub-backed';
    return outcome;
  }
  outcome.repositoryId = resolved.repository.repositoryId;

  let authed: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    authed = await withProjectGitAuth(project);
  } catch (error) {
    outcome.status = 'error';
    outcome.reason = `git auth failed: ${error instanceof Error ? error.message : String(error)}`;
    return outcome;
  }
  const coordinates = parseGitHubRepoUrl(authed.repoUrl) ?? {
    owner: resolved.repository.owner,
    repo: resolved.repository.repo,
  };

  let queued = 0;
  let ready = 0;
  for (const ref of await refsForProject(project)) {
    const branch = ref.replace(/^refs\/heads\//, '');
    try {
      const sha = await getBranchCommitSha({
        owner: coordinates.owner,
        repo: coordinates.repo,
        branch,
        auth: authed.gitAuthToken ? { token: authed.gitAuthToken } : undefined,
      });
      const identity = withCommit(resolved.repository, sha);
      const existing = await findRepoSnapshot(identity);
      if (existing?.status === 'ready') {
        ready += 1;
        outcome.refs.push({ ref, sha, state: 'ready' });
        continue;
      }
      if (args.dryRun) {
        outcome.refs.push({ ref, sha, state: existing ? `would-requeue(${existing.status})` : 'would-queue' });
        queued += 1;
        continue;
      }
      await observeRepoRef({
        identity: resolved.repository,
        ref,
        desiredSha: sha,
        via: 'reconcile',
        reconcileAfter: new Date(Date.now() + 15 * 60_000),
      });
      if (existing?.status === 'failed' && args.requeueFailed) await requeueRepoSnapshot(existing.snapshotId);
      await enqueueRepoSnapshot({ identity, sourceProjectId: project.projectId, sourceRef: ref });
      queued += 1;
      outcome.refs.push({ ref, sha, state: existing ? `requeued(${existing.status})` : 'queued' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.refs.push({ ref, sha: null, state: `error: ${message}` });
      outcome.status = 'error';
      outcome.reason = message;
    }
  }
  if (outcome.status !== 'error') outcome.status = queued > 0 ? 'queued' : ready > 0 ? 'already_ready' : 'skipped';
  return outcome;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!repoSnapshotWorkerEnabled() && !args.dryRun) {
    console.error('KORTIX_REPO_SNAPSHOT_BUCKET is unset — nothing can be published. Use --dry-run to inspect.');
    process.exit(2);
  }
  const outcomes: ProjectOutcome[] = [];
  let cursor = '00000000-0000-0000-0000-000000000000';
  let processed = 0;

  while (processed < args.limit) {
    const page = await db
      .select()
      .from(projects)
      .where(
        args.projectId
          ? eq(projects.projectId, args.projectId)
          : and(ne(projects.status, 'archived'), gt(projects.projectId, cursor)),
      )
      .orderBy(asc(projects.projectId))
      .limit(Math.min(args.page, args.limit - processed));
    if (page.length === 0) break;
    for (const project of page) {
      const outcome = await processProject(project, args);
      outcomes.push(outcome);
      processed += 1;
      const refs = outcome.refs.map((r) => `${r.ref}=${r.state}`).join(' ');
      // The per-ref states already carry any error text, so the summary reason
      // is only appended when it says something they do not.
      const reason = outcome.reason && !refs.includes(outcome.reason) ? ` — ${outcome.reason}` : '';
      console.error(
        `[${outcome.status}] ${project.projectId} ${project.name}` +
          (outcome.repositoryId ? ` repo=${outcome.repositoryId}` : '') +
          (refs ? ` ${refs}` : '') +
          reason,
      );
    }
    cursor = page[page.length - 1]!.projectId;
    if (args.projectId) break;
  }

  const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  console.error(`\nprojects=${outcomes.length} ${JSON.stringify(counts)}`);
  // Skipped projects are listed explicitly, never folded into a success count.
  const skipped = outcomes.filter((o) => o.status === 'skipped' || o.status === 'error');
  if (skipped.length) {
    console.error(`\nnot prepared (${skipped.length}):`);
    for (const o of skipped) console.error(`  ${o.projectId} — ${o.reason ?? 'unknown'}`);
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ dryRun: args.dryRun, counts, outcomes }, null, 2));
    console.error(`\nreport → ${args.json}`);
  }
  if (!args.dryRun) triggerRepoSnapshotWorker();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
