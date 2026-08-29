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

import { and, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_VERSION } from '@kortix/shared';
import { projectSnapshotBuilds } from '@kortix/db';
import { db } from '../shared/db';
import { resolveCommitSha, type GitBackedProject } from '../projects/git';
import { getSandboxProvider, type BuildLogTap, type BuildSnapshotResult, type ProviderState, type SandboxProviderAdapter } from './providers';
import { config, type SandboxProviderName } from '../config';
import { warmPrebakeProviders } from '../projects/lib/provider-precedence';
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
import { PI_WORKER_ENTRYPOINT, piWorkerImageFingerprint } from './build-context';
import {
  enabledTemplateBuildProviders,
  observeTemplateProviderCoverage,
  resolveRoutedTemplateState,
  type SandboxTemplateProvider,
  type SandboxTemplateProviderCoverage,
} from './provider-coverage';
import {
  type ReadyImage,
  lastReadyImageCandidates,
  readyImageHistory,
} from './last-ready-image';
import { canServeLastKnownGoodRuntime } from './runtime-freshness';
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';

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

const EXISTING_PROVIDER_BUILD_TIMEOUT_MS = 12 * 60 * 1000;
const EXISTING_PROVIDER_BUILD_POLL_MS = 3_000;

/**
 * Cross-replica dedupe: once provider truth says a build exists, poll that same
 * object to settlement rather than issuing a conflicting same-name build from
 * this API replica. A timeout deliberately remains `building` so callers fail
 * closed instead of creating a duplicate.
 */
