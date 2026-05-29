/**
 * Sandbox image builder — thin orchestrator over the template service and the
 * provider adapter.
 *
 *   1. Resolve `(project, slug)` → ResolvedTemplate via the template service.
 *   2. Compute the content-addressed snapshot name.
 *   3. Ask the provider: if active, return; else build inline.
 *
 * The boot path never trusts a DB row to decide "does this image exist?" —
 * it asks the provider every time. The DB row is a cache + audit log only.
 *
 * Build attempts are written to the append-only `project_snapshot_builds`
 * table for UI display + "Fix with agent."
 */

import { desc, eq } from 'drizzle-orm';
import { projectSnapshotBuilds } from '@kortix/db';
import { db } from '../shared/db';
import { resolveCommitSha, type GitBackedProject } from '../projects/git';
import { getSandboxProvider } from './providers';
import {
  computeTemplateIdentity,
  listTemplatesForProject,
  recordTemplateBuilt,
  recordTemplateFailed,
  refreshTemplateState,
  resolveTemplateBySlug,
  type ResolvedTemplate,
} from './templates';
import { DEFAULT_SANDBOX_SLUG } from './dockerfile-layer';
import { classifySnapshotError } from './error-classify';

export { resolveCommitSha };
export { DEFAULT_SANDBOX_SLUG };
export type { ResolvedTemplate };

export class SnapshotBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

export type SnapshotBuildSource =
  | 'session-start'
  | 'project-create'
  | 'cr-merge'
  | 'manual'
  | 'background';

export interface EnsureSandboxImageResult {
  snapshotName: string;
  slug: string;
  contentHash: string;
  built: boolean;
  isDefault: boolean;
}

/**
 * Make sure a provider-side snapshot exists for `(project, slug)` and return
 * its name. Builds inline if the provider doesn't have it yet.
 */
