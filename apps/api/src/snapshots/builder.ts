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

import { runWorkerTick } from '../shared/audit-scope';
import { resolveCommitSha, type GitBackedProject } from '../projects/git';
import { getSandboxProvider, type ProviderState, type SandboxProviderAdapter } from './providers';
import {
  computeTemplateIdentity,
  recordTemplateBuilt,
  recordTemplateFailed,
  resolveTemplateBySlug,
  type ResolvedTemplate,
} from './templates';
import { DEFAULT_SANDBOX_SLUG } from './dockerfile-layer';
import {
  type ReadyImage,
  lastReadyImageCandidates,
  readyImageHistory,
} from './last-ready-image';
import { canServeLastKnownGoodRuntime } from './runtime-freshness';
import { openBuildLog, closeBuildLogReady, closeBuildLogFailed, recentlyBuiltSnapshotNames, PREDECESSOR_PRUNE_PROTECT_MS } from './builder-log';
import { waitForProviderBuild, findFirstActiveSnapshot, maybeSwapAgent, ensureMetaSandboxImage, SnapshotBuildError } from './runtime-images';
import { enabledTemplateBuildProviders } from './provider-coverage';
import { config, type SandboxProviderName } from '../config';
import { platinumUsRegion } from '../shared/platinum-region';
import { preparePlatinumTemplateRegion } from './providers/platinum-templates';

type TemplateIdentity = Awaited<ReturnType<typeof computeTemplateIdentity>>;

export { resolveCommitSha };
export { DEFAULT_SANDBOX_SLUG };
export { waitForProviderBuild, findFirstActiveSnapshot } from './runtime-images';
export { deleteSandboxImage, listSandboxTemplates } from './template-prebuilds';
export type { SandboxTemplateView } from './template-prebuilds';
export { resolveTemplateBySlug as resolveTemplate };
export { listSnapshotBuilds, reconcileStaleBuilds, buildLogProviderCandidates, shouldReconcileProviderState, recentlyBuiltStrict } from './builder-log';
export type { ProjectSnapshotBuildSummary } from './builder-log';
export { META_RUNTIME_SPEC, PI_WORKER_RUNTIME_SPEC, ensureMetaSandboxImage, ensurePiWorkerImage, metaSnapshotName, piWorkerSnapshotName, reapSupersededMetaSnapshots, reapSupersededPiWorkerSnapshots } from './runtime-images';
export { kickPreBuild, kickRoutedPreBuild, templateBuildProviders, kickProjectTemplatePrebuilds } from './template-prebuilds';

export type SnapshotBuildSource =
  | 'session-start'
  | 'project-create'
  | 'project-repository-replacement'
  | 'cr-merge'
  | 'manual'
  | 'background'
  | 'startup';
/** The machine size an image boots with. The provider allocates it from the image. */
export interface SandboxImageSpec {
  cpu: number;
  memoryGb: number;
  diskGb: number;
}

export interface EnsureSandboxImageResult {
  snapshotName: string;
  slug: string;
  contentHash: string;
  built: boolean;
  isDefault: boolean;
  runtimeProfile?: 'standard' | 'meta' | 'pi-worker';
  /**
   * The size this image was built with, which is the size the box boots with.
   * Compute metering bills from it. Absent only for a result constructed
   * outside this module.
   */
  spec?: SandboxImageSpec;
}

function templateImageSpec(template: Pick<ResolvedTemplate, 'cpu' | 'memoryGb' | 'diskGb'>): SandboxImageSpec {
  return { cpu: template.cpu, memoryGb: template.memoryGb, diskGb: template.diskGb };
}

/**
 * The first image of this template lineage the provider still holds ACTIVE, or
 * null when there is none — a genuinely first build, which must block.
 *
 * Read failures are answered `null`, never an exception: this is an
 * OPTIMISATION on the boot path, and a provider hiccup here must fall through
 * to the ordinary build path rather than fail the boot.
 */
