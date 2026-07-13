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

import { and, desc, eq, lt } from 'drizzle-orm';
import { projectSnapshotBuilds } from '@kortix/db';
import { db } from '../shared/db';
import { resolveCommitSha, type GitBackedProject } from '../projects/git';
import { getSandboxProvider, type ProviderState, type SandboxProviderAdapter } from './providers';
import { config, type SandboxProviderName } from '../config';
import { warmPrebakeProviders } from '../projects/lib/provider-precedence';
import { perProjectWarmImageName, ppwarmReapTargets, warmBuildSlug } from './ppwarm-names';
import {
  computeTemplateIdentity,
  listTemplatesForProject,
  recordTemplateBuilt,
  recordTemplateFailed,
  refreshTemplateState,
  resolveTemplateBySlug,
  resolveTemplateForBuildSlug,
  type ResolvedTemplate,
} from './templates';
import { DEFAULT_SANDBOX_SLUG } from './dockerfile-layer';
import { classifySnapshotError } from './error-classify';
import type { WarmRepoContext } from './build-context';
import { createHash } from 'node:crypto';

export { resolveCommitSha };
export { DEFAULT_SANDBOX_SLUG };

class SnapshotBuildError extends Error {
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
  | 'background'
  | 'startup';

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
    /**
     * The provider the SESSION will run on (its sandbox provider). Build there,
     * not on the template row's last-built provider — otherwise a template built
     * on one provider (e.g. Daytona) makes a session on another (e.g. Platinum)
     * reuse a snapshot that doesn't exist there → 404 on create. Defaults to the
     * row's provider for non-session callers (pre-build/manual/background).
     */
    provider?: string;
  } = {},
): Promise<EnsureSandboxImageResult> {
  const template = await resolveTemplateBySlug(project, opts.slug);
  const buildProvider = opts.provider ?? template.provider;

  const provider = getSandboxProvider(buildProvider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${buildProvider} is not configured`);
  }

  const identity = await computeTemplateIdentity(project, template);

  // Per-project warm preference. On a session boot of the shared default slug, if
  // a per-project warm image — same runtime identity, current default-branch tip,
  // repo baked into /workspace — is already active on this provider, boot off it
  // (no clone at boot). On a MISS, kick a fire-and-forget background bake so the
  // next session on this commit boots warm; this boot never blocks on the bake and
  // falls through to the normal cold path when no warm image exists yet.
  if ((opts.source ?? 'session-start') === 'session-start' && template.isShared) {
    try {
      const warmTip = await resolveCommitSha(project, project.defaultBranch);
      if (warmTip) {
        const warmName = perProjectWarmImageName(project.projectId, warmTip, identity.snapshotName);
        if ((await provider.getSnapshotState(warmName)) === 'active') {
          console.log(
            `[snapshots] per-project warm HIT: booting ${template.slug} from ${warmName} ` +
            `(project ${project.projectId.slice(0, 8)}, tip ${warmTip.slice(0, 8)}, provider ${buildProvider})`,
          );
          return {
            snapshotName: warmName,
            slug: template.slug,
            contentHash: identity.contentHash,
            built: false,
            isDefault: !!template.isShared,
          };
        }
        // MISS — no warm image for this (project, tip) yet. Kick a fire-and-forget
        // background bake so the NEXT session on this commit boots warm, and fall
        // through to the cold path for THIS session (never block a boot on a bake).
        kickBackgroundWarmBuild(project, {
          accountId: opts.accountId,
          provider: buildProvider,
          snapshotName: warmName,
        });
      }
    } catch (err) {
      console.warn(`[snapshots] per-project warm lookup failed (falling back to cold):`, err);
    }
  }

  // Trust-the-row fast path. If the template row already recorded THIS exact
  // snapshot (same content hash + name) as active, boot straight off it without
  // a provider round-trip. Daytona's `snapshot.get` is a public-internet call
  // that spikes to many seconds under load, and it runs on every warm boot —
  // pure dead time when our own row already knows the answer. The auto-heal in
  // session-sandbox.ts (rebuild + retry once on "snapshot not found") covers the
  // rare race where the snapshot was dropped on the provider underneath us.
  if (
    template.provider === buildProvider &&
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

  // Cache hit? (checks the ACTIVE provider — so a row built elsewhere doesn't
  // count, and we rebuild on this provider.)
  const state = await provider.getSnapshotState(identity.snapshotName);
  if (state === 'active') {
    await recordTemplateBuilt(template.templateId, {
      snapshotName: identity.snapshotName,
      contentHash: identity.contentHash,
      builtFromCommit: identity.builtFromCommit,
      provider: buildProvider,
      swapKey: identity.swapKey,
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
        provider: buildProvider,
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

  // ─── Inline build (deduped across ALL sources) ───────────────────────────
  // A burst of triggers for the same snapshot identity — e.g. a project-create
  // pre-build, the first session boot, and a background rebuild all landing
  // within the same build window — must produce exactly ONE provider build and
  // ONE build-log row. `daytona.snapshot.create` calls racing under the same
  // name conflict, and duplicate rows are what left two "Building" entries
  // orphaned in the UI. We dedupe in-process by (provider, snapshot name); the
  // cross-process case (API restart mid-build) is healed by reconcileStaleBuilds.
  //
  // The provider MUST be part of the key: the same identity can be requested for
  // two providers at once (e.g. a background reconcile builds on the template's
  // recorded provider while a session — or a failover — needs it on a DIFFERENT
  // provider). Keying on the name alone would dedupe the session onto the wrong
  // provider's build and, when that one fails, fail the session with it.
  const buildKey = `${buildProvider}:${identity.snapshotName}`;
  const existing = inflightBuilds.get(buildKey);
  if (existing) return existing;

  const buildPromise = runInlineBuild(project, template, identity, {
    state,
    accountId: opts.accountId,
    source: opts.source ?? 'session-start',
    buildProvider,
  }).finally(() => inflightBuilds.delete(buildKey));
  inflightBuilds.set(buildKey, buildPromise);
  return buildPromise;
}

type TemplateIdentity = Awaited<ReturnType<typeof computeTemplateIdentity>>;

/**
 * Try the provider's agent-only swap instead of a full rebuild. Returns true iff
 * the new snapshot was produced by swapping just the kortix-agent binary into the
 * predecessor's rootfs. Conservative + CORRECT — fires ONLY when:
 *   • the provider supports it (Platinum; Daytona has no `swapAgent`),
 *   • a distinct predecessor snapshot exists (there's a real drift), and
 *   • the drift is provably agent-ONLY: the new identity's swapKey (user image +
 *     spec + NON-agent runtime layer) equals the predecessor's STORED swapKey, so
 *     the ONLY thing that changed is the agent binary. A bumped opencode /
 *     entrypoint / CLI / slack-cli / executor-sdk / manifest-schema / browser /
 *     layer version — or the user image or spec — moves swapKey → full rebuild.
 *     (No isShared shortcut: the shared default's runtime LAYER is not constant,
 *     so it must pass the same swapKey gate as everything else.)
 * Any uncertainty/error → false → the caller rebuilds. On a swap that FAILED after
 * the provider created the new-name row, that row is reaped so it can't 409 the
 * fallback rebuild. A bad swap must never ship a wrong image, and a swap fault
 * must never block the build.
 */
async function maybeSwapAgent(
  template: ResolvedTemplate,
  identity: TemplateIdentity,
  provider: SandboxProviderAdapter,
  prevSnapshot: string | null,
): Promise<boolean> {
  if (!provider.swapAgent || !prevSnapshot || prevSnapshot === identity.snapshotName) return false;
  // Agent-ONLY drift ⇔ everything except the agent binary is byte-identical to the
  // predecessor. The predecessor's swapKey must be STORED (null for pre-rollout or
  // never-built rows → rebuild) and equal to the new identity's swapKey.
  if (!template.swapKey || template.swapKey !== identity.swapKey) return false;
  // The predecessor must still be materializable on the provider (its CAS chunks).
  if ((await provider.getSnapshotState(prevSnapshot)) !== 'active') return false;

  try {
    console.log(
      `[snapshots] ${template.slug}: agent-only drift ${prevSnapshot} → ${identity.snapshotName}; ` +
      `CAS agent-swap (no rebuild)`,
    );
    await provider.swapAgent(identity.snapshotName, prevSnapshot);
    return true;
  } catch (err) {
    console.warn(
      `[snapshots] ${template.slug}: agent-swap failed, falling back to full rebuild: ` +
      `${(err as Error)?.message ?? err}`,
    );
    // Reap any half-created new-name row so the fallback buildSnapshot (same name)
    // isn't blocked by a name-collision 409 — pickBuildHost has no state filter for
    // non-admin/org callers, which is exactly how Kortix builds authenticate.
    await provider.deleteSnapshot(identity.snapshotName).catch(() => {});
    return false;
  }
}

/**
 * Do the actual provider build for a resolved (template, identity) pair and
 * record the result on the template row + build log. Always called behind the
 * `inflightBuilds` dedup in `ensureSandboxImage` — never directly.
 */
async function runInlineBuild(
  project: GitBackedProject,
  template: ResolvedTemplate,
  identity: TemplateIdentity,
  opts: { state: ProviderState; accountId?: string; source: SnapshotBuildSource; buildProvider?: string },
): Promise<EnsureSandboxImageResult> {
  const provider = getSandboxProvider(opts.buildProvider ?? template.provider);

  // Reap a failed/dead snapshot under the same name so the rebuild starts fresh.
  if (opts.state === 'error' || opts.state === 'build_failed') {
    await provider.deleteSnapshot(identity.snapshotName);
  }

  const buildId = opts.accountId
    ? await openBuildLog({
        accountId: opts.accountId,
        projectId: project.projectId,
        slug: template.slug,
        snapshotName: identity.snapshotName,
        contentHash: identity.contentHash,
        commitSha: identity.builtFromCommit ?? '',
        source: opts.source,
      })
    : null;

  const prevSnapshot = template.providerSnapshotName;
  try {
    // ── Agent-only fast path (Platinum CAS agent-swap) ────────────────────────
    // If the predecessor differs from the new identity ONLY by the agent binary
    // (same user image) and the provider can swap in place, skip the full rebuild:
    // ship just the agent + have the host debugfs-swap it into the predecessor's
    // rootfs (~seconds, ~one agent's worth of CAS chunks). Any miss/failure → a
    // normal buildSnapshot below — the swap is a pure optimization, never a gate.
    const swapped = await maybeSwapAgent(template, identity, provider, prevSnapshot);
    if (!swapped) await provider.buildSnapshot({
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
      isShared: !!template.isShared,
      // Cold-only, unified with Daytona: Platinum builds a cold rootfs template
      // and cold-boots it (entrypoint re-runs → opencode re-inits, ~6s) on spawn
      // AND on resume — the SAME path Daytona takes, no provider divergence.
      // Stateful/warm capture used to resume opencode mid-state off a CH memory
      // snapshot, which intermittently wedged it (virtio-net RX stall after
      // restore → /global/event + /pty hang while /kortix/health still
      // answered). A cold boot avoids that entirely.
    });
    if (buildId) await closeBuildLogReady(buildId);
    await recordTemplateBuilt(template.templateId, {
      snapshotName: identity.snapshotName,
      contentHash: identity.contentHash,
      builtFromCommit: identity.builtFromCommit,
      provider: opts.buildProvider,
      swapKey: identity.swapKey,
    });
    // One-template invariant: a successful rebuild supersedes the previous
    // snapshot. Delete it so old runtime fingerprints don't accumulate — this
    // was leaking a full ~8 GB rootfs template per agent-source change (7 stale
    // copies = 56 GB observed before this fix).
    if (prevSnapshot && prevSnapshot !== identity.snapshotName) {
      await provider
        .deleteSnapshot(prevSnapshot)
        .catch((e) => console.warn(`[snapshots] prune predecessor ${prevSnapshot} failed: ${e?.message ?? e}`));
    }
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
 * In-flight inline builds, keyed by target snapshot name. Shared across every
 * build source so concurrent triggers collapse onto one build + one log row.
 */
const inflightBuilds = new Map<string, Promise<EnsureSandboxImageResult>>();

/**
 * Force the next session to rebuild by deleting the provider-side snapshot
 * for a given slug. No-op if nothing is there.
 *
 * Accepts a BUILD slug (`default-warm`) as well as a template slug: the retry
 * surfaces hand us whatever `latest_failure.slug` held, and the warm bake's build
 * row is never a template. Deleting the base template's snapshot is the correct
 * response either way — the warm image is re-baked from it.
 */
export async function deleteSandboxImage(
  project: GitBackedProject,
  opts: { slug?: string } = {},
): Promise<{ deleted: boolean; snapshotName: string; slug: string }> {
  const template = await resolveTemplateForBuildSlug(project, opts.slug);
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
  builtFromCommit: string | null;
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
    builtFromCommit: t.builtFromCommit,
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

/**
 * Builds that never reached a terminal state. The build log is closed inside
 * the same in-process promise that runs the build, so a process restart (very
 * common in dev) or crash mid-build orphans the row at `building` forever —
 * which is exactly why the dashboard showed two stuck "Building" entries even
 * though the image was actually live. This re-checks any `building` row older
 * than the max build window against the provider and closes it: `ready` if the
 * snapshot is active, `failed` otherwise. Idempotent and safe to run anywhere.
 *
 * The cutoff must exceed the longest legitimate build (Daytona build timeout +
 * activation poll); below that we'd race a build that's genuinely still going.
 */
const STALE_BUILD_MS = 20 * 60 * 1000;
const STALE_BUILD_BATCH = 50;

export async function reconcileStaleBuilds(
  opts: { projectId?: string; olderThanMs?: number } = {},
): Promise<{ checked: number; closedReady: number; closedFailed: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? STALE_BUILD_MS));
  const conds = [
    eq(projectSnapshotBuilds.status, 'building'),
    lt(projectSnapshotBuilds.startedAt, cutoff),
  ];
  if (opts.projectId) conds.push(eq(projectSnapshotBuilds.projectId, opts.projectId));

  const rows = await db
    .select()
    .from(projectSnapshotBuilds)
    .where(and(...conds))
    .orderBy(desc(projectSnapshotBuilds.startedAt))
    .limit(STALE_BUILD_BATCH);
  if (rows.length === 0) return { checked: 0, closedReady: 0, closedFailed: 0 };

  // Only Daytona today; build-log rows don't carry a provider column, so use
  // the lone configured adapter. If it's not configured we can't know the true
  // state, so leave the rows alone rather than mark good builds failed.
  const provider = getSandboxProvider('daytona');
  if (!provider.isConfigured()) return { checked: rows.length, closedReady: 0, closedFailed: 0 };

  let closedReady = 0;
  let closedFailed = 0;
  for (const row of rows) {
    let state: ProviderState;
    try {
      state = await provider.getSnapshotState(row.snapshotName);
    } catch {
      state = 'missing';
    }
    if (state === 'active') {
      await closeBuildLogReady(row.buildId);
      closedReady += 1;
    } else {
      await closeBuildLogFailed(
        row.buildId,
        'Build did not finish — the API process restarted or the build timed out before it completed.',
      );
      closedFailed += 1;
    }
  }
  return { checked: rows.length, closedReady, closedFailed };
}

async function openBuildLog(args: {
  accountId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  commitSha?: string;
  source: SnapshotBuildSource;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(projectSnapshotBuilds)
      .values({
        accountId: args.accountId,
        projectId: args.projectId,
        commitSha: args.commitSha ?? '',
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
 * In-flight background rebuilds, keyed by provider + target snapshot name. A
 * burst of sessions booting off the same drifted identity must kick exactly
 * one build on EACH provider; same-name builds on different providers are
 * independent and must never suppress each other.
 */
const inflightBackgroundBuilds = new Set<string>();

export function backgroundBuildKey(provider: string, snapshotName: string): string {
  return `${provider}:${snapshotName}`;
}

/**
 * Rebuild the drifted snapshot identity off the hot path. Deduped by target
 * provider-qualified snapshot name so N concurrent session boots trigger one
 * build per provider. Best-effort: a failure just means the next session
 * retries (it'll keep booting last-good until this lands).
 */
function kickBackgroundRebuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId?: string; provider: string; snapshotName: string },
): void {
  const key = backgroundBuildKey(opts.provider, opts.snapshotName);
  if (inflightBackgroundBuilds.has(key)) return;
  inflightBackgroundBuilds.add(key);
  void ensureSandboxImage(project, {
    slug: opts.slug,
    accountId: opts.accountId,
    source: 'background',
    provider: opts.provider,
  })
    .catch((err) =>
      console.warn(
        `[snapshots] background rebuild of ${opts.snapshotName} failed for ${project.projectId}:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => inflightBackgroundBuilds.delete(key));
}

