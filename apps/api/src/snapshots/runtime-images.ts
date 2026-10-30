import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSandboxProvider, type SandboxProviderAdapter } from './providers';
import { config } from '../config';
import { logger } from '../lib/logger';
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';
import { recentlyBuiltStrict } from './builder-log';
import type { EnsureSandboxImageResult, SnapshotBuildSource, SandboxImageSpec } from './builder';
import type { ProviderState } from './providers';
import { computeTemplateIdentity, type ResolvedTemplate } from './templates';
import { canServeLastKnownGoodRuntime } from './runtime-freshness';
import { LAST_READY_IMAGE_MAX_AGE_MS, type ReadyImage } from './last-ready-image';
import { sessionSandboxes } from '@kortix/db';
import { and, desc, gte, like, sql } from 'drizzle-orm';
import { db } from '../shared/db';

export class SnapshotBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

export const META_RUNTIME_SPEC: SandboxImageSpec = Object.freeze({ cpu: 1, memoryGb: 2, diskGb: 8 });

const metaImageBuilds = new Map<string, Promise<EnsureSandboxImageResult>>();
let metaRuntimeFingerprint: Promise<string> | null = null;

function currentMetaRuntimeFingerprint(): Promise<string> {
  if (metaRuntimeFingerprint) return metaRuntimeFingerprint;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  metaRuntimeFingerprint = buildRuntimeArtifactFingerprint({
    sandboxVersion: 'meta-v4',
    artifacts: [
      { label: 'agent', path: resolve(root, 'apps/kortix-sandbox-agent-server/src') },
      { label: 'agent-package', path: resolve(root, 'apps/kortix-sandbox-agent-server/package.json') },
      { label: 'api-contract', path: resolve(root, 'packages/api-contract/src') },
      { label: 'cli', path: resolve(root, 'apps/cli/src') },
      { label: 'cli-package', path: resolve(root, 'apps/cli/package.json') },
      { label: 'entrypoint', path: resolve(root, 'apps/sandbox/entrypoint.sh') },
      // The rest of the Kortix defaults' staged artifacts (defaults.ts): the
      // same inputs as a project agent's image fingerprint.
      { label: 'machine-doc', path: resolve(root, 'apps/sandbox/MACHINE.md') },
      { label: 'slack-cli', path: resolve(root, 'apps/sandbox/slack-cli') },
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
  /** Test seam for the protection lookup; production uses `metaReapProtection`. */
  recentLookup: (names: string[], withinMs: number) => Promise<Set<string>> = metaReapProtection,
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
  // A local stack shares dev's namespace and provider organisation, and its
  // protection lookup reads a database that has never seen dev's builds: its
  // reap would delete the image deployed dev boots from (KRTX-2546). Deployed
  // dev's own reap tidies the images local stacks leave behind.
  if (config.KORTIX_LOCAL_DEV) {
    logger.info(`[snapshots] ${logLabel}: reap skipped: a local stack never deletes shared images`);
    return;
  }
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

/** Region residency of a Platinum image; `builder.ts` owns it (lazy: it imports this module). */
type RegionResidentCheck = (
  projectId: string,
  provider: string,
  snapshotName: string,
  timeoutMs?: number,
) => Promise<boolean>;

const defaultRegionResident: RegionResidentCheck = async (...args) =>
  (await import('./builder')).templateRegionResident(...args);

/** How long a session start waits for the image to reach its region before it falls back. */
const META_BOOT_REGION_WAIT_MS = 3_000;

export interface MetaImageDeps {
  /** Test seam; production reads `session_sandboxes`. */
  readServed?: () => Promise<ReadyImage[]>;
  /** Test seam; production asks Platinum. */
  regionResident?: RegionResidentCheck;
}

/**
 * The meta image this API version computes, ready to boot.
 *
 * A session start never waits for a meta build. When this version's image is
 * missing, still building, or not yet copied to the session's region, the
 * session boots the newest meta image a real session of this environment
 * already booted, and this version's image builds in the background. The
 * daemon converges on this deploy's runtime assets at boot, as for the default
 * image (`last-ready-image.ts` has the rule and its bound). Only when no such
 * image exists does the session wait for the build.
 *
 * Before this, the first meta session after every deploy waited for the build:
 * 80–111 s on dev, 6 times on 2026-10-30.
 */
export async function ensureMetaSandboxImage(
  opts: {
    source?: SnapshotBuildSource;
    provider: string;
    /** The session's project. It decides the Platinum region the image must be in. */
    projectId?: string;
  },
  deps: MetaImageDeps = {},
): Promise<EnsureSandboxImageResult> {
  const provider = getSandboxProvider(opts.provider);
  if (!provider.isConfigured()) {
    throw new SnapshotBuildError(`Sandbox provider ${opts.provider} is not configured`);
  }
  const fingerprint = await currentMetaRuntimeFingerprint();
  const contentHash = createHash('sha256').update(`meta-runtime-v1\0${fingerprint}`).digest('hex');
  const snapshotName = metaSnapshotName(contentHash);
  const buildKey = `${opts.provider}:${snapshotName}`;
  const regionResident = deps.regionResident ?? defaultRegionResident;
  const source = opts.source ?? 'session-start';

  if (canServeLastKnownGoodRuntime({ source })) {
    const ready =
      !metaImageBuilds.has(buildKey) &&
      (await provider.getSnapshotState(snapshotName).catch(() => 'unknown' as const)) === 'active' &&
      (!opts.projectId ||
        (await regionResident(opts.projectId, opts.provider, snapshotName, META_BOOT_REGION_WAIT_MS)));
    if (ready) return metaImageResult(snapshotName, contentHash, false);
    const fallback = await findServableMetaFallback(provider, {
      currentName: snapshotName,
      projectId: opts.projectId,
      readServed: deps.readServed ?? servedMetaImages,
      regionResident,
    });
    if (fallback) {
      // The in-process map dedupes this with any build already running here;
      // `waitForProviderBuild` dedupes it with another replica's build.
      void ensureMetaSandboxImage({ ...opts, source: 'background' }, deps).catch((err) => {
        logger.warn('[snapshots] meta: background build failed', {
          snapshotName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info('[snapshots] meta: booting last ready image instead of waiting for the build', {
        snapshotName,
        fallback: fallback.snapshotName,
      });
      return metaImageResult(fallback.snapshotName, fallback.contentHash ?? contentHash, false);
    }
    logger.warn('[snapshots] meta: no ready image to serve; waiting for the build', { snapshotName });
  }

  let image = metaImageBuilds.get(buildKey);
  let ownsImage = false;
  if (!image) {
    ownsImage = true;
    image = (async () => {
      let state = await provider.getSnapshotState(snapshotName);
      if (state === 'building') state = await waitForProviderBuild(provider, snapshotName);
      if (state === 'active') return metaImageResult(snapshotName, contentHash, false);
      if (state === 'build_failed') await provider.deleteSnapshot(snapshotName);
      await provider.buildSnapshot({
        snapshotName,
        userDockerfile: '# platform meta runtime',
        spec: { ...META_RUNTIME_SPEC },
        slug: 'meta',
        isShared: true,
        runtimeProfile: 'meta' as const,
      });
      // Tidy only after the replacement is actually active, so a failed build
      // can never leave the environment with nothing to boot.
      await reapSupersededMetaSnapshots(provider, snapshotName);
      return metaImageResult(snapshotName, contentHash, true);
    })();
    metaImageBuilds.set(buildKey, image);
  }
  let result: EnsureSandboxImageResult;
  try {
    result = await image;
  } finally {
    if (ownsImage) metaImageBuilds.delete(buildKey);
  }
  // Copy the image to the session's region now, so the create is not refused
  // with `409 replicating` and retried. A failed copy answers false; the create
  // path then handles the refusal as before.
  if (opts.projectId) await regionResident(opts.projectId, opts.provider, result.snapshotName);
  return result;
}

/** Test seam: settles once every meta build this process started has finished. */
export async function settleMetaImageBuilds(): Promise<void> {
  while (metaImageBuilds.size > 0) await Promise.allSettled([...metaImageBuilds.values()]);
}

function metaImageResult(snapshotName: string, contentHash: string, built: boolean): EnsureSandboxImageResult {
  return {
    snapshotName,
    slug: 'meta',
    contentHash,
    built,
    isDefault: false,
    runtimeProfile: 'meta' as const,
    spec: { ...META_RUNTIME_SPEC },
  };
}

/** How many served meta images are kept by the reap and probed as fallbacks. */
export const META_SERVED_IMAGE_LIMIT = 3;

/**
 * Meta images a session of this environment booted, newest first.
 *
 * Provenance matters here. Local stacks share the `kortix-meta-dev-` namespace
 * and the provider organisation with deployed dev, and they build images from
 * uncommitted source. Their sessions live in their own database, so this list
 * only ever names images that this environment's API built and a real session
 * booted. A provider listing cannot tell the two apart.
 */
export async function servedMetaImages(input: {
  limit?: number;
  now?: Date;
} = {}): Promise<ReadyImage[]> {
  const cutoff = new Date((input.now ?? new Date()).getTime() - LAST_READY_IMAGE_MAX_AGE_MS);
  const template = sql<string>`${sessionSandboxes.metadata}->>'template'`;
  const lastBoot = sql<Date>`max(${sessionSandboxes.createdAt})`;
  const rows = await db
    .select({
      snapshotName: template,
      contentHash: sql<string | null>`max(${sessionSandboxes.metadata}->'runtimeArtifact'->>'contentHash')`,
    })
    .from(sessionSandboxes)
    .where(
      and(
        gte(sessionSandboxes.createdAt, cutoff),
        like(template, `${META_SNAPSHOT_PREFIX}-${config.INTERNAL_KORTIX_ENV}-%`),
        sql`${sessionSandboxes.metadata} ? 'initSucceededAt'`,
      ),
    )
    .groupBy(template)
    .orderBy(desc(lastBoot))
    .limit(input.limit ?? META_SERVED_IMAGE_LIMIT);
  return rows.filter((row) => !!row.snapshotName);
}

/**
 * The newest served meta image that is active on the provider and resident in
 * the session's region. Answers null on any read failure: this is an
 * optimisation, and the caller then waits for the build as before.
 */
async function findServableMetaFallback(
  provider: Pick<SandboxProviderAdapter, 'id' | 'getSnapshotState' | 'findFirstActiveSnapshot'>,
  input: {
    currentName: string;
    projectId?: string;
    readServed: () => Promise<ReadyImage[]>;
    regionResident: RegionResidentCheck;
  },
): Promise<ReadyImage | null> {
  try {
    let candidates = (await input.readServed()).filter((image) => image.snapshotName !== input.currentName);
    while (candidates.length > 0) {
      const activeName = await findFirstActiveSnapshot(provider, candidates.map((image) => image.snapshotName));
      if (!activeName) return null;
      const index = candidates.findIndex((image) => image.snapshotName === activeName);
      const servable = candidates[index]!;
      if (
        !input.projectId ||
        (await input.regionResident(input.projectId, provider.id, activeName, META_BOOT_REGION_WAIT_MS))
      ) {
        return servable;
      }
      candidates = candidates.slice(index + 1);
    }
    return null;
  } catch (err) {
    logger.warn('[snapshots] meta: last-ready lookup failed; waiting for the build', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The reap's protection set: images built in the last hour (a replica that has
 * not restarted may still boot them) and the newest served images (the
 * fallbacks a session start boots while the next image builds). Throws when
 * either read fails, so the reap fails closed.
 */
async function metaReapProtection(names: string[], withinMs: number): Promise<Set<string>> {
  const [recent, served] = await Promise.all([recentlyBuiltStrict(names, withinMs), servedMetaImages()]);
  for (const image of served) recent.add(image.snapshotName);
  return recent;
}

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
export async function maybeSwapAgent(
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
    // Equal swapKeys mean equal regions (the region is hashed into it), so
    // the predecessor already lives where the new image must.
    await provider.swapAgent(identity.snapshotName, prevSnapshot, { region: identity.region });
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
