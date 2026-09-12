import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../../logger';

/**
 * Remove macOS AppleDouble sidecars from an OpenCode config dir.
 *
 * A snapshot baked from a macOS host can carry `._*` files (see the API's
 * snapshots/staging-tar.ts for how they get in). Inside a config dir they are
 * FATAL, not cosmetic: OpenCode's ToolRegistry bundles every entry under
 * `tools/`, `plugins/`, `agents/` and `skills/` as source, hits the sidecar's
 * NUL bytes, and fails with `BuildMessage: Unexpected NUL`. That failure is
 * memoized for the process lifetime, so EVERY `session/prompt` on that sandbox
 * returns `-32603 Internal error: OpenCode service failure` forever. The
 * sidecars also surface as phantom agents (`._kortix`, `._memory-reflector`) in
 * OpenCode's agent catalog.
 *
 * The staging fix stops new images from carrying them, but a snapshot name is
 * content-addressed: an image already in circulation stays poisoned until its
 * runtime fingerprint moves. So repair it here too — a sandbox must not be
 * permanently unable to answer a prompt because of the host that baked it.
 *
 * Scoped to the config dir on purpose. That is the only place a sidecar is
 * fatal, and a `._*` file can never legitimately hold a tool, agent, plugin, or
 * skill. The workspace at large is the user's data and is left untouched; its
 * sidecars cost only a `git` warning.
 *
 * Never throws: a repair failure must not stop a session from booting.
 */
export async function pruneAppleDoubleFiles(dir: string): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith('._')) {
        await rm(path, { recursive: true, force: true });
        removed++;
        continue;
      }
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        removed += await pruneAppleDoubleFiles(path);
      }
    }
  } catch (err) {
    logger.warn('[boot] AppleDouble prune failed', {
      dir,
      err: err instanceof Error ? err.message : String(err),
    });
    return removed;
  }
  return removed;
}

/** Prune a config dir and log only when it was actually poisoned. */
export async function repairOpencodeConfigDir(dir: string): Promise<void> {
  const removed = await pruneAppleDoubleFiles(dir);
  if (removed > 0) {
    logger.warn(
      `[boot] removed ${removed} macOS AppleDouble sidecar(s) from ${dir}; this image was baked from a macOS host and OpenCode cannot build them`,
    );
  }
}
