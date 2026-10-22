/**
 * The in-VM remediation for disk pressure: what the daemon may delete, and
 * what it frees (KRTX-2593 — Platinum dev VMs sat at 96-100% rootfs with no
 * remediation while the control plane only kept alarming).
 *
 * The target set is the safety check. Every target is regenerable by design —
 * a package cache the tool rebuilds on its next run, a workspace build cache
 * the bundler rebuilds on demand, or an unreferenced pnpm store object (no
 * hardlink outside the store). Nothing else is ever touched: no project
 * files, no `.git`, no session state, and a symlinked cache entry is removed
 * as a link — its target outside the set is never followed and never deleted.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export interface CleanupTarget {
  path: string
  /**
   * 1 = package caches, wiped on any pressure crossing. 2 = workspace build
   * caches and pnpm store prune, only at the deep threshold (the control
   * plane's critical band, 95%).
   */
  tier: 1 | 2
  /**
   * `wipe` (default) deletes every child of the target. `prune` deletes only
   * files whose hardlink count is 1 — a store object no project links.
   */
  mode?: 'wipe' | 'prune'
}

/** The deep threshold: the control plane alarms "critical" from 95% used. */
export const DEEP_DISK_CLEANUP_PCT = 95

const MB = 1024 * 1024

class Skip extends Error {
  reason: string
  constructor(reason: string, detail: string) {
    super(detail)
    this.reason = reason
  }
}

/** Absolute targets of first-level subdirectories of `dir`, when `dir` exists. */
async function childrenOf(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).map((entry) => join(dir, entry))
  } catch {
    return []
  }
}

/**
 * The known-safe set for a session: package caches under the session user's
 * home, workspace build caches at the workspace root and one level down (a
 * repo cloned into the root or a subdirectory), and the pnpm stores.
 */
export async function knownSafeTargets(home: string, workspaceRoot?: string): Promise<CleanupTarget[]> {
  const targets: CleanupTarget[] = [
    { path: join(home, '.cache/uv'), tier: 1 },
    { path: join(home, '.cache/pnpm'), tier: 1 },
    { path: join(home, '.npm/_cacache'), tier: 1 },
    { path: join(home, '.bun/install/cache'), tier: 1 },
  ]
  if (workspaceRoot) {
    for (const root of [workspaceRoot, ...(await childrenOf(workspaceRoot))]) {
      targets.push({ path: join(root, 'node_modules/.cache'), tier: 2 })
      targets.push({ path: join(root, '.turbo/cache'), tier: 2 })
      targets.push({ path: join(root, '.next/cache'), tier: 2 })
    }
  }
  // Store prune at the deep threshold only. ponytail: pruning an object
  // between pnpm's rename-into-store and its hardlink out (nlink 1) makes the
  // running install re-fetch that one object; recoverable, and at >=95% the
  // install is out of disk anyway. Ceiling: no store lock is taken.
  targets.push({ path: join(home, '.local/share/pnpm/store'), tier: 2, mode: 'prune' })
  return targets
}

export interface CleanedTarget {
  path: string
  freedMb: number
  files: number
}

export interface SkippedTarget {
  path: string
  reason: string
}

export interface CleanupReport {
  freedMb: number
  cleaned: CleanedTarget[]
  skipped: SkippedTarget[]
}

const MB_ROUND = (bytes: number) => Math.round(bytes / MB)

/**
 * Sum of file sizes under `path`, lstat only: a symlink counts its own link
 * bytes and is never followed into its target.
 */
async function measureTree(path: string): Promise<{ bytes: number; files: number }> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const entry of await readdir(path)) {
    try {
      const child = await measureTree(join(path, entry))
      bytes += child.bytes
      files += child.files
    } catch {
      // unreadable children are neither measured nor counted
    }
  }
  return { bytes, files }
}

/** Delete every child of `path` (the directory itself stays). */
async function wipe(path: string): Promise<{ bytes: number; files: number }> {
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch (err) {
    throw new Skip('unreadable', (err as Error).message)
  }
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    const child = join(path, entry)
    try {
      const measured = await measureTree(child)
      bytes += measured.bytes
      files += measured.files
    } catch {
      // vanished or unreadable mid-walk: rm below still removes what it can
    }
    try {
      // rm never follows symlinks: a link inside the cache is unlinked, its
      // target outside the target set survives.
      await rm(child, { recursive: true, force: true })
    } catch (err) {
      throw new Skip('deletion refused', (err as Error).message)
    }
  }
  return { bytes, files }
}

/** Delete files in `path` whose hardlink count is 1 (no project links them). */
async function prune(path: string): Promise<{ bytes: number; files: number }> {
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch (err) {
    throw new Skip('unreadable', (err as Error).message)
  }
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    const child = join(path, entry)
    let stat
    try {
      stat = await lstat(child)
    } catch {
      continue // vanished mid-walk
    }
    if (stat.isDirectory()) {
      const nested = await prune(child)
      bytes += nested.bytes
      files += nested.files
      continue
    }
    if (stat.isSymbolicLink() || stat.nlink !== 1) continue
    try {
      await rm(child, { force: true })
      bytes += stat.size
      files += 1
    } catch (err) {
      throw new Skip('deletion refused', (err as Error).message)
    }
  }
  return { bytes, files }
}

/**
 * Clean the targets whose tier is at or below `maxTier`. Best effort: a
 * target that cannot be read or deleted is skipped, not thrown.
 */
export async function runDiskCleanup(targets: readonly CleanupTarget[], opts: { maxTier: 1 | 2 }): Promise<CleanupReport> {
  const cleaned: CleanedTarget[] = []
  const skipped: SkippedTarget[] = []
  let totalBytes = 0
  for (const target of targets) {
    if (target.tier > opts.maxTier) continue
    try {
      const stat = await lstat(target.path)
      if (!stat.isDirectory()) {
        skipped.push({ path: target.path, reason: 'not a directory' })
        continue
      }
      const result = target.mode === 'prune' ? await prune(target.path) : await wipe(target.path)
      if (result.files > 0) {
        cleaned.push({ path: target.path, freedMb: MB_ROUND(result.bytes), files: result.files })
        totalBytes += result.bytes
      }
    } catch (err) {
      if (err instanceof Skip) skipped.push({ path: target.path, reason: `${err.reason}: ${err.message}` })
      else skipped.push({ path: target.path, reason: 'missing' })
    }
  }
  return { freedMb: MB_ROUND(totalBytes), cleaned, skipped }
}
