import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_VERSION } from '@kortix/shared';
import { getSandboxProvider, type SandboxProviderAdapter } from './providers';
import { config } from '../config';
import { PI_WORKER_ENTRYPOINT, piWorkerImageFingerprint } from './build-context';
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';
import { recentlyBuiltStrict } from './builder-log';
import type { EnsureSandboxImageResult, SnapshotBuildSource, SandboxImageSpec } from './builder';
import type { ProviderState } from './providers';
import { computeTemplateIdentity, type ResolvedTemplate } from './templates';

export class SnapshotBuildError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

export const META_RUNTIME_SPEC: SandboxImageSpec = Object.freeze({ cpu: 1, memoryGb: 2, diskGb: 8 });
export const PI_WORKER_RUNTIME_SPEC: SandboxImageSpec = Object.freeze({ cpu: 1, memoryGb: 2, diskGb: 8 });

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
      { label: 'api-contract', path: resolve(root, 'packages/api-contract/src') },
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
          spec: { ...PI_WORKER_RUNTIME_SPEC },
        };
      }
      if (state === 'build_failed') await provider.deleteSnapshot(snapshotName);
      await provider.buildSnapshot({
        snapshotName,
        userDockerfile: '# pi worker runtime',
        spec: { ...PI_WORKER_RUNTIME_SPEC },
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
        spec: { ...PI_WORKER_RUNTIME_SPEC },
      };
    })();
    piWorkerImageBuilds.set(buildKey, image);
  }
  try {
    const result = await image;
    piWorkerImageReady.set(buildKey, { at: Date.now(), result });
    return result;
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
          spec: { ...META_RUNTIME_SPEC },
        };
      }
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
      return {
        snapshotName,
        slug: 'meta',
        contentHash,
        built: true,
        isDefault: false,
        runtimeProfile: 'meta' as const,
        spec: { ...META_RUNTIME_SPEC },
      };
    })();
    metaImageBuilds.set(buildKey, image);
  }
  try {
    return await image;
  } finally {
    if (ownsImage) metaImageBuilds.delete(buildKey);
  }
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
