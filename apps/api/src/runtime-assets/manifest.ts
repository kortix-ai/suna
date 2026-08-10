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
 * Both digests are computed once and memoized. Neither input can change for the
 * lifetime of a process: the binary is baked into an immutable image layer, and
 * the templates are a compiled-in package.
 */

import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFileSha256 } from '@kortix/shared/sandbox-runtime-artifact';
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

/** Sidecar written by apps/cli/scripts/build.sh naming the version it stamped. */
function runtimeCliVersionPath(): string {
  return `${runtimeCliBinaryPath()}.version`;
}

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
}

let manifestPromise: Promise<RuntimeAssetsManifest> | null = null;
let overlayCache: { files: ManagedSkillOverlayFile[]; hash: string } | null = null;

export function managedSkillOverlay(): { files: ManagedSkillOverlayFile[]; hash: string } {
  if (!overlayCache) {
    const files = managedSkillOverlayFiles();
    overlayCache = { files, hash: managedSkillOverlayHash(files) };
  }
  return overlayCache;
}

async function computeManifest(): Promise<RuntimeAssetsManifest> {
  const overlay = managedSkillOverlay();
  const binaryPath = runtimeCliBinaryPath();
  let cli: { sha256: string; size: number } | null = null;
  try {
    const stats = await stat(binaryPath);
    if (stats.isFile() && stats.size > 0) {
      cli = { sha256: await buildFileSha256(binaryPath), size: stats.size };
    }
  } catch {
    // Absent binary is a legitimate state — a `bun run dev` checkout that never
    // built the CLI. Report null and let the sandbox skip the CLI half rather
    // than fail the whole manifest and take the skill half down with it.
    cli = null;
  }
  let version: string | null = null;
  if (cli) {
    version = (await Bun.file(runtimeCliVersionPath()).text().catch(() => '')).trim() || null;
  }
  return {
    cli_version: version,
    cli_sha256: cli?.sha256 ?? null,
    cli_size: cli?.size ?? null,
    managed_skills_hash: overlay.hash,
    managed_skills_count: overlay.files.length,
  };
}

export function runtimeAssetsManifest(): Promise<RuntimeAssetsManifest> {
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

/** Test-only: drop both memos so a case can recompute against a mutated fixture. */
export function _resetRuntimeAssetsCache(): void {
  manifestPromise = null;
  overlayCache = null;
}
