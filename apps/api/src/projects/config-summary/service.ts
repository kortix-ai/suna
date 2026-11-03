/**
 * Saved project config summaries: what `GET /projects/:id/detail` serves,
 * built once per (project, ref) when the ref moves, so a page view runs no git.
 *
 * Why (2026-11-03): `/detail` built the summary from git on every view, on
 * every API process: 90 git processes on a warm store, and up to 55 fetches
 * from the host on a cold one (a new process, a deploy, a cache eviction). An
 * internal project with 8 imports and 45 skills answered `503
 * request_deadline` after 25 s. The summary depends only on the commit, and a
 * commit moves far less often than people open the page.
 *
 * - The row holds the repository-derived summary (`loadRepoConfigSummary`)
 *   and the file paths at `source_commit`. Per-user filtering and the Kortix
 *   skills are applied by the reader, never stored.
 * - Builds run in the background (`scheduleConfigSummary`), one at a time per
 *   (project, ref) per process. Triggers: every base move (`schedulePublish`)
 *   and a `/detail` read whose row names a commit behind the shared tip.
 * - A failed build keeps the last row. An older build never replaces a newer
 *   one (`resolved_at`).
 * - A row of another `format` reads as absent and is rebuilt: bump
 *   `CONFIG_SUMMARY_FORMAT` whenever `loadRepoConfigSummary` output changes shape
 *   or meaning.
 */

import { projectConfigSummaries, projects } from '@kortix/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { bumpBounded } from '../../shared/ttl-memo';
import { readGitHealth } from '../../shared/repository-health';
import { loadRepoConfigSummary, withKortixSkills } from '../git/config';
import { listRepoFiles } from '../git/files';
import { refreshMirror } from '../git/mirror';
import { resolveRefSha } from '../git/read-cache';
import type { GitBackedProject, ProjectConfigSummary, ProjectFileEntry } from '../git/types';
import { getProjectGitConnection } from '../lib/git';

/** The shape version of a saved summary. A row of any other format is rebuilt. */
export const CONFIG_SUMMARY_FORMAT = 1;
/** File paths stored per summary. Past it the reader lists the files from git. */
export const CONFIG_SUMMARY_MAX_FILES = 50_000;

export interface SavedConfigSummary {
  sourceCommit: string;
  config: ProjectConfigSummary;
  /** Every file at `sourceCommit` when `filesComplete`, else the first `CONFIG_SUMMARY_MAX_FILES`. */
  files: ProjectFileEntry[];
  fileCount: number;
  filesComplete: boolean;
}

/** The saved summary of `ref`, or null when none is saved in the current format. */
export async function readConfigSummary(projectId: string, ref: string): Promise<SavedConfigSummary | null> {
  const [row] = await db
    .select()
    .from(projectConfigSummaries)
    .where(and(eq(projectConfigSummaries.projectId, projectId), eq(projectConfigSummaries.ref, ref)))
    .limit(1);
  if (!row || row.format !== CONFIG_SUMMARY_FORMAT) return null;
  return {
    sourceCommit: row.sourceCommit,
    config: row.config as unknown as ProjectConfigSummary,
    files: row.files.map((path) => ({ path, type: 'file' as const, size: null })),
    fileCount: row.fileCount,
    filesComplete: row.filesComplete,
  };
}

/**
 * The saved summary a read may serve, or null. Database reads only: no
 * credential, no git.
 *
 * - None while the stored connection state says the repository is
 *   disconnected, so the read reports the cause the live path reports.
 * - None unless the shared tip proof (`base_tip_checks`) names the row's
 *   commit. Every base move clears the proof (`expireBaseTips`), so a read
 *   after a write never serves the summary from before it: it reads git live,
 *   as before, while the rebuild runs. A push made directly on the host is
 *   seen within one tip-check interval.
 */
export async function readServableConfigSummary(projectId: string, ref: string): Promise<SavedConfigSummary | null> {
  const { storedBaseTipProof } = await import('../../config-releases/base-tip');
  const [connection, saved, proof] = await Promise.all([
    getProjectGitConnection(projectId),
    readConfigSummary(projectId, ref),
    storedBaseTipProof(projectId, ref),
  ]);
  if (readGitHealth(connection) || !saved || proof?.tip !== saved.sourceCommit) return null;
  return saved;
}

/**
 * The project's config from its saved summary, as `loadProjectConfig` returns it
 * (Kortix skills included), or null when no row may be served: the caller then
 * reads git as before. Every call also checks the tip behind the response and
 * rebuilds the row when it moved. Database reads only; never throws.
 *
 * Every hot reader of the default branch's config goes through this: /detail,
 * the secrets route, the resource-grant config, the Slack agent picker.
 */
export async function savedProjectConfig(project: GitBackedProject): Promise<SavedConfigSummary | null> {
  const ref = project.defaultBranch;
  const saved = await readServableConfigSummary(project.projectId, ref).catch(() => null);
  refreshConfigSummaryIfMoved(project, ref, saved?.sourceCommit ?? null);
  return saved ? { ...saved, config: withKortixSkills(saved.config) } : null;
}

