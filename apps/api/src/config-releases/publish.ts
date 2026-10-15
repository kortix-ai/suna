/**
 * Published releases: the config is ready before any box asks for it.
 *
 * When a base ref moves, the API builds the `project` release of the new tip
 * once, writes its descriptor next to the archive in the config archive store,
 * and records both in `config_release_heads`. Session create reads that row and
 * puts signed URLs in the box env (`KORTIX_CONFIG_RELEASE`). A booting box then
 * downloads its config from the store and asks the API nothing.
 *
 * Triggers. Each one is a no-op when the row already names the tip:
 *   - `notifyBaseBranchMoved`: a push through the git proxy, an API write, a
 *     change-request merge, a manifest write, a repository replacement.
 *   - the descriptor route, after it resolved the tip for a box: a push made
 *     directly on the upstream reaches the API only there.
 *   - session create, when the row names a commit other than the tip it read.
 *
 * The row can be one commit behind while a publish runs. A session created
 * then boots on the previous release, and convergence moves it to the new one.
 * Anything the row cannot answer exactly as the descriptor route would (an
 * agent the release does not declare, a quarantined release, a store a box
 * cannot reach) gives no env value, and the box asks the route as before.
 */

import { configReleaseHeads, projects } from '@kortix/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { config } from '../config';
import { logger } from '../lib/logger';
import type { GitBackedProject } from '../projects/surface';
import { db } from '../shared/db';
import { bumpBounded } from '../shared/ttl-memo';
import { loadAgentRosterAtCommit } from './agent-roster';
import { buildConfigRelease, CONFIG_RELEASE_FORMAT_V3, toDescriptor, type ConfigRelease } from './builder';
import { dbConfigReleaseLedger, PROJECT_QUARANTINE_SESSIONS, type ConfigReleaseLedger } from './quarantine';
import { publicDownloadTarget } from './serve-archive';
import { resolveSessionReleaseAgent, type DeclaredAgentRoster } from './session-agent';
import {
  CONFIG_ARCHIVE_URL_TTL_SECONDS,
  configArchiveKey,
  configReleaseDescriptorKey,
  getConfigArchiveStore,
  type ConfigArchiveStore,
} from './store';

/**
 * A row older than this is published again, and session create gives no env
 * value from it. The bucket lifecycle expires objects at 30 days.
 */
export const REPUBLISH_AFTER_MS = 20 * 24 * 60 * 60 * 1000;

const HEX40 = /^[0-9a-f]{40}$/;

export type HeadRow = typeof configReleaseHeads.$inferSelect;

export interface PublishDeps {
  build: (project: GitBackedProject, commit: string) => Promise<ConfigRelease>;
  roster: (project: GitBackedProject, commit: string) => Promise<DeclaredAgentRoster>;
  resolveTip: (project: GitBackedProject, ref: string) => Promise<string>;
  store: () => ConfigArchiveStore;
  ledger: Pick<ConfigReleaseLedger, 'recordAssigned' | 'quarantined'>;
  now: () => Date;
  /** Start a background publish (`schedulePublish`). */
  schedule: (projectId: string, ref: string, commit: string | null) => void;
}

const defaultDeps: PublishDeps = {
  build: (project, commit) => buildConfigRelease(project, commit, 'project'),
  roster: loadAgentRosterAtCommit,
  // Loaded on first use: projects/surface reaches session code that imports the sandbox
  // proxy root, which reaches back here through session-open (an import cycle).
  resolveTip: async (project, ref) => (await import('../projects/surface')).resolveCommitSha(project, ref),
  store: getConfigArchiveStore,
  ledger: dbConfigReleaseLedger,
  now: () => new Date(),
  schedule: (projectId, ref, commit) => schedulePublish(projectId, ref, commit),
};

export async function readReleaseHead(projectId: string, ref: string): Promise<HeadRow | null> {
  const [row] = await db
    .select()
    .from(configReleaseHeads)
    .where(and(eq(configReleaseHeads.projectId, projectId), eq(configReleaseHeads.ref, ref)))
    .limit(1);
  return row ?? null;
}

function fresh(head: HeadRow, now: Date): boolean {
  return now.getTime() - head.publishedAt.getTime() < REPUBLISH_AFTER_MS;
}

/**
 * Publish the `project` release of `ref`'s tip (`commit`, or resolved here).
 * Returns what happened. Throws only on a git, store or database error.
 */