export async function ensureSandboxImage(
  project: GitBackedProject,
  opts: {
    slug?: string;
    accountId?: string;
    source?: SnapshotBuildSource;
  } = {},
): Promise<EnsureSandboxImageResult> {
  const template = await resolveTemplateBySlug(project, opts.slug);
  const provider = getSandboxProvider(template.provider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${template.provider} is not configured`);
  }

  const identity = await computeTemplateIdentity(project, template);

  // Trust-the-row fast path. If the template row already recorded THIS exact
  // snapshot (same content hash + name) as active, boot straight off it without
  // a provider round-trip. Daytona's `snapshot.get` is a public-internet call
  // that spikes to many seconds under load, and it runs on every warm boot —
  // pure dead time when our own row already knows the answer. The auto-heal in
  // session-sandbox.ts (rebuild + retry once on "snapshot not found") covers the
  // rare race where the snapshot was dropped on the provider underneath us.
  if (
    template.providerState === 'active' &&
    template.contentHash === identity.contentHash &&
    template.providerSnapshotName === identity.snapshotName
  ) {
    return {
      snapshotName: identity.snapshotName,
      slug: template.slug,
      contentHash: identity.contentHash,
      built: false,
      isDefault: !!template.isShared,
    };
  }

  // Cache hit?
  const state = await provider.getSnapshotState(identity.snapshotName);
  if (state === 'active') {
    await recordTemplateBuilt(template.templateId, {
      snapshotName: identity.snapshotName,
      contentHash: identity.contentHash,
    });
    return {
      snapshotName: identity.snapshotName,
      slug: template.slug,
      contentHash: identity.contentHash,
      built: false,
      isDefault: !!template.isShared,
    };
  }

  // ─── Graceful background rebuild (hot path only) ──────────────────────────
  // The computed identity drifted from what we last built — typically because
  // a runtime/CLI source change bumped the fingerprint (constant in active
  // local dev; once per release in prod). A session must NEVER block on a full
  // image rebuild. If the previously-built snapshot is still usable, boot off
  // it immediately and rebuild the new identity in the background; the next
  // session to boot after that lands picks it up via the trust-the-row fast
  // path above. Pre-builds and explicit manual/CR builds skip this and build
  // inline, since their whole job is to produce the new image up front.
  if (
    (opts.source ?? 'session-start') === 'session-start' &&
    template.providerSnapshotName &&
    template.providerSnapshotName !== identity.snapshotName
  ) {
    const lastGood = await provider.getSnapshotState(template.providerSnapshotName);
    if (lastGood === 'active') {
      kickBackgroundRebuild(project, {
        slug: opts.slug,
        accountId: opts.accountId,
        snapshotName: identity.snapshotName,
      });
      console.log(
        `[snapshots] ${template.slug}: identity drifted to ${identity.snapshotName}; ` +
        `booting last-known-good ${template.providerSnapshotName} and rebuilding in background`,
      );
      return {
        snapshotName: template.providerSnapshotName,
        slug: template.slug,
        contentHash: template.contentHash ?? identity.contentHash,
        built: false,
        isDefault: !!template.isShared,
      };
    }
  }

  // Reap a failed/dead snapshot under the same name so the rebuild starts fresh.
  if (state === 'error' || state === 'build_failed') {
    await provider.deleteSnapshot(identity.snapshotName);
  }

  const source = opts.source ?? 'session-start';
  const buildId = opts.accountId
    ? await openBuildLog({
        accountId: opts.accountId,
        projectId: project.projectId,
        slug: template.slug,
        snapshotName: identity.snapshotName,
        contentHash: identity.contentHash,
        source,
      })
    : null;

  try {
    await provider.buildSnapshot({
      snapshotName: identity.snapshotName,
      image: template.image ?? undefined,
      userDockerfile: identity.userDockerfile,
      entrypoint: template.entrypoint ? [template.entrypoint] : undefined,
      spec: {
        cpu: template.cpu,
        memoryGb: template.memoryGb,
        diskGb: template.diskGb,
      },
      slug: template.slug,
    });
    if (buildId) await closeBuildLogReady(buildId);
    await recordTemplateBuilt(template.templateId, {
      snapshotName: identity.snapshotName,
      contentHash: identity.contentHash,
    });
    return {
      snapshotName: identity.snapshotName,
      slug: template.slug,
      contentHash: identity.contentHash,
      built: true,
      isDefault: !!template.isShared,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (buildId) await closeBuildLogFailed(buildId, message);
    await recordTemplateFailed(template.templateId, message);
    throw new SnapshotBuildError(message, err);
  }
}

/**
 * Force the next session to rebuild by deleting the provider-side snapshot
 * for a given slug. No-op if nothing is there.
 */
export async function deleteSandboxImage(
  project: GitBackedProject,
  opts: { slug?: string } = {},
): Promise<{ deleted: boolean; snapshotName: string; slug: string }> {
  const template = await resolveTemplateBySlug(project, opts.slug);
  const provider = getSandboxProvider(template.provider);
  const identity = await computeTemplateIdentity(project, template);
  const before = await provider.getSnapshotState(identity.snapshotName);
  await provider.deleteSnapshot(identity.snapshotName);
  // Reflect on the template row.
  if (template.templateId) {
    try {
      await refreshTemplateState(template.templateId);
    } catch {
      /* best-effort */
    }
  }
  return {
    deleted: before === 'active' || before === 'building' || before === 'pulling',
    snapshotName: identity.snapshotName,
    slug: template.slug,
  };
}

/** Stateless view of every template available to the project + live state. */
export interface SandboxTemplateView {
  templateId: string | null;
  slug: string;
  name: string;
  isDefault: boolean;
  source: 'platform' | 'toml' | 'ui';
  hasDockerfile: boolean;
  hasImage: boolean;
  image: string | null;
  dockerfilePath: string | null;
  entrypoint: string | null;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  snapshotName: string;
  contentHash: string;
  daytonaState: string;
  providerState: string;
  ready: boolean;
  provider: string;
  lastBuiltAt: string | null;
  lastError: string | null;
}

export async function listSandboxTemplates(
  project: GitBackedProject,
): Promise<SandboxTemplateView[]> {
  const items = await listTemplatesForProject(project);
  return Promise.all(items.map((t) => toView(project, t)));
}

async function toView(
  project: GitBackedProject,
  t: ResolvedTemplate,
): Promise<SandboxTemplateView> {
  const identity = await computeTemplateIdentity(project, t);
  let state: string = t.providerState ?? 'missing';
  try {
    const provider = getSandboxProvider(t.provider);
    if (provider.isConfigured()) {
      state = await provider.getSnapshotState(identity.snapshotName);
    }
  } catch {
    /* keep cached */
  }
  return {
    templateId: t.templateId,
    slug: t.slug,
    name: t.name,
    isDefault: t.isShared,
    source: t.source,
    hasDockerfile: !!t.dockerfilePath,
    hasImage: !!t.image,
    image: t.image,
    dockerfilePath: t.dockerfilePath,
    entrypoint: t.entrypoint,
    cpu: t.cpu,
    memoryGb: t.memoryGb,
    diskGb: t.diskGb,
    snapshotName: identity.snapshotName,
    contentHash: identity.contentHash,
    daytonaState: state,
    providerState: state,
    ready: state === 'active',
    provider: t.provider,
    lastBuiltAt: null,
    lastError: null,
  };
}

// Re-export for callers that still want the simple resolver entry point.
export { resolveTemplateBySlug as resolveTemplate };

// ─── Build log (UI-only, never read on boot) ─────────────────────────────

export interface ProjectSnapshotBuildSummary {
  buildId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  status: 'building' | 'ready' | 'failed';
  error: string | null;
  errorCategory: string | null;
  source: SnapshotBuildSource | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function rowToSummary(row: typeof projectSnapshotBuilds.$inferSelect): ProjectSnapshotBuildSummary {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const slug = typeof meta.slug === 'string' ? meta.slug : row.branch || DEFAULT_SANDBOX_SLUG;
  return {
    buildId: row.buildId,
    projectId: row.projectId,
    slug,
    snapshotName: row.snapshotName,
    contentHash: row.contentHash,
    status: row.status as 'building' | 'ready' | 'failed',
    error: row.error,
    errorCategory: row.errorCategory,
    source: typeof meta.source === 'string' ? (meta.source as SnapshotBuildSource) : null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export async function listSnapshotBuilds(
  projectId: string,
  opts: { limit?: number } = {},
): Promise<ProjectSnapshotBuildSummary[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const rows = await db
    .select()
    .from(projectSnapshotBuilds)
    .where(eq(projectSnapshotBuilds.projectId, projectId))
    .orderBy(desc(projectSnapshotBuilds.startedAt))
    .limit(limit);
  return rows.map(rowToSummary);
}

async function openBuildLog(args: {
  accountId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  source: SnapshotBuildSource;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(projectSnapshotBuilds)
      .values({
        accountId: args.accountId,
        projectId: args.projectId,
        commitSha: '',
        branch: args.slug,
        snapshotName: args.snapshotName,
        contentHash: args.contentHash,
        status: 'building',
        metadata: { source: args.source, slug: args.slug },
      })
      .returning({ buildId: projectSnapshotBuilds.buildId });
    return row?.buildId ?? null;
  } catch (err) {
    console.warn('[snapshots] failed to open build log:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function closeBuildLogReady(buildId: string): Promise<void> {
  await db
    .update(projectSnapshotBuilds)
    .set({ status: 'ready', finishedAt: new Date(), error: null, errorCategory: null })
    .where(eq(projectSnapshotBuilds.buildId, buildId))
    .catch((err) =>
      console.warn('[snapshots] failed to close build log (ready):', err instanceof Error ? err.message : err),
    );
}

async function closeBuildLogFailed(buildId: string, message: string): Promise<void> {
  await db
    .update(projectSnapshotBuilds)
    .set({
      status: 'failed',
      error: message.slice(0, 2000),
      errorCategory: classifySnapshotError(message),
      finishedAt: new Date(),
    })
    .where(eq(projectSnapshotBuilds.buildId, buildId))
    .catch((err) =>
      console.warn('[snapshots] failed to close build log (failed):', err instanceof Error ? err.message : err),
    );
}

/**
 * In-flight background rebuilds, keyed by the target snapshot name. A burst of
 * sessions booting off the same drifted identity must kick exactly one build —
 * concurrent `daytona.snapshot.create` calls under the same name race each
 * other. Cleared when the build settles (success or failure).
 */
const inflightBackgroundBuilds = new Set<string>();

/**
 * Rebuild the drifted snapshot identity off the hot path. Deduped by target
 * snapshot name so N concurrent session boots trigger one build. Best-effort:
 * a failure just means the next session retries (it'll keep booting last-good
 * until this lands).
 */
function kickBackgroundRebuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId?: string; snapshotName: string },
): void {
  if (inflightBackgroundBuilds.has(opts.snapshotName)) return;
  inflightBackgroundBuilds.add(opts.snapshotName);
  void ensureSandboxImage(project, {
    slug: opts.slug,
    accountId: opts.accountId,
    source: 'background',
  })
    .catch((err) =>
      console.warn(
        `[snapshots] background rebuild of ${opts.snapshotName} failed for ${project.projectId}:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => inflightBackgroundBuilds.delete(opts.snapshotName));
}

/**
 * Fire-and-forget pre-build. Used at project-create and CR-merge time so the
 * first session for a new commit can boot off a cache hit.
 */
export function kickPreBuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId: string; source: SnapshotBuildSource },
): void {
  void ensureSandboxImage(project, opts).catch((err) =>
    console.warn(
      `[snapshots] pre-build failed for ${project.projectId} (slug=${opts.slug ?? 'default'}, ${opts.source}):`,
      err instanceof Error ? err.message : err,
    ),
  );
}