export async function findServableLastReadyImage(
  provider: Pick<SandboxProviderAdapter, 'getSnapshotState' | 'findFirstActiveSnapshot'>,
  input: {
    project: Pick<GitBackedProject, 'projectId'>;
    template: Pick<
      ResolvedTemplate,
      'slug' | 'isShared' | 'providerSnapshotName' | 'contentHash'
    >;
    identity: Pick<TemplateIdentity, 'snapshotName'>;
    buildProvider: string;
    /** Injected in tests; the live reader hits `project_snapshot_builds`. */
    readHistory?: typeof readyImageHistory;
  },
): Promise<ReadyImage | null> {
  const { template, identity } = input;
  try {
    const history = await (input.readHistory ?? readyImageHistory)({
      projectId: input.project.projectId,
      slug: template.slug,
      provider: input.buildProvider,
      isShared: !!template.isShared,
    }).catch(() => [] as ReadyImage[]);
    const candidates = lastReadyImageCandidates({
      recordedSnapshotName: template.providerSnapshotName,
      recordedContentHash: template.contentHash,
      history,
      identitySnapshotName: identity.snapshotName,
    });
    if (candidates.length === 0) return null;
    const activeName = await findFirstActiveSnapshot(
      provider,
      candidates.map((candidate) => candidate.snapshotName),
    );
    if (!activeName) return null;
    return candidates.find((candidate) => candidate.snapshotName === activeName) ?? null;
  } catch (err) {
    console.warn(
      `[snapshots] last-ready-image lookup failed for ${template.slug} (falling through to build):`,
      err,
    );
    return null;
  }
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
    /** False when the session may not receive full repository bytes. */
    allowProjectImage?: boolean;
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
      spec: templateImageSpec(template),
    };
  }

  // Cache hit? (checks the ACTIVE provider — so a row built elsewhere doesn't
  // count, and we rebuild on this provider.)
  const state = await provider.getSnapshotState(identity.snapshotName);
  const prepareRegion = template.isShared && buildProvider === 'platinum' ? platinumUsRegion() : null;

  // ─── Never block a session boot on an image build ─────────────────────────
  // The identity this boot wants is not ready: it drifted (a runtime/CLI source
  // change bumped the fingerprint — constant in active local dev, once per
  // release in prod, and on EVERY `self-host update`), or it is being built
  // right now by someone else. Either way a session must NEVER wait for a full
  // image build: 14-minute builds turned session starts into 10–34 minutes of
  // `provisioning` on SampleCo 2026-08-26.
  //
  // So boot off the last image this template lineage actually shipped and let
  // the new one bake behind us. The runtime assets the deploy actually changed
  // converge at boot (see last-ready-image.ts for why that is safe and where it
  // stops being safe). Pre-builds and explicit manual/CR builds skip this and
  // build inline — producing the new image IS their job.
  if (
    canServeLastKnownGoodRuntime({ source: opts.source ?? 'session-start' }) &&
    (state !== 'active' || prepareRegion)
  ) {
    const servable = await findServableLastReadyImage(provider, {
      project,
      template,
      identity,
      buildProvider,
    });
    if (servable) {
      // A build already in flight for this identity needs no second trigger;
      // `waitForProviderBuild`'s cross-replica dedupe exists precisely so we do
      // not issue a conflicting same-name build.
      if (state !== 'building') {
        kickBackgroundRebuild(project, {
          slug: opts.slug,
          accountId: opts.accountId,
          provider: buildProvider,
          snapshotName: identity.snapshotName,
        });
      }
      console.log(
        `[snapshots] ${template.slug}: ${identity.snapshotName} is ${state}; ` +
        `booting last ready image ${servable.snapshotName} instead of waiting for the build ` +
        `(rebuild ${state === 'building' ? 'already in flight' : 'kicked in background'})`,
      );
      return {
        snapshotName: servable.snapshotName,
        slug: template.slug,
        contentHash: servable.contentHash ?? identity.contentHash,
        built: false,
        isDefault: !!template.isShared,
        spec: templateImageSpec(template),
      };
    }
  }

  try {
    const image = await resolveExactImage(project, template, identity, {
      state,
      accountId: opts.accountId,
      source: opts.source ?? 'session-start',
      buildProvider,
    });
    await publishTemplateImage(template, identity, image, buildProvider, prepareRegion);
    return image.image;
  } catch (err) {
    // A failed replacement must not invalidate the last ready shared default.
    if (!template.isShared) {
      await recordTemplateFailed(template.templateId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

interface ExactImageResult {
  image: EnsureSandboxImageResult;
  buildId: string | null;
}

/** Resolve only the requested identity; neither publish it nor select a fallback. */
async function resolveExactImage(
  project: GitBackedProject,
  template: ResolvedTemplate,
  identity: TemplateIdentity,
  opts: { state: ProviderState; accountId?: string; source: SnapshotBuildSource; buildProvider: string },
): Promise<ExactImageResult> {
  const provider = getSandboxProvider(opts.buildProvider);
  let state = opts.state;
  if (state === 'building') state = await waitForProviderBuild(provider, identity.snapshotName);
  if (state === 'active') {
    return {
      image: {
        snapshotName: identity.snapshotName,
        slug: template.slug,
        contentHash: identity.contentHash,
        built: false,
        isDefault: !!template.isShared,
        spec: templateImageSpec(template),
      },
      buildId: null,
    };
  }
  if (state === 'building' || state === 'unknown') {
    throw new SnapshotBuildError(
      `Cannot resolve sandbox image ${identity.snapshotName} on ${opts.buildProvider}; provider state is ${state}`,
    );
  }

  // Physical builds share one provider-qualified promise across every caller.
  // Publication is separate: a US prepare failure leaves the old row untouched.
  const buildKey = `${opts.buildProvider}:${identity.snapshotName}`;
  const existing = inflightBuilds.get(buildKey);
  if (existing) return existing;

  const buildPromise = runInlineBuild(project, template, identity, { ...opts, state })
    .finally(() => inflightBuilds.delete(buildKey));
  inflightBuilds.set(buildKey, buildPromise);
  return buildPromise;
}
/**
 * Build the exact provider image and log its physical build. Shared default
 * publication and predecessor deletion happen only after regional preparation.
 * Called behind the provider-qualified `inflightBuilds` dedup.
 */
async function runInlineBuild(
  project: GitBackedProject,
  template: ResolvedTemplate,
  identity: TemplateIdentity,
  opts: { state: ProviderState; accountId?: string; source: SnapshotBuildSource; buildProvider?: string },
): Promise<ExactImageResult> {
  const provider = getSandboxProvider(opts.buildProvider ?? template.provider);

  // Reap a failed/dead snapshot under the same name so the rebuild starts fresh.
  if (opts.state === 'build_failed') {
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
        provider: provider.id,
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
      containerRuntime: template.containerRuntime,
      // Cold-only, unified with Daytona: Platinum builds a cold rootfs template
      // and cold-boots it (entrypoint re-runs → opencode re-inits, ~6s) on spawn
      // AND on resume — the SAME path Daytona takes, no provider divergence.
      // Stateful/warm capture used to resume opencode mid-state off a CH memory
      // snapshot, which intermittently wedged it (virtio-net RX stall after
      // restore → /global/event + /pty hang while /kortix/health still
      // answered). A cold boot avoids that entirely.
    });
    return {
      image: {
        snapshotName: identity.snapshotName,
        slug: template.slug,
        contentHash: identity.contentHash,
        built: true,
        isDefault: !!template.isShared,
        spec: templateImageSpec(template),
      },
      buildId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (buildId) await closeBuildLogFailed(buildId, message);
    throw new SnapshotBuildError(message, err);
  }
}

/** Publish a proven image, then apply the existing predecessor pruning policy. */
async function publishTemplateImage(
  template: ResolvedTemplate,
  identity: TemplateIdentity,
  result: ExactImageResult,
  buildProvider: string,
  prepareRegion: string | null,
): Promise<{ templateId: string; region: string } | null> {
  const { image, buildId } = result;
  try {
    const residency = prepareRegion
      ? await preparePlatinumTemplateRegion(image.snapshotName, prepareRegion)
      : null;
    await recordTemplateBuilt(template.templateId, {
      snapshotName: image.snapshotName,
      contentHash: identity.contentHash,
      builtFromCommit: identity.builtFromCommit,
      provider: buildProvider,
      swapKey: identity.swapKey,
    });
    // Build history is also a last-ready source. Do not expose a build there
    // while its regional preparation is still queued, copying, or failed.
    if (buildId) await closeBuildLogReady(buildId);
    const prevSnapshot = template.providerSnapshotName;
    if (image.built && prevSnapshot && prevSnapshot !== image.snapshotName) {
      const recent = await recentlyBuiltSnapshotNames([prevSnapshot], PREDECESSOR_PRUNE_PROTECT_MS);
      if (recent.has(prevSnapshot)) {
        console.log(`[snapshots] keeping recently built predecessor ${prevSnapshot}`);
      } else {
        await getSandboxProvider(buildProvider).deleteSnapshot(prevSnapshot)
          .catch((err) => console.warn(
            `[snapshots] prune predecessor ${prevSnapshot} failed:`,
            err instanceof Error ? err.message : err,
          ));
      }
    }
    return residency;
  } catch (err) {
    if (buildId) await closeBuildLogFailed(buildId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * In-flight inline builds, keyed by target snapshot name. Shared across every
 * build source so concurrent triggers collapse onto one build + one log row.
 */
const inflightBuilds = new Map<string, Promise<ExactImageResult>>();
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
  opts: { source?: SnapshotBuildSource; provider: string },
): Promise<EnsureSandboxImageResult> {
  if (opts.provider === 'platinum' && platinumUsRegion()) {
    return preparePlatformDefaultImageInUs();
  }
  return ensureSandboxImage(PLATFORM_PROJECT_SHELL, {
    slug: DEFAULT_SANDBOX_SLUG,
    source: opts.source ?? 'startup',
    provider: opts.provider,
  });
}

/** Blocking release gate. Never substitutes a previous image or the home region. */
export async function preparePlatformDefaultImageInUs(): Promise<
  EnsureSandboxImageResult & { templateId: string; region: string }
> {
  const region = platinumUsRegion();
  if (!region) throw new Error('KORTIX_PLATINUM_US_REGION must name the target US region');
  if (!config.isPlatinumEnabled()) throw new Error('Platinum must be enabled for the US image release gate');
  const project = PLATFORM_PROJECT_SHELL;
  const template = await resolveTemplateBySlug(project, DEFAULT_SANDBOX_SLUG);
  const provider = getSandboxProvider('platinum');
  if (!provider.isConfigured()) throw new SnapshotBuildError('Sandbox provider platinum is not configured');
  const identity = await computeTemplateIdentity(project, template);
  const image = await resolveExactImage(project, template, identity, {
    state: await provider.getSnapshotState(identity.snapshotName),
    source: 'startup',
    buildProvider: 'platinum',
  });
  const residency = await publishTemplateImage(template, identity, image, 'platinum', region);
  if (!residency) throw new Error('US image publication requires exact regional readiness');
  return { ...image.image, ...residency };
}
let startupPreBuildKicked = false;

/**
 * Idempotent, fire-and-forget. Mints the platform default image independently
 * on every enabled provider once per process boot, so an Automatic or pinned
 * session never pays a provider-specific lazy build.
 */
export function kickStartupPreBuild(): void {
  // Focused acceptance runs can skip the multi-gigabyte session and meta
  // images. Production keeps the pre-build enabled by default.
  if (process.env.KORTIX_SKIP_STARTUP_PREBUILD === 'true') return;
  if (startupPreBuildKicked) return;
  startupPreBuildKicked = true;
  void runWorkerTick('startup-prebuild', startupPreBuild);
}

function startupPreBuild(): void {
  for (const providerId of enabledTemplateBuildProviders({
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
    isEnabled: (provider) => config.isProviderEnabled(provider as SandboxProviderName),
  })) {
    void ensurePlatformDefaultImage({ source: 'startup', provider: providerId })
      .then((r) => {
        const region = providerId === 'platinum' ? platinumUsRegion() : null;
        console.log(
          `[snapshots] startup pre-build (${providerId}): default image ${r.snapshotName} ${r.built ? 'built' : 'ready'}${region ? `; resident in ${region}` : ''}`,
        );
      })
      .catch((err) =>
        console.warn(
          `[snapshots] startup pre-build of platform default failed (${providerId}):`,
          err instanceof Error ? err.message : err,
        ),
      );
    void ensureMetaSandboxImage({ source: 'startup', provider: providerId })
      .then((r) =>
        console.log(
          `[snapshots] startup pre-build (${providerId}): meta image ${r.snapshotName} ${r.built ? 'built' : 'ready'}`,
        ),
      )
      .catch((err) =>
        console.warn(
          `[snapshots] startup pre-build of platform meta failed (${providerId}):`,
          err instanceof Error ? err.message : err,
        ),
      );
  }
}
