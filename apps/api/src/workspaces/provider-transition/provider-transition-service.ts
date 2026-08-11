/**
 * Public entrypoints for the provider-migration workflow + the wiring that binds
 * the injectable runner to the REAL builder / provider / git / db. Routes, the
 * resume worker, and the prebuild script all go through here.
 */
import { and, eq, ne } from 'drizzle-orm';
import { projects, sandboxTemplates, type Database } from '@kortix/db';
import { db as appDb } from '../../shared/db';
import { getSandboxProvider } from '../../snapshots/providers';
import {
  DEFAULT_SANDBOX_SLUG,
  ensurePerWorkspaceWarmImage,
  resolveCommitSha,
} from '../../snapshots/builder';
import { resolveTemplateBySlug, computeTemplateIdentity } from '../../snapshots/templates';
import { perWorkspaceWarmImageName } from '../../snapshots/ppwarm-names';
import { config } from '../../config';
import type { GitBackedWorkspace } from '../git/types';
import {
  driveProviderTransition,
  type ResolvedPrepIdentity,
  type TransitionDeps,
} from './provider-transition-runner';
import {
  setPinWithGenerationBump,
  insertPrebuildTransition,
  listTransitionsForWorkspace,
  readActiveRouting,
  reserveSwitchTransition,
  type ProviderTransitionRow,
} from './provider-transition-store';
import {
  classifyProviderSwitch,
  normalizeTargetProvider,
  type PrepIdentity,
} from './provider-transition-core';
import {
  serializeTransition,
  toPublicTransitionView,
  toPublicTransitionState,
  type PreparationView,
  type PublicTransitionView,
  type PublicTransitionState,
} from './provider-transition-view';
import { emitProviderTransitionEvent } from './provider-transition-metrics';
import { logger } from '../../lib/logger';

type WorkspaceRow = typeof projects.$inferSelect;

function toGitBackedWorkspace(row: WorkspaceRow): GitBackedWorkspace & { accountId: string } {
  return {
    workspaceId: row.workspaceId,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    manifestPath: row.manifestPath,
    accountId: row.accountId,
  };
}

/**
 * FIX-M1: true iff the workspace declares its OWN (custom, non-default-slug)
 * sandbox templates. Workspace-scoped rows in `sandbox_templates` are custom by
 * construction (the platform default is a shared row with a null project_id and
 * the reserved `DEFAULT_SANDBOX_SLUG`); the `ne(slug, DEFAULT_SANDBOX_SLUG)`
 * guard is belt-and-suspenders so a project row that somehow shadows the default
 * slug is not miscounted. A cheap existence probe (LIMIT 1) — no manifest/git
 * sync — so it is safe to run inline on the activation hot path.
 */
export async function workspaceDeclaresCustomTemplates(
  database: Database,
  workspaceId: string,
): Promise<boolean> {
  const rows = await database
    .select({ slug: sandboxTemplates.slug })
    .from(sandboxTemplates)
    .where(and(eq(sandboxTemplates.workspaceId, workspaceId), ne(sandboxTemplates.slug, DEFAULT_SANDBOX_SLUG)))
    .limit(1);
  return rows.length > 0;
}

/** Resolve the current prep identity: default-branch tip + shared-default base
 *  runtime fingerprint on the target + the resulting ppwarm image name. This is
 *  EXACTLY the name ensureSandboxImage's session-start warm lookup computes, so a
 *  ready transition guarantees the first session warm-HITs (no clone).
 *
 *  SCOPE (FIX-M1): the prepared warm image covers ONLY the DEFAULT template. A
 *  workspace's custom (non-default-slug) templates are deliberately NOT prepared
 *  before the switch — Fable rejects a blocking prepare-all because a broken or
 *  unused custom template would wedge the workspace's migration forever. A
 *  custom-template project therefore migrates on the default warm image and its
 *  custom-template sessions COLD-boot on first use after the switch; that cold
 *  boot is made observable via the `custom_template_cold_boot` metric emitted at
 *  activation (see the runner), never hidden as a warm hit.
 *  TODO(provider-transition): async best-effort custom-template bakes — kick a
 *  non-blocking prepare for each custom template after (or alongside) the default
 *  activation so the FIRST custom boot is warm too, WITHOUT ever gating the switch
 *  on a custom build succeeding. Explicit follow-up; not implemented here. */