/**
 * Build and save the summary of `ref` at `commit` (or at `ref`'s tip in this
 * process's store). `current` when the saved row already names that commit.
 * Throws on a git or database error; the saved row stays.
 */
export async function buildConfigSummary(
  project: GitBackedProject,
  ref: string,
  commit: string | null = null,
): Promise<'built' | 'current' | 'unresolvable'> {
  const resolvedAt = new Date();
  const tip = commit ?? (await resolveRefSha(await refreshMirror(project, false, { freshRef: ref }), ref));
  if (!tip) return 'unresolvable';
  const saved = await readConfigSummary(project.projectId, ref);
  if (saved?.sourceCommit === tip) return 'current';

  const files = await listRepoFiles(project, tip);
  const config = await loadRepoConfigSummary(project, files, tip);
  const paths = files.map((file) => file.path);
  const row = {
    projectId: project.projectId,
    ref,
    sourceCommit: tip,
    format: CONFIG_SUMMARY_FORMAT,
    config: config as unknown as Record<string, unknown>,
    files: paths.slice(0, CONFIG_SUMMARY_MAX_FILES),
    fileCount: paths.length,
    filesComplete: paths.length <= CONFIG_SUMMARY_MAX_FILES,
    resolvedAt,
    builtAt: new Date(),
  };
  await db
    .insert(projectConfigSummaries)
    .values(row)
    .onConflictDoUpdate({
      target: [projectConfigSummaries.projectId, projectConfigSummaries.ref],
      set: { ...row },
      // A slower build of an older tip never replaces a newer one.
      setWhere: lt(projectConfigSummaries.resolvedAt, sql`excluded.resolved_at`),
    });
  return 'built';
}

// replica-local: one build per (project, ref) at a time in this process; a trigger during it runs one more.
const running = new Map<string, { again: string | null | undefined }>();

/**
 * Build in the background. Never throws, never waits. A trigger that arrives
 * while a build of the same ref runs makes it run once more afterwards.
 * `project` saves the row read when the caller already holds it.
 */
export function scheduleConfigSummary(
  projectId: string,
  ref: string,
  commit: string | null = null,
  project: GitBackedProject | null = null,
): void {
  const key = `${projectId}\0${ref}`;
  const busy = running.get(key);
  if (busy) {
    busy.again = commit;
    return;
  }
  const state: { again: string | null | undefined } = { again: undefined };
  running.set(key, state);
  void (async () => {
    let next: string | null | undefined = commit;
    while (next !== undefined) {
      state.again = undefined;
      try {
        const target = project ?? (await loadSummaryProject(projectId));
        if (target) {
          const started = Date.now();
          const result = await buildConfigSummary(target, ref, next);
          if (result === 'built') logger.info('[config-summary] built', { projectId, ref, ms: Date.now() - started });
        }
      } catch (error) {
        const cause = (error as { cause?: Error }).cause?.message;
        logger.warn('[config-summary] build failed', { projectId, ref, error: (error as Error).message.split('\n')[0], cause });
      }
      next = state.again;
    }
    running.delete(key);
  })();
}

/** A process checks one ref's tip for the saved summary at most this often. */
const TIP_CHECK_THROTTLE_MS = 15_000;
// replica-local: when this process last checked a (project, ref) tip for its saved summary.
const lastTipCheck = new Map<string, number>();

/**
 * After a read: ask for `ref`'s tip (`sharedBaseTip`: one upstream ask per
 * interval across every API process, and the proof the next read checks) and
 * rebuild when it is not `savedCommit`. Never throws, never waits.
 */
export function refreshConfigSummaryIfMoved(
  project: GitBackedProject,
  ref: string,
  savedCommit: string | null,
  now = Date.now(),
): void {
  const key = `${project.projectId}\0${ref}`;
  if (now - (lastTipCheck.get(key) ?? 0) < TIP_CHECK_THROTTLE_MS) return;
  bumpBounded(lastTipCheck, key, now, 10_000);
  void (async () => {
    const { sharedBaseTip } = await import('../../config-releases/base-tip');
    const tip = await sharedBaseTip(project, ref);
    if (tip !== savedCommit) scheduleConfigSummary(project.projectId, ref, tip, project);
  })().catch((error: unknown) => {
    logger.warn('[config-summary] tip check failed', {
      projectId: project.projectId,
      ref,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    });
  });
}

async function loadSummaryProject(projectId: string): Promise<GitBackedProject | null> {
  const [row] = await db
    .select({
      projectId: projects.projectId,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      manifestPath: projects.manifestPath,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!row || row.status === 'archived' || !row.repoUrl) return null;
  // No token: the store resolves the project's credential itself (`ensureMirrorAccess`).
  return {
    projectId: row.projectId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    manifestPath: row.manifestPath ?? 'kortix.yaml',
    gitAuthToken: null,
  };
}
