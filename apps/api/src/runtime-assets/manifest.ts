/**
 * What the runtime assets of THIS deploy are, and how to identify them.
 *
 * The deployed API image carries the exact `kortix` CLI binary it bakes into
 * sandbox snapshots (apps/api/Dockerfile copies the `sandbox-cli` stage output to
 * `apps/cli/dist/kortix`) and the exact managed-skill bodies it seeds projects
 * with (`@kortix/starter`, whose templates ship in the same image). So the API a
 * sandbox already talks to is the authoritative source for both — no GitHub
 * release, no separate artifact store, and CLI↔API consistency by construction:
 * whatever a sandbox converges on is by definition the build that serves it.
 *
 * The same image also carries the compiled `kortix-agent` daemon
 * (apps/api/Dockerfile:234), so the manifest describes that too and a box can
 * converge the daemon itself — not only what the daemon manages.
 *
 * All digests are computed once and memoized. No input can change for the
 * lifetime of a process: the binaries are baked into immutable image layers, and
 * the templates are a compiled-in package. The one exception is `policy`, which
 * is read live from the env on every call so a kill switch never waits on a
 * deploy — see agentSelfUpdateEnabled().
 */

import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFileSha256 } from '@kortix/shared/sandbox-runtime-artifact';
import { OPENCODE_VERSION } from '@kortix/shared/runtime-versions';
import {
  managedSkillOverlayFiles,
  managedSkillOverlayHash,
  type ManagedSkillOverlayFile,
} from './managed-skills';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * The same binary the snapshot builder bakes — read through the same env
 * override so a test (or a pinned local run) points both at one file. Read per
 * call rather than as a module const for the reason build-context.ts documents:
 * suites override the env after import.
 */
export function runtimeCliBinaryPath(): string {
  return (
    process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH || resolve(REPO_ROOT, 'apps/cli/dist/kortix')
  );
}

/**
 * The `kortix-agent` daemon binary, resolved exactly like the CLI above and
 * through the SAME env override the snapshot builder already uses
 * (`KORTIX_SNAPSHOT_AGENT_BIN_PATH`, snapshots/build-context.ts:55). The
 * deployed API image carries it: apps/api/Dockerfile:234 copies
 * `/agent/dist/kortix-agent` out of the `sandbox-agent` stage into
 * `apps/kortix-sandbox-agent-server/dist/kortix-agent`. So the daemon a box
 * converges to is by construction the daemon the API serving it was built with.
 */
export function runtimeAgentBinaryPath(): string {
  return (
    process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH ||
    resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent')
  );
}

/** Sidecar written by apps/cli/scripts/build.sh naming the version it stamped. */
function runtimeCliVersionPath(): string {
  return `${runtimeCliBinaryPath()}.version`;
}

/**
 * The version stamped into THIS image, as the agent's version string.
 *
 * apps/kortix-sandbox-agent-server/scripts/build.sh writes no `.version`
 * sidecar (unlike apps/cli/scripts/build.sh), so there is nothing to read off
 * disk. The next best true statement is the image's own stamp: the agent binary
 * in this image was compiled from the same source tree as the API serving it,
 * in the same `docker build`. Format matches what the CLI stage stamps
 * (`<version>+<commit8>`, apps/api/Dockerfile:86) so the two components read
 * alike.
 *
 * Null — never fabricated — when the image carries no stamp (a local checkout).
 * Informational only: every reconcile decision is made on `sha256`, because a
 * version string cannot prove which bytes are on disk.
 */
function runtimeAgentVersion(): string | null {
  const version = process.env.KORTIX_VERSION?.trim();
  if (!version) return null;
  const commit = (process.env.KORTIX_COMMIT || 'unknown').trim().slice(0, 8);
  return `${version}+${commit}`;
}

/**
 * Is a box allowed to converge its own daemon?
 *
 * OPERATOR RUNBOOK — flipping this needs no code deploy and no new image:
 *   • ECS (dev/prod): update the `RUNTIME_AGENT_SELF_UPDATE` env var on the
 *     kortix-api task definition to `false` and roll the service. New tasks
 *     serve `policy.agent_self_update: false` on their next manifest read.
 *   • k8s: `kubectl set env deploy/kortix-api RUNTIME_AGENT_SELF_UPDATE=false`.
 *   • self-host / local: set it in the API's env before boot.
 * Anything other than a literal `false`/`0` (case-insensitive) leaves it on, so
 * a typo fails SAFE — towards the documented default, not towards a silent
 * fleet-wide freeze nobody notices.
 *
 * Read per call rather than memoized: it costs nothing, and it must never be
 * the thing that makes a kill switch take one extra deploy to land.
 */
