import fs from 'node:fs/promises'
import path from 'node:path'

/** Metadata-only bounded walk: which regular files changed since `sinceMs`.
 * Never reads file contents, never follows symlinks; fail-soft on caps. */
export type ChangedFileEntry = { path: string; absolute: string; mtime: number; size: number }
export type ChangedScanResult = { files: ChangedFileEntry[]; truncated: boolean }
export type ChangedScanLimits = { maxVisited?: number; maxResults?: number; timeBudgetMs?: number }

const SKIP_DIR_NAMES = new Set(['node_modules', '__pycache__', 'venv'])
const DENY_FILE_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'uv.lock', 'poetry.lock', 'Cargo.lock',
])
const DEFAULTS = { maxVisited: 50_000, maxResults: 500, timeBudgetMs: 2_000 }

/** True for a hidden segment (dotfile/dotdir — covers .git, dotenv files,
 * .DS_Store) or a lockfile name. The single source of truth for "never a
 * work-product item" — reused by both the bounded walk below and the
 * git-status-based workspace-recovery path (`acp/output-scan.ts`) so the
 * deny list never forks. */
export function isDeniedChangeName(name: string): boolean {
  return name.startsWith('.') || DENY_FILE_NAMES.has(name)
}

export async function collectChangedFiles(
  workspace: string,
  sinceMs: number,
  isIgnored: (absPaths: string[]) => Promise<Set<string>>,
  limits: ChangedScanLimits = {},
): Promise<ChangedScanResult> {
  const { maxVisited, maxResults, timeBudgetMs } = { ...DEFAULTS, ...limits }
  const deadline = Date.now() + timeBudgetMs
  const candidates: ChangedFileEntry[] = []
  let visited = 0
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return
    if (Date.now() > deadline) { truncated = true; return }
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable subtree — siblings survive
    }
    for (const entry of entries) {
      if (truncated) return
      if (++visited > maxVisited || Date.now() > deadline) { truncated = true; return }
      if (isDeniedChangeName(entry.name)) continue // hidden segment or a lockfile
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue // symlinks/sockets/fifos never qualify
      let stat: import('node:fs').Stats
      try {
        stat = await fs.lstat(absolute)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.mtimeMs < sinceMs) continue
      candidates.push({
        path: path.relative(workspace, absolute),
        absolute,
        mtime: Math.round(stat.mtimeMs),
        size: stat.size,
      })
    }
  }

  await walk(workspace)

  const ignored = await isIgnored(candidates.map((c) => c.absolute)).catch(() => new Set<string>())
  const files = candidates
    .filter((c) => !ignored.has(c.absolute))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
  if (files.length > maxResults) {
    truncated = true
    files.length = maxResults
  }
  return { files, truncated }
}