export async function publishConfigRelease(
  project: GitBackedProject,
  ref: string,
  commit: string | null,
  deps: PublishDeps = defaultDeps,
): Promise<'published' | 'current' | 'unpublishable'> {
  const resolvedAt = deps.now();
  const tip = commit ?? (await deps.resolveTip(project, ref));
  const head = await readReleaseHead(project.projectId, ref);
  if (head && head.sourceCommit === tip && fresh(head, resolvedAt)) return 'current';

  // `toDescriptor` with repository access, exactly as the route answers a box.
  const descriptor = toDescriptor(await deps.build(project, tip), { repositoryAccess: true, format: CONFIG_RELEASE_FORMAT_V3 });
  // No release, no archive (a tree over the archive cap), or no files: the box asks the route.
  if (!descriptor.release_id || !descriptor.archive || !descriptor.files || !descriptor.config_tree_id) {
    logger.info('[config-releases] tip not published', { projectId: project.projectId, ref, commit: tip, reason: descriptor.reason });
    return 'unpublishable';
  }
  const roster = await deps.roster(project, tip);
  const descriptorKey = configReleaseDescriptorKey(project.projectId, tip, resolvedAt);
  await deps.store().putIfAbsent(descriptorKey, Buffer.from(JSON.stringify(descriptor)), 'application/json');
  // The ledger row a box's proof updates (`recordProof`); the route writes it when it assigns.
  await deps.ledger.recordAssigned({
    projectId: project.projectId,
    releaseId: descriptor.release_id,
    variant: 'project',
    sourceCommit: tip,
  });
  const row = {
    projectId: project.projectId,
    ref,
    releaseId: descriptor.release_id,
    sourceCommit: tip,
    configTreeId: descriptor.config_tree_id,
    descriptorKey,
    roster: {
      enabled: [...roster.enabled],
      defaultAgent: roster.defaultAgent,
      readable: roster.readable,
      governed: roster.governed,
      ...(roster.onlyDeclared ? { onlyDeclared: true } : {}),
    },
    resolvedAt,
    publishedAt: resolvedAt,
  };
  await db
    .insert(configReleaseHeads)
    .values(row)
    .onConflictDoUpdate({
      target: [configReleaseHeads.projectId, configReleaseHeads.ref],
      set: { ...row },
      // A slower publish of an older tip never replaces a newer one.
      setWhere: lt(configReleaseHeads.resolvedAt, sql`excluded.resolved_at`),
    });
  logger.info('[config-releases] published', { projectId: project.projectId, ref, commit: tip, releaseId: descriptor.release_id });
  return 'published';
}

// replica-local: one publish per (project, ref) at a time in this process; a trigger during it runs one more.
const running = new Map<string, { again: string | null | undefined }>();

/**
 * Publish in the background. Never throws, never waits. A trigger that arrives
 * while a publish of the same ref runs makes it run once more afterwards.
 */
export function schedulePublish(projectId: string, ref: string, commit: string | null = null): void {
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
        const project = await loadPublishProject(projectId);
        if (project) await publishConfigRelease(project, ref, next);
      } catch (error) {
        // Drizzle wraps the driver error: its `cause` holds what Postgres said.
        const cause = (error as { cause?: Error }).cause?.message;
        logger.warn('[config-releases] publish failed', { projectId, ref, error: (error as Error).message.split('\n')[0], cause });
      }
      next = state.again;
    }
    running.delete(key);
  })();
}

async function loadPublishProject(projectId: string): Promise<GitBackedProject | null> {
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
  return {
    projectId: row.projectId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    manifestPath: row.manifestPath ?? 'kortix.yaml',
    gitAuthToken: null,
  };
}

// replica-local: the tip this process last saw published per (project, ref), so a hot route reads no row.
const seenTips = new Map<string, string>();

/**
 * The descriptor route resolved `tip` for a box. Publish it unless this
 * process already saw that tip published. A push made directly on the
 * upstream reaches the API only through such a read.
 */
export function notePublishedTip(projectId: string, ref: string, tip: string): void {
  const key = `${projectId}\0${ref}`;
  if (seenTips.get(key) === tip) return;
  bumpBounded(seenTips, key, tip, 10_000);
  schedulePublish(projectId, ref, tip);
}

/** What the box reads from `KORTIX_CONFIG_RELEASE` (base64 of this JSON). */
export interface PublishedReleaseEnv {
  release_id: string;
  source_commit: string;
  descriptor_url: string;
  archive_url: string;
  expires_at: string;
}

/**
 * The `KORTIX_CONFIG_RELEASE` value for a session that runs the `project`
 * variant, or null when the box must ask the descriptor route. `tip` is the
 * base tip session create resolved, when it has one: a row on another commit
 * still serves, and a publish of the tip starts.
 */
export async function configReleaseEnvForSession(
  input: { projectId: string; ref: string; agentName: string | null; tip: string | null },
  deps: Pick<PublishDeps, 'store' | 'ledger' | 'now' | 'schedule'> = defaultDeps,
): Promise<string | null> {
  const head = await readReleaseHead(input.projectId, input.ref);
  const tip = input.tip && HEX40.test(input.tip) ? input.tip : null;
  if (!head || (tip && head.sourceCommit !== tip)) deps.schedule(input.projectId, input.ref, tip);
  if (!head) return null;
  const now = deps.now();
  if (!fresh(head, now)) {
    deps.schedule(input.projectId, input.ref, tip);
    return null;
  }
  // The route re-points a session whose agent the release does not declare. Only the route does.
  if (resolveSessionReleaseAgent(input.agentName, head.roster).kind !== 'declared') return null;
  const quarantined = await deps.ledger.quarantined(input.projectId, [head.releaseId], PROJECT_QUARANTINE_SESSIONS);
  if (quarantined.size > 0) return null;

  const store = deps.store();
  const [descriptorSigned, archiveSigned] = await Promise.all([
    store.signedUrl(head.descriptorKey, CONFIG_ARCHIVE_URL_TTL_SECONDS),
    store.signedUrl(configArchiveKey(input.projectId, head.configTreeId), CONFIG_ARCHIVE_URL_TTL_SECONDS),
  ]);
  // A store a cloud box cannot reach (local Supabase): the route streams through the API instead.
  const descriptorUrl = publicDownloadTarget(descriptorSigned, config.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL);
  const archiveUrl = publicDownloadTarget(archiveSigned, config.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL);
  if (!descriptorUrl || !archiveUrl) return null;
  const env: PublishedReleaseEnv = {
    release_id: head.releaseId,
    source_commit: head.sourceCommit,
    descriptor_url: descriptorUrl,
    archive_url: archiveUrl,
    expires_at: new Date(now.getTime() + CONFIG_ARCHIVE_URL_TTL_SECONDS * 1000).toISOString(),
  };
  return Buffer.from(JSON.stringify(env)).toString('base64');
}