export async function waitForProviderBuild(
  provider: Pick<SandboxProviderAdapter, 'getSnapshotState'>,
  snapshotName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ProviderState> {
  const timeoutMs = opts.timeoutMs ?? EXISTING_PROVIDER_BUILD_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? EXISTING_PROVIDER_BUILD_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await provider.getSnapshotState(snapshotName);
    if (state !== 'building') return state;
    if (Date.now() >= deadline) return 'building';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
}

export async function findFirstActiveSnapshot(
  provider: Pick<SandboxProviderAdapter, 'getSnapshotState' | 'findFirstActiveSnapshot'>,
  names: readonly string[],
): Promise<string | null> {
  if (names.length === 0) return null;
  if (provider.findFirstActiveSnapshot) {
    const activeName = await provider.findFirstActiveSnapshot(names);
    if (activeName !== null && !names.includes(activeName)) {
      throw new Error(`provider returned an active snapshot outside the requested candidate set`);
    }
    return activeName;
  }

  const observations = names.map(async (name) => {
    try {
      return { ok: true as const, state: await provider.getSnapshotState(name) };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  for (let index = 0; index < observations.length; index += 1) {
    const observation = await observations[index]!;
    if (!observation.ok) throw observation.error;
    if (observation.state === 'active') return names[index]!;
  }
  return null;
}

const snapshotReusePreparations = new WeakMap<object, Map<string, Promise<void>>>();

export async function prepareSnapshotForReuse<T>(
  provider: Pick<SandboxProviderAdapter, 'id' | 'prepareSnapshot'>,
  snapshotName: string,
  result: T,
  opts: { blocking: boolean },
): Promise<T> {
  if (!provider.prepareSnapshot) return result;
  let bySnapshot = snapshotReusePreparations.get(provider);
  if (!bySnapshot) {
    bySnapshot = new Map();
    snapshotReusePreparations.set(provider, bySnapshot);
  }
  let preparation = bySnapshot.get(snapshotName);
  if (!preparation) {
    const preparations = bySnapshot;
    preparation = (async () => {
      try {
        await provider.prepareSnapshot?.(snapshotName);
      } catch (err) {
        console.warn(
          `[snapshots] ${provider.id} preparation failed for ${snapshotName}:`,
          err instanceof Error ? err.message : err,
        );
      }
    })().finally(() => {
      preparations.delete(snapshotName);
      if (preparations.size === 0) snapshotReusePreparations.delete(provider);
    });
    bySnapshot.set(snapshotName, preparation);
  }
  if (opts.blocking) await preparation;
  else void preparation;
  return result;
}

export interface EnsureSandboxImageResult {
  snapshotName: string;
  slug: string;
  contentHash: string;
  built: boolean;
  isDefault: boolean;
  runtimeProfile?: 'standard' | 'fast' | 'meta' | 'pi-worker';
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
  const blockingPreparation = (opts.source ?? 'session-start') !== 'session-start';

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
    return prepareSnapshotForReuse(
      provider,
      identity.snapshotName,
      {
        snapshotName: identity.snapshotName,
        slug: template.slug,
        contentHash: identity.contentHash,
        built: false,
        isDefault: !!template.isShared,
      },
      { blocking: blockingPreparation },
    );
  }

  // Cache hit? (checks the ACTIVE provider — so a row built elsewhere doesn't
  // count, and we rebuild on this provider.)
  let state = await provider.getSnapshotState(identity.snapshotName);
  if (state === 'active') {
    await recordTemplateBuilt(template.templateId, {
      snapshotName: identity.snapshotName,
      contentHash: identity.contentHash,
      builtFromCommit: identity.builtFromCommit,
      provider: buildProvider,
      swapKey: identity.swapKey,
    });
    return prepareSnapshotForReuse(
      provider,
      identity.snapshotName,
      {
        snapshotName: identity.snapshotName,
        slug: template.slug,
        contentHash: identity.contentHash,
        built: false,
        isDefault: !!template.isShared,
      },
      { blocking: blockingPreparation },
    );
  }

  // ─── Never block a session boot on an image build ─────────────────────────
  // The identity this boot wants is not ready: it drifted (a runtime/CLI source
  // change bumped the fingerprint — constant in active local dev, once per
  // release in prod, and on EVERY `self-host update`), or it is being built
  // right now by someone else. Either way a session must NEVER wait for a full
  // image build: 14-minute builds turned session starts into 10–34 minutes of
  // `provisioning` on Essentia 2026-08-26.
  //
  // So boot off the last image this template lineage actually shipped and let
  // the new one bake behind us. The runtime assets the deploy actually changed
  // converge at boot (see last-ready-image.ts for why that is safe and where it
  // stops being safe). Pre-builds and explicit manual/CR builds skip this and
  // build inline — producing the new image IS their job.
  if (canServeLastKnownGoodRuntime({ source: opts.source ?? 'session-start' })) {
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
      return prepareSnapshotForReuse(
        provider,
        servable.snapshotName,
        {
          snapshotName: servable.snapshotName,
          slug: template.slug,
          contentHash: servable.contentHash ?? identity.contentHash,
          built: false,
          isDefault: !!template.isShared,
        },
        { blocking: blockingPreparation },
      );
    }
  }

  if (state === 'building') {
    state = await waitForProviderBuild(provider, identity.snapshotName);
    if (state === 'active') {
      await recordTemplateBuilt(template.templateId, {
        snapshotName: identity.snapshotName,
        contentHash: identity.contentHash,
        builtFromCommit: identity.builtFromCommit,
        provider: buildProvider,
        swapKey: identity.swapKey,
      });
      return prepareSnapshotForReuse(
        provider,
        identity.snapshotName,
        {
          snapshotName: identity.snapshotName,
          slug: template.slug,
          contentHash: identity.contentHash,
          built: false,
          isDefault: !!template.isShared,
        },
        { blocking: blockingPreparation },
      );
    }
    if (state === 'building') {
      throw new SnapshotBuildError(
        `Sandbox image ${identity.snapshotName} is still building on ${buildProvider}`,
      );
    }
  }
  if (state === 'unknown') {
    throw new SnapshotBuildError(
      `Cannot verify sandbox image ${identity.snapshotName} on ${buildProvider}; provider state is unknown`,
    );
  }

  // ─── Inline build (deduped across ALL sources) ───────────────────────────
  // A burst of triggers for the same snapshot identity — e.g. a project-create
  // pre-build, the first session boot, and a background rebuild all landing
  // within the same build window — must produce exactly ONE provider build and
  // ONE build-log row. `daytona.snapshot.create` calls racing under the same
  // name conflict, and duplicate rows are what left two "Building" entries
  // orphaned in the UI. We dedupe in-process by (provider, snapshot name); the
  // cross-process case is deduped above by provider truth + settlement polling.
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
 *     entrypoint / CLI / slack-cli / SDK / manifest-schema / browser /
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
    //
    // EXCEPT when the predecessor itself was built (or is building) recently:
    // that means another live code version — an overlapping rolling deploy, or
    // dev's ECS/EKS split — computed a DIFFERENT identity and is actively
    // serving it. Deleting it makes that version's sessions miss, rebuild, and
    // (symmetrically) delete OURS — an infinite mutual-destruction loop of full
    // image builds (observed live 2026-07-22: the shared default rebuilt 4× in
    // 6 minutes). A genuinely superseded identity stops being rebuilt, ages out
    // of the window, and is pruned by the next drift build or the quota GC.
    if (prevSnapshot && prevSnapshot !== identity.snapshotName) {
      const recent = await recentlyBuiltSnapshotNames([prevSnapshot], PREDECESSOR_PRUNE_PROTECT_MS);
      if (recent.has(prevSnapshot)) {
        console.log(
          `[snapshots] keeping predecessor ${prevSnapshot}: it was built recently, so another ` +
          `live replica/code version likely still serves it; it is pruned once it stops being rebuilt`,
        );
      } else {
        await provider
          .deleteSnapshot(prevSnapshot)
          .catch((e) => console.warn(`[snapshots] prune predecessor ${prevSnapshot} failed: ${e?.message ?? e}`));
      }
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
  opts: { slug?: string; provider?: string } = {},
): Promise<{ deleted: boolean; snapshotName: string; slug: string }> {
  const template = await resolveTemplateForBuildSlug(project, opts.slug);
  const provider = getSandboxProvider(opts.provider ?? template.provider);
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
    deleted: before === 'active' || before === 'building',
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
  /** Fresh launch-readiness observations for this exact content identity. */
  providerCoverage?: SandboxTemplateProviderCoverage[];
}

export async function listSandboxTemplates(
  project: GitBackedProject,
  opts: {
    /** Explicit project pin. null means Automatic routing across enabled providers. */
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  } = {},
): Promise<SandboxTemplateView[]> {
  const items = await listTemplatesForProject(project);
  const results = await Promise.allSettled(items.map((t) => toView(project, t, opts)));
  const views: SandboxTemplateView[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      views.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[sandbox-templates] skipping template "${items[i]!.slug}": ${reason}`);
    }
  }
  return views;
}

async function toView(
  project: GitBackedProject,
  t: ResolvedTemplate,
  opts: {
    selectedProvider?: SandboxTemplateProvider | null;
    includeProviderCoverage?: boolean;
  },
): Promise<SandboxTemplateView> {
  const identity = await computeTemplateIdentity(project, t);
  let state: string = t.providerState ?? 'missing';
  let providerCoverage: SandboxTemplateProviderCoverage[] | undefined;
  if (opts.includeProviderCoverage) {
    providerCoverage = await observeTemplateProviderCoverage(identity.snapshotName, {
      isProviderEnabled: (provider) => config.isProviderEnabled(provider),
      getProvider: (provider) => getSandboxProvider(provider),
      now: () => new Date(),
    });
    state = resolveRoutedTemplateState(providerCoverage, opts.selectedProvider ?? null);
  } else {
    try {
      const provider = getSandboxProvider(t.provider);
      if (provider.isConfigured()) {
        state = await provider.getSnapshotState(identity.snapshotName);
      }
    } catch {
      /* keep cached */
    }
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
    ...(providerCoverage ? { providerCoverage } : {}),
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
  provider: SandboxProviderName | null;
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
    provider: typeof meta.provider === 'string' && config.ALLOWED_SANDBOX_PROVIDERS.includes(meta.provider as SandboxProviderName)
      ? meta.provider as SandboxProviderName
      : null,
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

  let closedReady = 0;
  let closedFailed = 0;
  for (const row of rows) {
    const providerIds = buildLogProviderCandidates(row.metadata, config.ALLOWED_SANDBOX_PROVIDERS);
    const providers = providerIds.flatMap((providerId) => {
      try {
        const provider = getSandboxProvider(providerId);
        return provider.isConfigured() ? [provider] : [];
      } catch {
        return [];
      }
    });
    if (providers.length === 0) continue;

    const states = await Promise.all(providers.map(async (provider) => {
      try {
        return { provider: provider.id, state: await provider.getSnapshotState(row.snapshotName) };
      } catch {
        return { provider: provider.id, state: 'unknown' as ProviderState };
      }
    }));
    if (states.some(({ state }) => state === 'active')) {
      await closeBuildLogReady(row.buildId);
      closedReady += 1;
    } else if (states.some(({ state }) => state === 'building' || state === 'unknown')) {
      // Provider truth still says this build is in flight. Never turn it into a
      // false failure merely because a large provider build crossed our stale
      // row cutoff; a later poll will close it when the provider settles.
      continue;
    } else {
      await closeBuildLogFailed(
        row.buildId,
        `Build did not finish — provider state: ${states.map(({ provider, state }) => `${provider}=${state}`).join(', ')}.`,
      );
      closedFailed += 1;
    }
  }
  return { checked: rows.length, closedReady, closedFailed };
}

/**
 * New build rows record the exact provider in metadata. Historical rows do not,
 * and multi-provider builds predate this provenance, so legacy rows remain
 * unresolved instead of being guessed as Daytona or whichever provider happens
 * to be enabled today.
 */
export function buildLogProviderCandidates(
  metadata: unknown,
  allowedProviders: readonly string[],
): string[] {
  const provider = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).provider
    : null;
  return typeof provider === 'string' && allowedProviders.includes(provider)
    ? [provider]
    : [];
}

/** Reconcile only when provider truth confirms the current image needs a build. */
export function shouldReconcileProviderState(state: ProviderState): boolean {
  return state === 'missing' || state === 'build_failed';
}

async function openBuildLog(args: {
  accountId: string;
  projectId: string;
  slug: string;
  snapshotName: string;
  contentHash: string;
  commitSha?: string;
  source: SnapshotBuildSource;
  provider: string;
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
        // FIX-K-lite forward hygiene: record the FULL projectId as first-class
        // snapshot build metadata (alongside the projectId column), so a warm
        // image's owning project is recoverable beyond the lossy 8-hex proj8 in
        // its name. Forward-only — legacy warm images churn out on the next commit.
        metadata: { source: args.source, slug: args.slug, provider: args.provider, projectId: args.projectId },
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
 * How long a freshly-built PREDECESSOR identity is protected from the
 * supersession prune in {@link runInlineBuild}. Long: a stale-but-live code
 * version (dev's split-brain ran for days) keeps re-building its identity, so
 * every prune within the window would re-arm the mutual-destruction loop, and a
 * kept default costs only provider storage (Daytona's quota GC ranks defaults
 * by freshness; Platinum templates are CAS-chunked).
 */
const PREDECESSOR_PRUNE_PROTECT_MS = 6 * 60 * 60 * 1000;

/**
 * Of `snapshotNames`, the ones with a successful build finished — or a build
 * started — within `withinMs`, per this environment's build log. Used as the
 * "another live runtime still serves this" signal before pruning superseded
 * snapshots. Fail-open (empty set) on a DB error: the callers' deletes then
 * behave exactly as before this guard existed.
 */
async function recentlyBuiltSnapshotNames(
  snapshotNames: string[],
  withinMs: number,
): Promise<Set<string>> {
  if (snapshotNames.length === 0) return new Set();
  try {
    const cutoff = new Date(Date.now() - withinMs);
    const rows = await db
      .select({ snapshotName: projectSnapshotBuilds.snapshotName })
      .from(projectSnapshotBuilds)
      .where(
        and(
          inArray(projectSnapshotBuilds.snapshotName, snapshotNames),
          or(
            and(eq(projectSnapshotBuilds.status, 'ready'), gt(projectSnapshotBuilds.finishedAt, cutoff)),
            and(eq(projectSnapshotBuilds.status, 'building'), gt(projectSnapshotBuilds.startedAt, cutoff)),
          ),
        ),
      );
    return new Set(rows.map((row) => row.snapshotName));
  } catch (err) {
    console.warn(
      '[snapshots] recent-build lookup failed (skipping prune protection):',
      err instanceof Error ? err.message : err,
    );
    return new Set();
  }
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
 * Warm bakes currently running, keyed by (project, provider) — a hot project
 * whose tip moves mid-bake must NOT start a second concurrent bake for the new
 * tip (the name-keyed inflight set can't see that: new tip = new name).
 */
const inflightWarmBakesByProject = new Set<string>();






/**
 * Fire-and-forget pre-build. Used at project-create and CR-merge time so the
 * first session for a new commit can boot off a cache hit.
 */
export function kickPreBuild(
  project: GitBackedProject,
  opts: { slug?: string; accountId: string; source: SnapshotBuildSource; provider?: string },
): void {
  void ensureSandboxImage(project, opts).catch((err) =>
    console.warn(
      `[snapshots] pre-build failed for ${project.projectId} (slug=${opts.slug ?? 'default'}, ${opts.source}):`,
      err instanceof Error ? err.message : err,
    ),
  );
}

/** Providers a project can route a new session to for proactive template builds. */
export function templateBuildProviders(): SandboxTemplateProvider[] {
  return enabledTemplateBuildProviders({
    allowed: config.ALLOWED_SANDBOX_PROVIDERS,
    isEnabled: (provider) => config.isProviderEnabled(provider as SandboxProviderName),
  });
}

/** Fire the same content-addressed build independently on every routed provider. */
export function kickRoutedPreBuild(
  project: GitBackedProject,
  opts: {
    slug?: string;
    accountId: string;
    source: SnapshotBuildSource;
  },
): void {
  for (const provider of templateBuildProviders()) {
    kickPreBuild(project, {
      slug: opts.slug,
      accountId: opts.accountId,
      source: opts.source,
      provider,
    });
  }
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
  return ensureSandboxImage(PLATFORM_PROJECT_SHELL, {
    slug: DEFAULT_SANDBOX_SLUG,
    source: opts.source ?? 'startup',
    provider: opts.provider,
  });
}

const metaImageBuilds = new Map<string, Promise<EnsureSandboxImageResult>>();
let metaRuntimeFingerprint: Promise<string> | null = null;

function currentMetaRuntimeFingerprint(): Promise<string> {
  if (metaRuntimeFingerprint) return metaRuntimeFingerprint;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  metaRuntimeFingerprint = buildRuntimeArtifactFingerprint({
    sandboxVersion: `meta-v3:opencode:${OPENCODE_VERSION}`,
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [
      { label: 'agent', path: resolve(root, 'apps/kortix-sandbox-agent-server/src') },
      { label: 'agent-package', path: resolve(root, 'apps/kortix-sandbox-agent-server/package.json') },
      { label: 'cli', path: resolve(root, 'apps/cli/src') },
      { label: 'cli-package', path: resolve(root, 'apps/cli/package.json') },
      { label: 'entrypoint', path: resolve(root, 'apps/sandbox/entrypoint.sh') },
      { label: 'opencode-warmup', path: resolve(root, 'apps/sandbox/opencode-warmup.sh') },
      { label: 'meta-renderer', path: resolve(root, 'packages/shared/src/sandbox/meta-dockerfile.ts') },
      { label: 'sdk', path: resolve(root, 'packages/sdk/src') },
      { label: 'llm-catalog', path: resolve(root, 'packages/llm-catalog/src') },
      { label: 'manifest-schema', path: resolve(root, 'packages/manifest-schema/src') },
      { label: 'registry', path: resolve(root, 'packages/registry/src') },
      { label: 'shared', path: resolve(root, 'packages/shared/src') },
      { label: 'starter', path: resolve(root, 'packages/starter/src') },
      // The managed skills baked into the image live under templates/, not
      // src/ — without this a SKILL.md edit never re-fingerprints the image.
      { label: 'starter-templates', path: resolve(root, 'packages/starter/templates') },
    ],
  });
  return metaRuntimeFingerprint;
}

/**
 * How long a superseded meta image is protected from the reap.
 *
 * A deploy rolls replicas one at a time, so for a few minutes the previous
 * image is still the current one for whoever has not restarted yet. Deleting it
 * underneath them would break meta sandbox creation mid-rollout.
 */
const RUNTIME_REAP_PROTECT_MS = 60 * 60 * 1000;

/** Names are `kortix-meta-<env>-<hash16>`; see `metaSnapshotName`. */
const META_SNAPSHOT_PREFIX = 'kortix-meta';

/**
 * Which of `names` were built recently — same query as
 * `recentlyBuiltSnapshotNames`, but it lets a failure propagate.
 *
 * The difference is the whole point: that function returns an empty set when
 * the lookup fails, which a caller cannot distinguish from "none were recent".
 * For a reaper those two mean opposite things.
 *
 * Exported for the reap test, which needs to inject a failing lookup.
 */
export async function recentlyBuiltStrict(
  snapshotNames: string[],
  withinMs: number,
): Promise<Set<string>> {
  if (snapshotNames.length === 0) return new Set();
  const cutoff = new Date(Date.now() - withinMs);
  const rows = await db
    .select({ snapshotName: projectSnapshotBuilds.snapshotName })
    .from(projectSnapshotBuilds)
    .where(
      and(
        inArray(projectSnapshotBuilds.snapshotName, snapshotNames),
        or(
          and(eq(projectSnapshotBuilds.status, 'ready'), gt(projectSnapshotBuilds.finishedAt, cutoff)),
          and(eq(projectSnapshotBuilds.status, 'building'), gt(projectSnapshotBuilds.startedAt, cutoff)),
        ),
      ),
    );
  return new Set(rows.map((row) => row.snapshotName));
}

/**
 * The meta image name, namespaced by environment.
 *
 * The namespace is not cosmetic — it is what makes the reap safe. dev,
 * staging and prod share one Daytona organisation (same API key), so an
 * un-namespaced reap running on dev would happily delete the image prod is
 * booting meta sandboxes from. Each environment can only ever see, and
 * therefore only ever delete, its own.
 *
 * Older builds used `kortix-meta-<hash16>` with no namespace. Those names do
 * not match this prefix pattern and are left alone by the reap; they need one
 * deliberate cleanup.
 */
export function metaSnapshotName(contentHash: string): string {
  return `${META_SNAPSHOT_PREFIX}-${config.INTERNAL_KORTIX_ENV}-${contentHash.slice(0, 16)}`;
}

/**
 * Delete this environment's superseded meta images.
 *
 * The meta fingerprint hashes the source trees of the agent, CLI, SDK, shared,
 * starter and friends, so it changes on essentially every commit that touches
 * them — roughly every deploy. Nothing reaped the old ones: `ensureMetaSandboxImage`
 * deleted a snapshot only when its own build had FAILED, never when a newer one
 * superseded it. Measured 2026-08-12: 118 `kortix-meta-*` snapshots, all under
 * 14 days old, ~8 per day, against a 200-snapshot organisation quota that was
 * already exceeded (226) — which fails every CI run and every new-project
 * build, because those cannot fall back to a last-known-good image.
 *
 * Best-effort by construction: a reap failure must never fail the build that
 * triggered it. The image is already there; tidying is not on the critical path.
 */
export async function reapSupersededMetaSnapshots(
  provider: Pick<SandboxProviderAdapter, 'listSnapshots' | 'deleteSnapshot'>,
  keepName: string,
  /** Test seam for the protection lookup; production uses the strict query. */
  recentLookup: (names: string[], withinMs: number) => Promise<Set<string>> = recentlyBuiltStrict,
): Promise<void> {
  return reapSupersededEnvironmentRuntimeSnapshots(
    provider,
    META_SNAPSHOT_PREFIX,
    'meta',
    keepName,
    recentLookup,
  );
}

async function reapSupersededEnvironmentRuntimeSnapshots(
  provider: Pick<SandboxProviderAdapter, 'listSnapshots' | 'deleteSnapshot'>,
  snapshotPrefix: string,
  logLabel: string,
  keepName: string,
  recentLookup: (names: string[], withinMs: number) => Promise<Set<string>>,
): Promise<void> {
  try {
    const mine = `${snapshotPrefix}-${config.INTERNAL_KORTIX_ENV}-`;
    const candidates = (await provider.listSnapshots())
      .map((snapshot: { name: string }) => snapshot.name)
      .filter((name: string) => name.startsWith(mine) && name !== keepName);
    if (candidates.length === 0) return;
    // Fail CLOSED on the protection lookup. `recentlyBuiltSnapshotNames`
    // swallows a DB error and returns an empty set — "nothing is protected" —
    // which for a reap means "delete everything". During a rolling deploy that
    // would take out the image the not-yet-restarted replicas are booting. A
    // throw here lands in the outer catch and skips the reap entirely, which is
    // the right trade: an extra stale image costs one snapshot slot, deleting a
    // live one breaks meta sandbox creation for the whole environment.
    const recent = await recentLookup(candidates, RUNTIME_REAP_PROTECT_MS);
    for (const name of candidates) {
      if (recent.has(name)) {
        console.log(`[snapshots] ${logLabel}: keeping ${name} (built recently — a replica may still boot it)`);
        continue;
      }
      await provider.deleteSnapshot(name);
      console.log(`[snapshots] ${logLabel}: reaped superseded ${name}`);
    }
  } catch (err) {
    console.warn(
      `[snapshots] ${logLabel}: reap skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const FAST_SNAPSHOT_PREFIX = 'kortix-fast';
const fastImageBuilds = new Map<string, Promise<EnsureSandboxImageResult>>();
let fastRuntimeFingerprint: Promise<string> | null = null;

function currentFastRuntimeFingerprint(): Promise<string> {
  if (fastRuntimeFingerprint) return fastRuntimeFingerprint;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  fastRuntimeFingerprint = buildRuntimeArtifactFingerprint({
    sandboxVersion: `fast-v1:opencode:${OPENCODE_VERSION}`,
    opencodeVersion: OPENCODE_VERSION,
    artifacts: [
      { label: 'agent', path: resolve(root, 'apps/kortix-sandbox-agent-server/src') },
      { label: 'agent-package', path: resolve(root, 'apps/kortix-sandbox-agent-server/package.json') },
      { label: 'cli', path: resolve(root, 'apps/cli/src') },
      { label: 'cli-package', path: resolve(root, 'apps/cli/package.json') },
      { label: 'entrypoint', path: resolve(root, 'apps/sandbox/entrypoint.sh') },
      { label: 'machine', path: resolve(root, 'apps/sandbox/MACHINE.fast.md') },
      { label: 'lazy-tools', path: resolve(root, 'apps/sandbox/lazy-tools') },
      { label: 'fast-renderer', path: resolve(root, 'packages/shared/src/sandbox/fast-dockerfile.ts') },
      { label: 'runtime-versions', path: resolve(root, 'packages/shared/src/runtime-versions.json') },
      { label: 'sdk', path: resolve(root, 'packages/sdk/src') },
      { label: 'llm-catalog', path: resolve(root, 'packages/llm-catalog/src') },
      { label: 'manifest-schema', path: resolve(root, 'packages/manifest-schema/src') },
      { label: 'registry', path: resolve(root, 'packages/registry/src') },
      { label: 'shared', path: resolve(root, 'packages/shared/src') },
      { label: 'starter', path: resolve(root, 'packages/starter/src') },
      { label: 'starter-templates', path: resolve(root, 'packages/starter/templates') },
    ],
  });
  return fastRuntimeFingerprint;
}

export function fastSnapshotName(contentHash: string): string {
  return `${FAST_SNAPSHOT_PREFIX}-${config.INTERNAL_KORTIX_ENV}-${contentHash.slice(0, 16)}`;
}

export async function reapSupersededFastSnapshots(
  provider: Pick<SandboxProviderAdapter, 'listSnapshots' | 'deleteSnapshot'>,
  keepName: string,
  recentLookup: (names: string[], withinMs: number) => Promise<Set<string>> = recentlyBuiltStrict,
): Promise<void> {
  return reapSupersededEnvironmentRuntimeSnapshots(
    provider,
    FAST_SNAPSHOT_PREFIX,
    'fast',
    keepName,
    recentLookup,
  );
}

export async function ensureFastSandboxImage(opts: {
  source?: SnapshotBuildSource;
  provider: string;
}): Promise<EnsureSandboxImageResult> {
  const provider = getSandboxProvider(opts.provider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${opts.provider} is not configured`);
  }
  const fingerprint = await currentFastRuntimeFingerprint();
  const contentHash = createHash('sha256').update(`fast-runtime-v1\0${fingerprint}`).digest('hex');
  const snapshotName = fastSnapshotName(contentHash);
  const buildKey = `${opts.provider}:${snapshotName}`;
  let image = fastImageBuilds.get(buildKey);
  let ownsImage = false;
  if (!image) {
    ownsImage = true;
    image = (async () => {
      let state = await provider.getSnapshotState(snapshotName);
      if (state === 'building') state = await waitForProviderBuild(provider, snapshotName);
      if (state === 'active') {
        return {
          snapshotName,
          slug: DEFAULT_SANDBOX_SLUG,
          contentHash,
          built: false,
          isDefault: true,
          runtimeProfile: 'fast' as const,
        };
      }
      if (state === 'build_failed') await provider.deleteSnapshot(snapshotName);
      await provider.buildSnapshot({
        snapshotName,
        userDockerfile: '# platform fast cold-boot runtime',
        spec: {},
        slug: DEFAULT_SANDBOX_SLUG,
        isShared: true,
        runtimeProfile: 'fast',
      });
      await reapSupersededFastSnapshots(provider, snapshotName);
      return {
        snapshotName,
        slug: DEFAULT_SANDBOX_SLUG,
        contentHash,
        built: true,
        isDefault: true,
        runtimeProfile: 'fast' as const,
      };
    })();
    fastImageBuilds.set(buildKey, image);
  }
  try {
    const result = await image;
    if (result.built) return result;
    return await prepareSnapshotForReuse(provider, snapshotName, result, {
      blocking: (opts.source ?? 'session-start') !== 'session-start',
    });
  } finally {
    if (ownsImage) fastImageBuilds.delete(buildKey);
  }
}

const PIWORKER_SNAPSHOT_PREFIX = 'kortix-piworker';

/** Environment-namespaced like the meta image, for the same reap-scoping reason. */
export function piWorkerSnapshotName(contentHash: string): string {
  return `${PIWORKER_SNAPSHOT_PREFIX}-${config.INTERNAL_KORTIX_ENV}-${contentHash.slice(0, 16)}`;
}

export async function reapSupersededPiWorkerSnapshots(
  provider: Pick<SandboxProviderAdapter, 'listSnapshots' | 'deleteSnapshot'>,
  keepName: string,
  recentLookup: (names: string[], withinMs: number) => Promise<Set<string>> = recentlyBuiltStrict,
): Promise<void> {
  return reapSupersededEnvironmentRuntimeSnapshots(
    provider,
    PIWORKER_SNAPSHOT_PREFIX,
    'pi-worker',
    keepName,
    recentLookup,
  );
}

const piWorkerImageBuilds = new Map<string, Promise<EnsureSandboxImageResult>>();

// A verified-active pi worker snapshot stays valid: the name is content-hashed
// (immutable) and the reaper only deletes SUPERSEDED hashes, never the current
// one. Without this memo every session create paid a provider state round trip
// (~310 ms measured on dev 2026-08-27). The TTL bounds staleness if the
// current-hash snapshot is ever deleted by hand mid-window — the same race the
// uncached per-create check already had, just up to 5 minutes wider.
const PI_WORKER_IMAGE_READY_TTL_MS = 5 * 60_000;
const piWorkerImageReady = new Map<string, { at: number; result: EnsureSandboxImageResult }>();

export function __resetPiWorkerImageReadyCacheForTests(): void {
  piWorkerImageReady.clear();
}

/**
 * The shared pi worker image — the meta image's shape exactly, but smaller in
 * every way that matters: node plus a fetch-and-exec boot script, no daemon,
 * no CLI, no toolchain. The session's actual harness is the per-(project, sha)
 * compiled artifact the entrypoint downloads at boot, so this snapshot's
 * content hash covers ONLY the scripts baked into it and survives every
 * deploy that does not touch them.
 */
export async function ensurePiWorkerImage(opts: {
  source?: SnapshotBuildSource;
  provider: string;
}): Promise<EnsureSandboxImageResult> {
  const provider = getSandboxProvider(opts.provider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${opts.provider} is not configured`);
  }
  const contentHash = piWorkerImageFingerprint();
  const snapshotName = piWorkerSnapshotName(contentHash);
  const buildKey = `${opts.provider}:${snapshotName}`;
  const ready = piWorkerImageReady.get(buildKey);
  if (ready && Date.now() - ready.at < PI_WORKER_IMAGE_READY_TTL_MS) {
    return ready.result;
  }
  let image = piWorkerImageBuilds.get(buildKey);
  let ownsImage = false;
  if (!image) {
    ownsImage = true;
    image = (async () => {
      let state = await provider.getSnapshotState(snapshotName);
      if (state === 'building') state = await waitForProviderBuild(provider, snapshotName);
      if (state === 'active') {
        return {
          snapshotName,
          slug: 'pi-worker',
          contentHash,
          built: false,
          isDefault: false,
          runtimeProfile: 'pi-worker' as const,
        };
      }
      if (state === 'build_failed') await provider.deleteSnapshot(snapshotName);
      await provider.buildSnapshot({
        snapshotName,
        userDockerfile: '# pi worker runtime',
        spec: { cpu: 1, memoryGb: 2, diskGb: 8 },
        slug: 'pi-worker',
        isShared: true,
        runtimeProfile: 'pi-worker' as const,
        entrypoint: [PI_WORKER_ENTRYPOINT],
      });
      await reapSupersededPiWorkerSnapshots(provider, snapshotName);
      return {
        snapshotName,
        slug: 'pi-worker',
        contentHash,
        built: true,
        isDefault: false,
        runtimeProfile: 'pi-worker' as const,
      };
    })();
    piWorkerImageBuilds.set(buildKey, image);
  }
  try {
    const result = await image;
    const prepared = result.built
      ? result
      : await prepareSnapshotForReuse(provider, snapshotName, result, {
          blocking: (opts.source ?? 'session-start') !== 'session-start',
        });
    piWorkerImageReady.set(buildKey, { at: Date.now(), result: prepared });
    return prepared;
  } finally {
    if (ownsImage) piWorkerImageBuilds.delete(buildKey);
  }
}

export async function ensureMetaSandboxImage(opts: {
  source?: SnapshotBuildSource;
  provider: string;
}): Promise<EnsureSandboxImageResult> {
  const provider = getSandboxProvider(opts.provider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${opts.provider} is not configured`);
  }
  const fingerprint = await currentMetaRuntimeFingerprint();
  const contentHash = createHash('sha256').update(`meta-runtime-v1\0${fingerprint}`).digest('hex');
  const snapshotName = metaSnapshotName(contentHash);
  const buildKey = `${opts.provider}:${snapshotName}`;
  let image = metaImageBuilds.get(buildKey);
  let ownsImage = false;
  if (!image) {
    ownsImage = true;
    image = (async () => {
      let state = await provider.getSnapshotState(snapshotName);
      if (state === 'building') state = await waitForProviderBuild(provider, snapshotName);
      if (state === 'active') {
        return {
          snapshotName,
          slug: 'meta',
          contentHash,
          built: false,
          isDefault: false,
          runtimeProfile: 'meta' as const,
        };
      }
      if (state === 'build_failed') await provider.deleteSnapshot(snapshotName);
      await provider.buildSnapshot({
        snapshotName,
        userDockerfile: '# platform meta runtime',
        spec: { cpu: 1, memoryGb: 2, diskGb: 8 },
        slug: 'meta',
        isShared: true,
        runtimeProfile: 'meta' as const,
      });
      // Tidy only after the replacement is actually active, so a failed build
      // can never leave the environment with nothing to boot.
      await reapSupersededMetaSnapshots(provider, snapshotName);
      return {
        snapshotName,
        slug: 'meta',
        contentHash,
        built: true,
        isDefault: false,
        runtimeProfile: 'meta' as const,
      };
    })();
    metaImageBuilds.set(buildKey, image);
  }
  try {
    const result = await image;
    if (result.built) return result;
    return await prepareSnapshotForReuse(provider, snapshotName, result, {
      blocking: (opts.source ?? 'session-start') !== 'session-start',
    });
  } finally {
    if (ownsImage) metaImageBuilds.delete(buildKey);
  }
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
  for (const providerId of templateBuildProviders()) {
    void ensurePlatformDefaultImage({ source: 'startup', provider: providerId })
      .then((r) =>
        console.log(
          `[snapshots] startup pre-build (${providerId}): default image ${r.snapshotName} ${r.built ? 'built' : 'ready'}`,
        ),
      )
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
  const providers = templateBuildProviders();
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
    for (const providerId of providers) {
      const provider = getSandboxProvider(providerId);
      const state = await provider.getSnapshotState(identity.snapshotName);
      if (state === 'active') {
        await prepareSnapshotForReuse(provider, identity.snapshotName, undefined, { blocking: true });
        continue;
      }
      if (!shouldReconcileProviderState(state)) continue;
      kickPreBuild(project, {
        slug: t.slug,
        accountId: opts.accountId,
        source: opts.source,
        provider: providerId,
      });
      rebuilt += 1;
    }
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