/**
 * Fire-and-forget per-project warm bake, off the session hot path. Deduped by the
 * target warm snapshot name (via the same inflight set) so a burst of sessions on
 * the same (project, tip) kicks exactly one bake. Best-effort: a failure just means
 * the next session retries; sessions keep booting cold until the bake lands.
 */
function kickBackgroundWarmBuild(
  project: GitBackedProject,
  opts: { accountId?: string; provider: string; snapshotName: string },
): void {
  const key = backgroundBuildKey(opts.provider, opts.snapshotName);
  if (inflightBackgroundBuilds.has(key)) return;
  inflightBackgroundBuilds.add(key);
  void ensurePerProjectWarmImage(project, {
    accountId: opts.accountId,
    provider: opts.provider,
    source: 'background',
  })
    .catch((err) =>
      console.warn(
        `[snapshots] background warm bake of ${opts.snapshotName} failed for ${project.projectId}:`,
        err instanceof Error ? err.message : err,
      ),
    )
    .finally(() => inflightBackgroundBuilds.delete(key));
}

/**
 * Build-on-push warm prebake. Fire-and-forget: when a commit lands on a project's
 * default branch (a successful push to the managed git), kick the per-project warm
 * bake for the CURRENT tip so the FIRST session on the new commit boots warm —
 * instead of waiting for a session to MISS and trigger the bake on demand (which
 * leaves that first session cold). Reuses the exact resolve-tip + dedup path the
 * session-start trigger uses: gated to the shared default, keyed on the
 * default-branch tip, deduped by the target warm name. Idempotent — it no-ops when
 * the default-branch tip is unchanged (the warm image for that tip is already
 * active) or a bake for it is already in flight. Best-effort: never throws, never
 * blocks the push; the session-start on-demand trigger remains the fallback.
 *
 * PROVIDER PARITY: a push must pre-warm the provider(s) a session on this project
 * could actually land on — NOT just the default provider. With `opts.provider`
 * set, warm exactly that one (the pre-existing single-provider behaviour, kept
 * byte-identical for callers that already target a provider). Otherwise resolve
 * the target set from the project's provider PIN, exactly as session creation does
 * (`warmPrebakeProviders`): an enabled pin ⇒ that one provider; no/stale pin ⇒
 * every enabled provider (the weighted balancer can route a session to any of
 * them). This closes the gap where a git push only warmed the default provider
 * while a Platinum-routed (or Platinum-pinned) session still baked lazily on its
 * first miss.
 */