function agentSelfUpdateEnabled(): boolean {
  const raw = process.env.RUNTIME_AGENT_SELF_UPDATE?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0');
}

/**
 * The monotonic build number a box uses to refuse going backwards.
 *
 * WHY THIS IS NOT A TIMESTAMP TAKEN AT REQUEST TIME. A box records the highest
 * `build` it converged to and ignores anything lower. A per-request `Date.now()`
 * would be different on every read and identical across two concurrently-live
 * API versions, which defeats the guard entirely.
 *
 * WHAT WE ACTUALLY HAVE. Nothing in the deployed image is a purpose-built
 * monotonic counter — stated plainly rather than implied:
 *   • `KORTIX_VERSION` is `X.Y.Z-dev.<sha8>` on dev. The sha does not order.
 *   • `KORTIX_COMMIT` is a sha. It does not order either.
 *   • Process start time is NOT stable per deploy: every replica boots at a
 *     different instant, and a restarted OLD pod would out-rank a NEW one.
 * The best available source is the mtime of a binary baked into the image
 * layer. apps/api/Dockerfile:280 `touch`es the agent binary as the last step of
 * the runner stage, so its mtime IS the image build time; it is stored in the
 * layer, so every replica of one image reports the identical value; and a later
 * build necessarily has a later mtime. We take the max of the agent and CLI
 * binaries so a missing one degrades instead of regressing.
 *
 * DOCUMENTED LIMITATIONS.
 *   1. Monotonic only because images are built in chronological order. A
 *      deliberate rollback re-deploys an OLDER image with a LOWER build, and
 *      boxes will correctly refuse to converge backwards to it. The remedy is
 *      `RUNTIME_ASSETS_BUILD` (below) or `RUNTIME_AGENT_SELF_UPDATE=false`.
 *   2. A build backend that normalizes layer timestamps (SOURCE_DATE_EPOCH,
 *      buildkit `rewrite-timestamp`) would flatten this to 0. Nothing in
 *      .github/workflows sets either today. `0` degrades safely: it never
 *      exceeds a recorded build, so a box simply stops treating it as newer.
 *   3. Multi-arch builds produce one image per arch with mtimes seconds apart.
 *      dev and prod build `linux/amd64` only (deploy-dev.yml:367,609).
 *
 * `RUNTIME_ASSETS_BUILD` overrides it with an explicit integer, which is the
 * escape hatch for limitation 1: set it above the highest value already served
 * and a rolled-back image out-ranks the build it is replacing.
 */
