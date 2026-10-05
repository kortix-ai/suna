import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '@/lib/log/logger'
import type { OverlayFile, RuntimeAssetsState } from './runtime-assets'

/**
 * Byte-for-byte the API's `managedSkillOverlayHash`. Recomputed here so a
 * truncated or tampered response is rejected instead of overwriting a working
 * overlay with a partial one — the payload arrives over HTTP and its length is
 * not otherwise checked.
 */
export function overlayHash(files: OverlayFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`file\0${file.path}\0${Buffer.byteLength(file.content)}\0`)
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Is this a path the overlay may write?
 *
 * The response comes from the API over TLS, so this is defense in depth rather
 * than the only guard — but a write loop that takes a server-supplied path and
 * has no such check is one compromised response away from writing anywhere the
 * daemon can reach, and the daemon is root.
 */
export function isSafeOverlayPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('-')) return false
  if (!path.startsWith('kortix-')) return false
  return path
    .split('/')
    .every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && /^[\w .-]+$/.test(seg))
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

export async function readState(path: string): Promise<RuntimeAssetsState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RuntimeAssetsState
  } catch {
    return {}
  }
}

export async function writeState(path: string, state: RuntimeAssetsState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8')
  } catch (err) {
    // The cache is an optimization. Losing it costs one re-hash, not correctness.
    logger.warn('[runtime-assets] could not persist digest state', { err: String(err) })
  }
}

/**
 * Read a baked overlay back off disk as the file list {@link overlayHash} takes.
 *
 * Byte-for-byte the shape `managedSkillOverlayFiles()` produces in the API:
 * paths relative to the overlay root, sorted with `localeCompare`. Both sides
 * must agree or the hash this module records would never match the one the
 * manifest advertises, and every box would re-download an overlay it already
 * has.
 */
export async function readOverlayFromDisk(dir: string): Promise<OverlayFile[]> {
  let entries: string[]
  try {
    entries = (await readdir(dir, { recursive: true })) as string[]
  } catch {
    return []
  }
  const files: OverlayFile[] = []
  for (const rel of [...entries].sort((a, b) => a.localeCompare(b))) {
    // Read directly rather than stat-then-read: a directory answers EISDIR and
    // an unreadable entry answers its own errno, so the filter costs nothing
    // and there is no window between the check and the use (CodeQL
    // js/file-system-race).
    const content = await readFile(join(dir, rel), 'utf8').catch(() => null)
    if (content === null) continue
    files.push({ path: rel, content })
  }
  return files
}