export async function resolvePrepIdentity(
  workspace: GitBackedWorkspace,
  targetProvider: string,
): Promise<ResolvedPrepIdentity> {
  const template = await resolveTemplateBySlug(workspace, DEFAULT_SANDBOX_SLUG);
  const baseIdentity = await computeTemplateIdentity(workspace, template);
  const commitSha = await resolveCommitSha(workspace, workspace.defaultBranch);
  const snapshotName = perWorkspaceWarmImageName(workspace.workspaceId, commitSha, baseIdentity.snapshotName);
  return { commitSha, baseRuntimeIdentity: baseIdentity.snapshotName, snapshotName };
}

/** Bind the runner to real collaborators. `kick` re-drives fork/adopt rows. */
export function defaultTransitionDeps(database: Database = appDb): TransitionDeps {
  return {
    db: database,
    now: () => new Date(),
    getProvider: (id) => getSandboxProvider(id),
    ensureWarmImage: async (workspace, opts) => {
      const r = await ensurePerWorkspaceWarmImage(workspace, {
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
    loadWorkspace: async (workspaceId) => {
      const [row] = await database.select().from(projects).where(eq(projects.workspaceId, workspaceId)).limit(1);
      if (!row || row.status === 'archived') return null;
      return toGitBackedWorkspace(row);
    },
    // FIX-M1: default-only projects get the full warm hit; a custom-template
    // project still migrates safely on the default warm image, and the runner
    // emits `custom_template_cold_boot` at activation so its (un-prepared) custom
    // first-boot is observable rather than silently cold.
    hasCustomTemplates: (workspace) => workspaceDeclaresCustomTemplates(database, workspace.workspaceId),
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

// FIX-L: the PATCH-response + poll-endpoint shapes (PreparationView,
// serializeTransition, the PUBLIC projection) live in the pure, config-free
// provider-transition-view module (imported above). Re-export the locals so
// existing importers keep this module as their entrypoint.
export { serializeTransition, toPublicTransitionView, toPublicTransitionState };
export type { PreparationView, PublicTransitionView, PublicTransitionState };

export class ProviderTransitionError extends Error {
  constructor(message: string, readonly code: 'bad_provider' | 'not_found') {
    super(message);
    this.name = 'ProviderTransitionError';
  }
}

export type SwitchResult =
  | { kind: 'immediate'; pin: string | null; workspaceRow: WorkspaceRow }
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
  workspaceId: string;
  targetRaw: unknown;
  database?: Database;
  autoDrive?: boolean;
}): Promise<SwitchResult> {
  const database = input.database ?? appDb;
  const target = normalizeTargetProvider(input.targetRaw);

  const [row] = await database.select().from(projects).where(eq(projects.workspaceId, input.workspaceId)).limit(1);
  if (!row || row.status === 'archived') throw new ProviderTransitionError('workspace not found', 'not_found');

  // Validate the target (enabled provider) — a disabled/unknown target is a hard
  // 400, never a silently-ignored switch.
  if (target !== null && !config.isProviderEnabled(target as never)) {
    throw new ProviderTransitionError(`Unknown or disabled sandbox provider: ${target}`, 'bad_provider');
  }

  const routing = await readActiveRouting(database, input.workspaceId);
  const activeProvider = routing?.activeProvider ?? null;
  const platformDefault = config.getDefaultProvider();
  const effectiveActive = activeProvider ?? platformDefault;
  const sourceProvider = effectiveActive;

  const kind = classifyProviderSwitch({ target, effectiveActive, platformDefault });

  // ── Immediate (clear / switch to a safe target) — set pin + supersede ──────
  if (kind === 'immediate_clear' || kind === 'immediate_set' || kind === 'noop') {
    await setPinWithGenerationBump(database, { workspaceId: input.workspaceId, pin: target, now: new Date() });
    if (kind === 'immediate_clear') {
      emitProviderTransitionEvent('cancelled', { target: 'default', source: sourceProvider, workspaceId: input.workspaceId });
    }
    const [updated] = await database.select().from(projects).where(eq(projects.workspaceId, input.workspaceId)).limit(1);
    return { kind: 'immediate', pin: target, workspaceRow: updated ?? row };
  }

  // ── Prepare: resolve identity, reserve a generation, kick the drive ────────
  const workspace = toGitBackedWorkspace(row);
  const resolved = await resolvePrepIdentity(workspace, target!);
  const identity: PrepIdentity = {
    workspaceId: input.workspaceId,
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
    workspaceId: input.workspaceId,
    transitionId: reserved.row.transitionId,
    generation: reserved.row.generation ?? undefined,
    snapshotName: resolved.snapshotName,
  });
  if (input.autoDrive !== false) kickDrive(reserved.row.transitionId, database);
  return { kind: 'prepare', view: serializeTransition(reserved.row, activeProvider) };
}

/** Read the latest transition + active routing for the poll endpoint. */
export async function readWorkspaceTransitionState(
  workspaceId: string,
  database: Database = appDb,
): Promise<{ active_provider: string | null; latest: PreparationView | null; history: PreparationView[] }> {
  const routing = await readActiveRouting(database, workspaceId);
  const rows = await listTransitionsForWorkspace(database, workspaceId, 10);
  const active = routing?.activeProvider ?? null;
  return {
    active_provider: active,
    latest: rows[0] ? serializeTransition(rows[0], active) : null,
    history: rows.map((r) => serializeTransition(r, active)),
  };
}

/** FIX-L: workspace-scoped PUBLIC transition state for the poll route
 *  (GET /sandbox-provider/transition). Maps the internal PreparationView(s)
 *  through toPublicTransitionState, which strips internal build/lease detail. */
export async function readPublicWorkspaceTransitionState(
  workspaceId: string,
  database: Database = appDb,
): Promise<PublicTransitionState> {
  return toPublicTransitionState(await readWorkspaceTransitionState(workspaceId, database));
}

/**
 * Prebuild a workspace's target ppwarm image WITHOUT switching traffic (operational
 * migration mode). Same table + same dedup key, terminal-ready, invisible to
 * routing until an on-demand switch adopts it. Returns null when the workspace can't
 * be prepared (no repo / archived).
 */
export async function requestPrebuild(input: {
  workspaceId: string;
  targetProvider: string;
  database?: Database;
  autoDrive?: boolean;
}): Promise<ProviderTransitionRow | null> {
  const database = input.database ?? appDb;
  const [row] = await database.select().from(projects).where(eq(projects.workspaceId, input.workspaceId)).limit(1);
  if (!row || row.status === 'archived' || !row.repoUrl) return null;
  if (!config.isProviderEnabled(input.targetProvider as never)) return null;

  const routing = await readActiveRouting(database, input.workspaceId);
  const sourceProvider = routing?.activeProvider ?? config.getDefaultProvider();
  const workspace = toGitBackedWorkspace(row);
  const resolved = await resolvePrepIdentity(workspace, input.targetProvider);
  const { row: transition } = await insertPrebuildTransition(database, {
    accountId: row.accountId,
    sourceProvider,
    identity: {
      workspaceId: input.workspaceId,
      targetProvider: input.targetProvider,
      commitSha: resolved.commitSha,
      baseRuntimeIdentity: resolved.baseRuntimeIdentity,
      snapshotName: resolved.snapshotName,
    },
  });
  if (input.autoDrive !== false) kickDrive(transition.transitionId, database);
  return transition;
}
