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
  ensureSandboxImage,
  resolveCommitSha,
} from '../../snapshots/builder';
import { resolveTemplateBySlug, computeTemplateIdentity } from '../../snapshots/templates';
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

/**
 * FIX-M1: true iff the project declares its OWN (custom, non-default-slug)
 * sandbox templates. Project-scoped rows in `sandbox_templates` are custom by
 * construction (the platform default is a shared row with a null project_id and
 * the reserved `DEFAULT_SANDBOX_SLUG`); the `ne(slug, DEFAULT_SANDBOX_SLUG)`
 * guard is belt-and-suspenders so a project row that somehow shadows the default
 * slug is not miscounted. A cheap existence probe (LIMIT 1) — no manifest/git
 * sync — so it is safe to run inline on the activation hot path.
 */
export async function projectDeclaresCustomTemplates(
  database: Database,
  projectId: string,
): Promise<boolean> {
  const rows = await database
    .select({ slug: sandboxTemplates.slug })
    .from(sandboxTemplates)
    .where(and(eq(sandboxTemplates.projectId, projectId), ne(sandboxTemplates.slug, DEFAULT_SANDBOX_SLUG)))
    .limit(1);
  return rows.length > 0;
}

/** Renew the row lease this often while a provider build runs (lease TTL is
 *  10 minutes; a cold template build can take several). */
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;

/** Resolve the current prep identity: default-branch tip + the SHARED default
 *  template image on the target provider. That template image is exactly what a
 *  session boots from (`ensureSandboxImage`), so a ready transition guarantees
 *  the first session finds its image already built on the new provider.
 *
 *  HISTORY: this used to prepare a per-project warm image (repo baked in at the
 *  tip). That system was removed — it minted one provider template per commit,
 *  which collided with provider template/snapshot quotas, and its session-side
 *  read path had been disabled in every environment, so the prepared image was
 *  never actually booted. The repo now arrives through the fast git path
 *  (scaffold + delta bundle, ~0.2 s) instead of being baked into an image.
 *
 *  `commitSha` is still recorded on the row: it is the durable identity a
 *  transition was requested at, and the runner's drift check pairs it with
 *  `baseRuntimeIdentity`. A tip move now costs at most a forked row that finds
 *  the same template image already built — never another bake.
 *
 *  SCOPE: only the DEFAULT template is prepared. A project's custom templates
 *  are deliberately not prepared before the switch; their first session after
 *  the switch builds on demand, made observable via `custom_template_cold_boot`
 *  at activation (see the runner), never hidden as a hit. */
export async function resolvePrepIdentity(
  project: GitBackedProject,
  targetProvider: string,
): Promise<ResolvedPrepIdentity> {
  const template = await resolveTemplateBySlug(project, DEFAULT_SANDBOX_SLUG);
  const baseIdentity = await computeTemplateIdentity(project, template);
  const commitSha = await resolveCommitSha(project, project.defaultBranch);
  return {
    commitSha,
    baseRuntimeIdentity: baseIdentity.snapshotName,
    snapshotName: baseIdentity.snapshotName,
  };
}

/** Bind the runner to real collaborators. `kick` re-drives fork/adopt rows. */
export function defaultTransitionDeps(database: Database = appDb): TransitionDeps {
  return {
    db: database,
    now: () => new Date(),
    getProvider: (id) => getSandboxProvider(id),
    ensureWarmImage: async (project, opts) => {
      // Build the shared default template on the TARGET provider. A cold build
      // can outlive the row's 10-minute lease, and `ensureSandboxImage` has no
      // heartbeat of its own, so drive the caller's heartbeat on an interval for
      // the duration — without it a long build lapses into a double-drive.
      const beat = opts.heartbeat
        ? setInterval(() => void opts.heartbeat?.(), LEASE_HEARTBEAT_INTERVAL_MS)
        : null;
      try {
        const r = await ensureSandboxImage(project, {
          slug: DEFAULT_SANDBOX_SLUG,
          provider: opts.provider,
          accountId: opts.accountId,
          source: 'background',
          // A transition prepares the RUNTIME, never a repo-bearing image.
          allowProjectImage: false,
        });
        // The runner falls back to `provider.getSnapshotExternalId(name)` when a
        // build surfaces no id, which is the case for every template build.
        return { snapshotName: r.snapshotName, built: r.built, externalTemplateId: null };
      } finally {
        if (beat) clearInterval(beat);
      }
    },
    resolvePrepIdentity,
    loadProject: async (projectId) => {
      const [row] = await database.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
      if (!row || row.status === 'archived') return null;
      return toGitBackedProject(row);
    },
    // FIX-M1: default-only projects get the full warm hit; a custom-template
    // project still migrates safely on the default warm image, and the runner
    // emits `custom_template_cold_boot` at activation so its (un-prepared) custom
    // first-boot is observable rather than silently cold.
    hasCustomTemplates: (project) => projectDeclaresCustomTemplates(database, project.projectId),
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

/** FIX-L: project-scoped PUBLIC transition state for the poll route
 *  (GET /sandbox-provider/transition). Maps the internal PreparationView(s)
 *  through toPublicTransitionState, which strips internal build/lease detail. */
export async function readPublicProjectTransitionState(
  projectId: string,
  database: Database = appDb,
): Promise<PublicTransitionState> {
  return toPublicTransitionState(await readProjectTransitionState(projectId, database));
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
