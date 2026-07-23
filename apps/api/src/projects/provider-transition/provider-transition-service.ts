/**
 * Public entrypoints for the provider-migration workflow + the wiring that binds
 * the injectable runner to the REAL builder / provider / git / db. Routes, the
 * resume worker, and the prebuild script all go through here.
 */
import { eq } from 'drizzle-orm';
import { projects, type Database } from '@kortix/db';
import { db as appDb } from '../../shared/db';
import { getSandboxProvider } from '../../snapshots/providers';
import {
  DEFAULT_SANDBOX_SLUG,
  ensurePerProjectWarmImage,
  resolveCommitSha,
} from '../../snapshots/builder';
import { resolveTemplateBySlug, computeTemplateIdentity } from '../../snapshots/templates';
import { perProjectWarmImageName } from '../../snapshots/ppwarm-names';
import { config } from '../../config';
import type { GitBackedProject } from '../git/types';
import {
  driveProviderTransition,
  type ResolvedPrepIdentity,
  type TransitionDeps,
} from './provider-transition-runner';
import {
  setPinWithGenerationBump,
  insertPrebuildTransition,
  listTransitionsForProject,
  readActiveRouting,
  reserveSwitchTransition,
  type ProviderTransitionRow,
} from './provider-transition-store';
import {
  classifyProviderSwitch,
  normalizeTargetProvider,
  preparationLabel,
  type PrepIdentity,
  type ProviderTransitionStatus,
} from './provider-transition-core';
import { emitProviderTransitionEvent } from './provider-transition-metrics';
import { logger } from '../../lib/logger';

type ProjectRow = typeof projects.$inferSelect;

function toGitBackedProject(row: ProjectRow): GitBackedProject & { accountId: string } {
  return {
    projectId: row.projectId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    manifestPath: row.manifestPath,
    accountId: row.accountId,
  };
}

/** Resolve the current prep identity: default-branch tip + shared-default base
 *  runtime fingerprint on the target + the resulting ppwarm image name. This is
 *  EXACTLY the name ensureSandboxImage's session-start warm lookup computes, so a
 *  ready transition guarantees the first session warm-HITs (no clone). */
export async function resolvePrepIdentity(
  project: GitBackedProject,
  targetProvider: string,
): Promise<ResolvedPrepIdentity> {
  const template = await resolveTemplateBySlug(project, DEFAULT_SANDBOX_SLUG);
  const baseIdentity = await computeTemplateIdentity(project, template);
  const commitSha = await resolveCommitSha(project, project.defaultBranch);
  const snapshotName = perProjectWarmImageName(project.projectId, commitSha, baseIdentity.snapshotName);
  return { commitSha, baseRuntimeIdentity: baseIdentity.snapshotName, snapshotName };
}

/** Bind the runner to real collaborators. `kick` re-drives fork/adopt rows. */
export function defaultTransitionDeps(database: Database = appDb): TransitionDeps {
  return {
    db: database,
    now: () => new Date(),
    getProvider: (id) => getSandboxProvider(id),
    ensureWarmImage: async (project, opts) => {
      const r = await ensurePerProjectWarmImage(project, {
        provider: opts.provider,
        accountId: opts.accountId,
        source: 'background',
        // Renew the lease during the (up to ~12-min) provider build wait so a long
        // build never lets the 10-min TTL lapse into a double-drive.
        heartbeat: opts.heartbeat,
      });
      // FIX-B: surface the build-proven external template id so the runner pins it.
      return { snapshotName: r.snapshotName, built: r.built, externalTemplateId: r.externalTemplateId ?? null };
    },
    resolvePrepIdentity,
    loadProject: async (projectId) => {
      const [row] = await database.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
      if (!row || row.status === 'archived') return null;
      return toGitBackedProject(row);
    },
    kick: (transitionId) => kickDrive(transitionId, database),
  };
}