function buildIdOverride(): number | null {
  const raw = process.env.RUNTIME_ASSETS_BUILD?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** One downloadable binary this deploy serves. */
export interface RuntimeBinaryComponent {
  /** Informational. Null when the build stamped nothing; never fabricated. */
  version: string | null;
  sha256: string;
  size: number;
  /** Where to GET it, relative to the API root the box already talks to. */
  path: string;
}

export interface RuntimeComponents {
  /** Absent when the API image carries no agent binary — the box then skips it. */
  agent?: RuntimeBinaryComponent;
  /** Absent when the API image carries no CLI binary. Mirrors the v1 `cli_*` keys. */
  cli?: RuntimeBinaryComponent;
  /** Fetched from npm by the daemon, not proxied: 167 MB has no business crossing our control plane. */
  opencode: { version: string; source: 'npm' };
  'managed-skills': { hash: string; count: number };
}

export interface RuntimeAssetsPolicy {
  /** Kill switch. False stops daemon self-update fleet-wide without shipping a daemon. */
  agent_self_update: boolean;
}

/**
 * V1 KEYS ARE PERMANENT. Daemons already running in the field read
 * `cli_version` / `cli_sha256` / `cli_size` / `managed_skills_hash` /
 * `managed_skills_count` off this document (see
 * apps/kortix-sandbox-agent-server/src/runtime-assets.ts). Removing or renaming
 * one breaks every box that already exists — the same failure class as the
 * accept-encoding two-list divergence. New daemons prefer `components`; old
 * daemons keep working because their keys are still here. `runtime-assets/
 * __tests__/manifest.test.ts` guards this so a future refactor cannot quietly
 * drop one.
 */
export interface RuntimeAssetsManifest {
  /**
   * The version string compiled INTO the binary, or null when the build wrote no
   * sidecar (a plain local `bun run build`, where the binary reports `dev`).
   * Informational only — reconcile decisions are made on `cli_sha256`, because a
   * version string cannot prove which bytes are on disk.
   */
  cli_version: string | null;
  /** null when the API image carries no CLI binary; the sandbox then skips CLI reconcile. */
  cli_sha256: string | null;
  cli_size: number | null;
  managed_skills_hash: string;
  managed_skills_count: number;

  // ── v2, additive ──────────────────────────────────────────────────────────
  /** Monotonic per deploy. See buildIdOverride() for the derivation and its limits. */
  build: number;
  components: RuntimeComponents;
  policy: RuntimeAssetsPolicy;
}

/**
 * Everything in the manifest that costs a hash or a stat. Memoized; the inputs
 * cannot change for the lifetime of a process (immutable image layers).
 * `policy` is deliberately NOT in here — see agentSelfUpdateEnabled().
 */
type RuntimeAssetsDigests = Omit<RuntimeAssetsManifest, 'policy'>;

let manifestPromise: Promise<RuntimeAssetsDigests> | null = null;
let overlayCache: { files: ManagedSkillOverlayFile[]; hash: string } | null = null;

export function managedSkillOverlay(): { files: ManagedSkillOverlayFile[]; hash: string } {
  if (!overlayCache) {
    const files = managedSkillOverlayFiles();
    overlayCache = { files, hash: managedSkillOverlayHash(files) };
  }
  return overlayCache;
}

/**
 * Digest + size + mtime of one baked binary, or null when the image carries
 * none. An absent binary is a legitimate state — a `bun run dev` checkout that
 * never compiled it. Report null and let the box skip that one component rather
 * than fail the whole manifest and take the other components down with it.
 */
async function measureBinary(
  path: string,
): Promise<{ sha256: string; size: number; mtimeMs: number } | null> {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size === 0) return null;
    return {
      sha256: await buildFileSha256(path),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

async function computeManifest(): Promise<RuntimeAssetsDigests> {
  const overlay = managedSkillOverlay();
  // Both binaries are hashed here, once per process, concurrently. Hashing
  // ~95 MB + ~104 MB per request is not acceptable; this is the whole reason
  // the memo below stores the promise rather than the value.
  const [cli, agent] = await Promise.all([
    measureBinary(runtimeCliBinaryPath()),
    measureBinary(runtimeAgentBinaryPath()),
  ]);
  let version: string | null = null;
  if (cli) {
    version = (await Bun.file(runtimeCliVersionPath()).text().catch(() => '')).trim() || null;
  }

  const mtimes = [agent?.mtimeMs, cli?.mtimeMs].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  const build =
    buildIdOverride() ??
    (mtimes.length > 0 ? Math.floor(Math.max(...mtimes) / 1000) : 0);

  const components: RuntimeComponents = {
    opencode: { version: OPENCODE_VERSION, source: 'npm' },
    'managed-skills': { hash: overlay.hash, count: overlay.files.length },
  };
  if (agent) {
    components.agent = {
      version: runtimeAgentVersion(),
      sha256: agent.sha256,
      size: agent.size,
      path: '/v1/runtime-assets/agent',
    };
  }
  if (cli) {
    // Deliberately the SAME values as the v1 `cli_*` keys above — one
    // measurement, two spellings. A v1 daemon and a v2 daemon must never
    // converge on different bytes.
    components.cli = {
      version,
      sha256: cli.sha256,
      size: cli.size,
      path: '/v1/runtime-assets/cli',
    };
  }

  return {
    cli_version: version,
    cli_sha256: cli?.sha256 ?? null,
    cli_size: cli?.size ?? null,
    managed_skills_hash: overlay.hash,
    managed_skills_count: overlay.files.length,
    build,
    components,
  };
}

function runtimeAssetsDigests(): Promise<RuntimeAssetsDigests> {
  if (!manifestPromise) {
    // Store the promise, not the value: two concurrent first requests must not
    // both hash a 100 MB binary.
    manifestPromise = computeManifest().catch((error) => {
      manifestPromise = null;
      throw error;
    });
  }
  return manifestPromise;
}

export async function runtimeAssetsManifest(): Promise<RuntimeAssetsManifest> {
  // Assembled per call so `policy` is read live: the kill switch must never
  // cost an extra deploy. Everything expensive comes from the memo, so the
  // marginal cost of a call is one object spread.
  return { ...(await runtimeAssetsDigests()), policy: { agent_self_update: agentSelfUpdateEnabled() } };
}

/** Test-only: drop both memos so a case can recompute against a mutated fixture. */
export function _resetRuntimeAssetsCache(): void {
  manifestPromise = null;
  overlayCache = null;
}