export async function kickProjectWarmPrebake(
  project: GitBackedProject,
  opts: { accountId?: string; provider?: string; projectPin?: string | null } = {},
): Promise<void> {
  const providers = opts.provider
    ? [opts.provider]
    : warmPrebakeProviders({
        // Pre-warm the provider(s) a session on this project could land on —
        // exactly what session creation resolves from the pin (an enabled pin ⇒
        // that provider; no/stale pin ⇒ every enabled provider).
        projectPin: opts.projectPin ?? null,
        allowed: config.ALLOWED_SANDBOX_PROVIDERS,
        isEnabled: (p) => config.isProviderEnabled(p as SandboxProviderName),
      });
  // Per-provider: content-addressed name, own getSnapshotState check, own dedup
  // in kickBackgroundWarmBuild. Independent + best-effort — one provider failing
  // (or being unconfigured) must not skip the others, so each is its own try.
  await Promise.all(providers.map((buildProvider) => prebakeForProvider(project, buildProvider, opts.accountId)));
}

async function prebakeForProvider(
  project: GitBackedProject,
  buildProvider: string,
  accountId?: string,
): Promise<void> {
  try {
    const template = await resolveTemplateBySlug(project, undefined);
    if (!template.isShared) return; // same gate as the session-start warm trigger
    const provider = getSandboxProvider(buildProvider);
    if (!provider.isConfigured()) return;
    const identity = await computeTemplateIdentity(project, template);
    const tip = await resolveCommitSha(project, project.defaultBranch);
    if (!tip) return;
    const warmName = perProjectWarmImageName(project.projectId, tip, identity.snapshotName);
    // Tip unchanged (or already warm for this commit) → nothing to do.
    if ((await provider.getSnapshotState(warmName)) === 'active') return;
    kickBackgroundWarmBuild(project, { accountId, provider: buildProvider, snapshotName: warmName });
    console.log(
      `[snapshots] warm prebake-on-push kicked: project ${project.projectId.slice(0, 8)} ` +
      `tip ${tip.slice(0, 8)} (${buildProvider})`,
    );
  } catch (err) {
    console.warn(
      `[snapshots] warm prebake-on-push skipped for ${project.projectId} (${buildProvider}):`,
      err instanceof Error ? err.message : err,
    );
  }
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

// ─── Platform default (global, project-independent) ──────────────────────────

/**
 * The platform default image is content-addressed and shared by EVERY project,
 * user, and session — its identity is a constant Dockerfile, independent of any
 * repo. So its build belongs to the platform lifecycle, not the project
 * lifecycle: we build it once per process at startup (a no-op cache hit after
 * the first global build, or after a release bumps the runtime fingerprint),
 * and the session-boot graceful path is the lazy fallback. project-create no
 * longer triggers it. No build-log row is written (it's global, not project-
 * scoped). A throwaway project shell is fine — the default path never reads it.
 */
const PLATFORM_PROJECT_SHELL: GitBackedProject = {
  projectId: '',
  repoUrl: '',
  defaultBranch: '',
  manifestPath: '',
};

async function ensurePlatformDefaultImage(
  opts: { source?: SnapshotBuildSource } = {},
): Promise<EnsureSandboxImageResult> {
  return ensureSandboxImage(PLATFORM_PROJECT_SHELL, {
    slug: DEFAULT_SANDBOX_SLUG,
    source: opts.source ?? 'startup',
  });
}

let startupPreBuildKicked = false;

/**
 * Idempotent, fire-and-forget. Mints the platform default image once per
 * process boot so the first session anywhere lands on a cache hit. Safe to call
 * from multiple startup paths — only the first call does work.
 */
export function kickStartupPreBuild(): void {
  if (startupPreBuildKicked) return;
  startupPreBuildKicked = true;
  // Gate on the ACTUAL default provider, not daytona specifically — a Platinum-only
  // deploy has no daytona adapter configured, which used to skip the pre-build and
  // leave the first project after a release to pay a lazy "Not built yet" build.
  const providerId = config.getDefaultProvider();
  let provider: SandboxProviderAdapter;
  try {
    provider = getSandboxProvider(providerId);
  } catch {
    console.log(`[snapshots] startup pre-build skipped — no adapter for default provider '${providerId}'`);
    return;
  }
  if (!provider.isConfigured()) {
    console.log(`[snapshots] startup pre-build skipped — default provider '${providerId}' not configured`);
    return;
  }
  void ensurePlatformDefaultImage({ source: 'startup' })
    .then((r) =>
      console.log(
        `[snapshots] startup pre-build: default image ${r.snapshotName} ${r.built ? 'built' : 'ready'}`,
      ),
    )
    .catch((err) =>
      console.warn(
        '[snapshots] startup pre-build of platform default failed:',
        err instanceof Error ? err.message : err,
      ),
    );
}

// ─── Custom (toml / UI) templates — explicit rebuilds ────────────────────────

/**
 * Reconcile a project's OWN templates (never the shared default): for each
 * custom template whose built image is stale or missing relative to its
 * currently-computed identity, kick a pre-build. Driven by project-create and
 * CR-merge so a Dockerfile or spec change lands a fresh image proactively
 * instead of stalling the next session that boots the slug. Forces a TOML sync
 * so a `[[sandbox.templates]]` edit in the just-merged commit is picked up.
 */
async function reconcileProjectTemplates(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): Promise<{ checked: number; rebuilt: number }> {
  const templates = await listTemplatesForProject(project, { forceTomlSync: true });
  let rebuilt = 0;
  for (const t of templates) {
    if (t.isShared) continue; // the platform default is built globally
    let identity: TemplateIdentity;
    try {
      identity = await computeTemplateIdentity(project, t);
    } catch (err) {
      console.warn(
        `[snapshots] reconcile: cannot compute identity for ${project.projectId}/${t.slug}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const current =
      t.providerState === 'active' &&
      t.contentHash === identity.contentHash &&
      t.providerSnapshotName === identity.snapshotName;
    if (current) continue;
    kickPreBuild(project, { slug: t.slug, accountId: opts.accountId, source: opts.source });
    rebuilt += 1;
  }
  return { checked: templates.length, rebuilt };
}

/** Fire-and-forget wrapper around {@link reconcileProjectTemplates}. */
export function kickProjectTemplatePrebuilds(
  project: GitBackedProject,
  opts: { accountId: string; source: SnapshotBuildSource },
): void {
  void reconcileProjectTemplates(project, opts).catch((err) =>
    console.warn(
      `[snapshots] project-template reconcile failed for ${project.projectId} (${opts.source}):`,
      err instanceof Error ? err.message : err,
    ),
  );
}

// ─── Per-project COLD rootfs warm ────────────────────────────────────────────

/** Managed name prefix for per-project COLD warm images. Reapable, disjoint
 *  from the shared-default (`kortix-default-`) and custom (`kortix-tpl-`) names.
 *  Provider-agnostic: the SAME cold image builds on Daytona and Platinum. */
export interface PerProjectWarmResult {
  snapshotName: string;
  tip: string;
  built: boolean;
  provider: string;
}

/**
 * Build (or reuse) a project's COLD warm image: the shared default runtime with
 * the project's repo checkout baked into /workspace at the default-branch tip.
 * capture:'none' — NO memory snapshot, NO stateful CH; BOTH Daytona and Platinum
 * boot it cold and the daemon (git.ts) fast-paths the baked `.git` with no clone.
 *
 * Idempotent: an active image under the computed name short-circuits. The name is
 * tip-keyed, so a moved tip bakes a new one (self-superseding). This is the pure
 * builder primitive — it does NOT rewrite session routing; a caller opts a
 * session in by booting `snapshotName`. `provider` defaults to the platform
 * default provider so it's testable on either backend.
 */
export async function ensurePerProjectWarmImage(
  project: GitBackedProject,
  opts: { accountId?: string; provider?: string; source?: SnapshotBuildSource } = {},
): Promise<PerProjectWarmResult> {
  if (!project.repoUrl) throw new SnapshotBuildError('project has no repo url — cannot bake per-project warm image');
  const buildProvider = opts.provider ?? config.getDefaultProvider();
  const provider = getSandboxProvider(buildProvider);
  if (!provider.isConfigured()) throw new SnapshotBuildError(`Sandbox provider ${buildProvider} is not configured`);

  // Base runtime == the SHARED default (same opencode/agent/CLI a cold session
  // gets). The repo is layered ON TOP via warmRepo — the userDockerfile is the
  // platform default's, unchanged, so the runtime is byte-identical to default.
  const template = await resolveTemplateBySlug(project, DEFAULT_SANDBOX_SLUG);
  const baseIdentity = await computeTemplateIdentity(project, template);

  const tip = await resolveCommitSha(project, project.defaultBranch);
  if (!tip) throw new SnapshotBuildError(`could not resolve ${project.defaultBranch} tip for per-project warm`);

  const snapshotName = perProjectWarmImageName(project.projectId, tip, baseIdentity.snapshotName);

  // Idempotency: active image under this (project, tip, runtime) → reuse it.
  // Still reap here — this path also runs when a prior bake's reap failed or a
  // moved-then-restored tip races to active, so it cleans lingering old tips.
  if ((await provider.getSnapshotState(snapshotName)) === 'active') {
    await reapOldPerProjectWarm(project.projectId, snapshotName, buildProvider);
    return { snapshotName, tip, built: false, provider: buildProvider };
  }

  const warmRepo = await resolveWarmRepoContext(project);

  const buildId = opts.accountId
    ? await openBuildLog({
        accountId: opts.accountId,
        projectId: project.projectId,
        slug: warmBuildSlug(DEFAULT_SANDBOX_SLUG),
        snapshotName,
        contentHash: baseIdentity.contentHash,
        commitSha: tip,
        source: opts.source ?? 'manual',
      })
    : null;

  try {
    console.log(
      `[snapshots] per-project warm: baking ${snapshotName} (project ${project.projectId.slice(0, 8)}, ` +
      `tip ${tip.slice(0, 8)}, base ${baseIdentity.snapshotName}, provider=${buildProvider})`,
    );
    // COLD build (capture:'none' — buildSnapshot on this branch never captures a
    // memory snapshot). The ONLY delta from the shared default build is warmRepo,
    // which bakes /workspace at build time.
    await provider.buildSnapshot({
      snapshotName,
      image: template.image ?? undefined,
      userDockerfile: baseIdentity.userDockerfile,
      entrypoint: template.entrypoint ? [template.entrypoint] : undefined,
      spec: { cpu: template.cpu, memoryGb: template.memoryGb, diskGb: template.diskGb },
      slug: warmBuildSlug(template.slug),
      isShared: false,
      warmRepo,
    });
    if (buildId) await closeBuildLogReady(buildId);
    await reapOldPerProjectWarm(project.projectId, snapshotName, buildProvider);
    return { snapshotName, tip, built: true, provider: buildProvider };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (buildId) await closeBuildLogFailed(buildId, message);
    throw new SnapshotBuildError(message, err);
  }
}

/**
 * Resolve the build-time clone credentials + runtime proxy origin for a project's
 * per-project warm bake. Reads the full project row (the GitBackedProject subset
 * lacks the fields `resolveProjectUpstream` needs). The build-time auth header is
 * a short-lived git-host credential embedded ONLY in a one-shot RUN; origin is
 * reset to the Kortix proxy so the daemon re-auths per session at runtime.
 */
async function resolveWarmRepoContext(project: GitBackedProject): Promise<WarmRepoContext> {
  const { projects } = await import('@kortix/db');
  const { resolveProjectUpstream } = await import('../projects/lib/git');
  const { proxyGitUrl } = await import('../projects/lib/sessions');

  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.projectId)).limit(1);
  if (!row) throw new SnapshotBuildError(`project ${project.projectId} not found for warm-repo resolution`);

  const upstream = await resolveProjectUpstream(row as never, 'read');
  if (!upstream?.url) throw new SnapshotBuildError('no git upstream configured for project — cannot bake per-project warm');

  return {
    cloneUrl: upstream.url,
    cloneHeaders: upstream.headers ?? {},
    branch: project.defaultBranch,
    originUrl: proxyGitUrl(project.projectId),
  };
}

/**
 * On-bake reap of a project's SUPERSEDED per-project warm images — the aggressive
 * cleanup prod does (warm-project.ts `reapOldProjectWarm` / `…Platinum`). A moved
 * tip orphans the old content-addressed image; `REAPABLE_SNAPSHOT_PREFIXES` lets
 * the *general* reaper sweep it eventually, but on Daytona (which has a
 * snapshot-COUNT quota) that lag piles up, so we delete superseded tips the moment
 * the new one is active — keeping ~1 image per active project, exactly like prod.
 * Best-effort: a reap failure (list/delete error, provider hiccup) NEVER fails the
 * bake. Listing/deletion are provider-adapter capabilities, so cleanup remains
 * identical for Daytona, Platinum, and E2B.
 */
async function reapOldPerProjectWarm(projectId: string, currentName: string, buildProvider: string): Promise<void> {
  try {
    const provider = getSandboxProvider(buildProvider);
    const names = (await provider.listSnapshots()).map((snapshot) => snapshot.name);
    for (const name of ppwarmReapTargets(projectId, currentName, names)) {
      await provider.deleteSnapshot(name);
      console.log(`[snapshots] per-project warm: reaped superseded ${name}`);
    }
  } catch (err) {
    console.warn(
      `[snapshots] per-project warm: supersession reap skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