/** Fire-and-forget drive (never throws into the caller). */
export function kickDrive(transitionId: string, database: Database = appDb): void {
  void driveProviderTransition(defaultTransitionDeps(database), transitionId).catch((err) =>
    logger.error('[provider-transition] drive failed', {
      transitionId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

export interface PreparationView {
  transition_id: string | null;
  project_id: string;
  status: ProviderTransitionStatus | 'noop' | 'cleared';
  source_provider: string | null;
  target_provider: string | null;
  active_provider: string | null;
  label: string;
  generation: number | null;
  snapshot_name: string | null;
  external_template_id: string | null;
  commit_sha: string | null;
  attempts: number;
  last_error: string | null;
  error_class: string | null;
  requested_at: string | null;
  ready_at: string | null;
  activated_at: string | null;
  immediate: boolean;
}

export function serializeTransition(
  row: ProviderTransitionRow,
  activeProvider: string | null,
  opts: { immediate?: boolean } = {},
): PreparationView {
  return {
    transition_id: row.transitionId,
    project_id: row.projectId,
    status: row.status,
    source_provider: row.sourceProvider,
    target_provider: row.targetProvider,
    active_provider: activeProvider,
    label: preparationLabel(row.status, row.targetProvider, row.sourceProvider),
    generation: row.generation,
    snapshot_name: row.snapshotName,
    external_template_id: row.externalTemplateId,
    commit_sha: row.commitSha,
    attempts: row.attempts ?? 0,
    last_error: row.lastError,
    error_class: row.errorClass,
    requested_at: row.requestedAt?.toISOString() ?? null,
    ready_at: row.readyAt?.toISOString() ?? null,
    activated_at: row.activatedAt?.toISOString() ?? null,
    immediate: opts.immediate ?? false,
  };
}

export class ProviderTransitionError extends Error {
  constructor(message: string, readonly code: 'bad_provider' | 'not_found') {
    super(message);
    this.name = 'ProviderTransitionError';
  }
}

export type SwitchResult =
  | { kind: 'immediate'; pin: string | null; projectRow: ProjectRow }
  | { kind: 'prepare'; view: PreparationView };

/**
 * Handle a switch request end to end. Immediate for a safe target (null clear,
 * the platform-default provider, or the already-active provider) — sets the pin
 * synchronously + supersedes any in-flight transition. For a different,
 * non-default enabled provider it records a durable transition (keeping the
 * SOURCE active), kicks the drive, and returns a PREPARATION object — never a
 * synchronous "done". Throws ProviderTransitionError on a bad target / missing
 * project so the route maps it to 400/404.
 */
export async function requestProviderTransition(input: {
  projectId: string;
  targetRaw: unknown;
  database?: Database;
  autoDrive?: boolean;
}): Promise<SwitchResult> {
  const database = input.database ?? appDb;
  const target = normalizeTargetProvider(input.targetRaw);

  const [row] = await database.select().from(projects).where(eq(projects.projectId, input.projectId)).limit(1);
  if (!row || row.status === 'archived') throw new ProviderTransitionError('project not found', 'not_found');

  // Validate the target (enabled provider) — a disabled/unknown target is a hard
  // 400, never a silently-ignored switch.
  if (target !== null && !config.isProviderEnabled(target as never)) {
    throw new ProviderTransitionError(`Unknown or disabled sandbox provider: ${target}`, 'bad_provider');
  }

  const routing = await readActiveRouting(database, input.projectId);
  const activeProvider = routing?.activeProvider ?? null;
  const platformDefault = config.getDefaultProvider();
  const effectiveActive = activeProvider ?? platformDefault;
  const sourceProvider = effectiveActive;

  const kind = classifyProviderSwitch({ target, effectiveActive, platformDefault });

  // ── Immediate (clear / switch to a safe target) — set pin + supersede ──────
  if (kind === 'immediate_clear' || kind === 'immediate_set' || kind === 'noop') {
    await setPinWithGenerationBump(database, { projectId: input.projectId, pin: target, now: new Date() });
    if (kind === 'immediate_clear') {
      emitProviderTransitionEvent('cancelled', { target: 'default', source: sourceProvider, projectId: input.projectId });
    }
    const [updated] = await database.select().from(projects).where(eq(projects.projectId, input.projectId)).limit(1);
    return { kind: 'immediate', pin: target, projectRow: updated ?? row };
  }

  // ── Prepare: resolve identity, reserve a generation, kick the drive ────────
  const project = toGitBackedProject(row);
  const resolved = await resolvePrepIdentity(project, target!);
  const identity: PrepIdentity = {
    projectId: input.projectId,
    targetProvider: target!,
    commitSha: resolved.commitSha,
    baseRuntimeIdentity: resolved.baseRuntimeIdentity,
    snapshotName: resolved.snapshotName,
  };
  const reserved = await reserveSwitchTransition(database, {
    accountId: row.accountId,
    sourceProvider,
    identity,
  });
  emitProviderTransitionEvent('requested', {
    target: target!,
    source: sourceProvider,
    projectId: input.projectId,
    transitionId: reserved.row.transitionId,
    generation: reserved.row.generation ?? undefined,
    snapshotName: resolved.snapshotName,
  });
  if (input.autoDrive !== false) kickDrive(reserved.row.transitionId, database);
  return { kind: 'prepare', view: serializeTransition(reserved.row, activeProvider) };
}

/** Read the latest transition + active routing for the poll endpoint. */
export async function readProjectTransitionState(
  projectId: string,
  database: Database = appDb,
): Promise<{ active_provider: string | null; latest: PreparationView | null; history: PreparationView[] }> {
  const routing = await readActiveRouting(database, projectId);
  const rows = await listTransitionsForProject(database, projectId, 10);
  const active = routing?.activeProvider ?? null;
  return {
    active_provider: active,
    latest: rows[0] ? serializeTransition(rows[0], active) : null,
    history: rows.map((r) => serializeTransition(r, active)),
  };
}

/**
 * Prebuild a project's target ppwarm image WITHOUT switching traffic (operational
 * migration mode). Same table + same dedup key, terminal-ready, invisible to
 * routing until an on-demand switch adopts it. Returns null when the project can't
 * be prepared (no repo / archived).
 */
export async function requestPrebuild(input: {
  projectId: string;
  targetProvider: string;
  database?: Database;
  autoDrive?: boolean;
}): Promise<ProviderTransitionRow | null> {
  const database = input.database ?? appDb;
  const [row] = await database.select().from(projects).where(eq(projects.projectId, input.projectId)).limit(1);
  if (!row || row.status === 'archived' || !row.repoUrl) return null;
  if (!config.isProviderEnabled(input.targetProvider as never)) return null;

  const routing = await readActiveRouting(database, input.projectId);
  const sourceProvider = routing?.activeProvider ?? config.getDefaultProvider();
  const project = toGitBackedProject(row);
  const resolved = await resolvePrepIdentity(project, input.targetProvider);
  const { row: transition } = await insertPrebuildTransition(database, {
    accountId: row.accountId,
    sourceProvider,
    identity: {
      projectId: input.projectId,
      targetProvider: input.targetProvider,
      commitSha: resolved.commitSha,
      baseRuntimeIdentity: resolved.baseRuntimeIdentity,
      snapshotName: resolved.snapshotName,
    },
  });
  if (input.autoDrive !== false) kickDrive(transition.transitionId, database);
  return transition;
}
