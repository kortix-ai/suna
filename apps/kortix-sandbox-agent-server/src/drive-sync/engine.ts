import { randomBytes } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../logger'
import { type DriveRemote, DriveSyncRefused, RemoteChanged, type RemoteEntry, sha256File } from './remote'

/**
 * One drive folder in the box, kept in sync with its drive.
 *
 * The box holds a copy of the drive (or of the one folder the mount covers)
 * at the mount path. Every cycle compares three views of each file: what the
 * box has now, what the drive has now, and what both had when they last
 * agreed (the manifest, kept on disk so a stopped and resumed box still knows).
 *
 * - changed only here: pushed (a read-only mount never pushes: the change is
 *   put back from the drive instead);
 * - changed only on the drive: pulled;
 * - changed on both: keep both. The drive's version keeps the name, this
 *   box's version is saved beside it as "name (conflict YYYY-MM-DD HHMM).ext",
 *   the same name Drive itself gives a conflict copy;
 * - deleted on one side and unchanged on the other: deleted on both; deleted
 *   on one side and changed on the other: the changed version is kept;
 * - a file deleted here and the same bytes appearing under a new name here:
 *   a rename, moved on the drive without uploading anything.
 *
 * A local change is pushed once it has been quiet for `settleMs`, so a file
 * still being written is not sent half-written (a flush pushes regardless).
 */

export interface ManifestEntry {
  /** The drive's version token (size:mtime) when both sides last agreed. */
  rv: string
  /** The local size and mtime (ms) when both sides last agreed. */
  ls: number
  lm: number
  sha?: string
}

interface LocalFile {
  size: number
  mtimeMs: number
}

const TEMP_PREFIX = '.kortix-sync-'
const MANIFEST_VERSION = 1

export interface MountSyncOptions {
  remote: DriveRemote
  /** The folder in the box (e.g. /drives/me). */
  localDir: string
  /** The drive folder it mirrors ("/" or the mount's subdir). */
  remoteDir: string
  readOnly: boolean
  /** Where the manifest is kept, outside the synced folder. */
  statePath: string
  settleMs?: number
  /** Re-list the drive at least this often even if its head did not move. */
  relistMs?: number
}

export interface CycleStats {
  pushed: number
  pulled: number
  deletedLocal: number
  deletedRemote: number
  moved: number
  conflicts: number
  refused: number
  pending: number
}

const emptyStats = (): CycleStats => ({
  pushed: 0,
  pulled: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  moved: 0,
  conflicts: 0,
  refused: 0,
  pending: 0,
})

const remoteToken = (e: { size: number; mtime: number }) => `${Number(e.size)}:${Number(e.mtime)}`

/** "notes (conflict 2026-10-03 1405).md" next to "notes.md". Same shape as Drive's own copies. */
export function conflictCopyName(name: string, at: Date, n = 1): string {
  let stem = name
  let ext = ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && name.length - dot <= 10) {
    stem = name.slice(0, dot)
    ext = name.slice(dot)
  }
  // A copy of a copy is named after the original.
  stem = stem.replace(/ \(conflict [^()]*\)$/, '')
  const pad = (v: number) => String(v).padStart(2, '0')
  const tag = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`
  return `${stem} (conflict ${tag}${n > 1 ? ` ${n}` : ''})${ext}`
}

export class MountSync {
  readonly opts: Required<MountSyncOptions>
  private manifest = new Map<string, ManifestEntry>()
  private loaded = false
  private lastHead: string | null | undefined = undefined
  private lastListAt = 0
  private remoteFiles = new Map<string, RemoteEntry>()
  private remoteDirs = new Set<string>()
  private running: Promise<CycleStats> | null = null

  constructor(opts: MountSyncOptions) {
    this.opts = {
      settleMs: 2_000,
      relistMs: 60_000,
      ...opts,
      remoteDir: opts.remoteDir === '/' ? '' : opts.remoteDir.replace(/\/$/, ''),
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.opts.readOnly = readOnly
  }

  /** One sync pass. Calls never overlap: a second caller waits for the first and runs after it. */
  async cycle(opts: { flush?: boolean } = {}): Promise<CycleStats> {
    const prev = this.running
    const next = (async () => {
      await prev?.catch(() => {})
      return this.runCycle(opts.flush === true)
    })()
    this.running = next
    try {
      return await next
    } finally {
      if (this.running === next) this.running = null
    }
  }

  private remotePath(rel: string): string {
    return `${this.opts.remoteDir}/${rel}`
  }

  private localPath(rel: string): string {
    return join(this.opts.localDir, ...rel.split('/'))
  }

  private async loadManifest(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.opts.statePath, 'utf8')) as {
        v?: number
        files?: Record<string, ManifestEntry>
      }
      if (raw.v === MANIFEST_VERSION && raw.files) this.manifest = new Map(Object.entries(raw.files))
    } catch {
      this.manifest = new Map()
    }
  }

  private async saveManifest(): Promise<void> {
    await mkdir(dirname(this.opts.statePath), { recursive: true })
    const tmp = `${this.opts.statePath}.${randomBytes(4).toString('hex')}`
    await writeFile(tmp, JSON.stringify({ v: MANIFEST_VERSION, files: Object.fromEntries(this.manifest) }))
    await rename(tmp, this.opts.statePath)
  }

  private async refreshRemote(force: boolean): Promise<void> {
    const head = await this.opts.remote.head()
    const stale = Date.now() - this.lastListAt >= this.opts.relistMs
    if (!force && !stale && head === this.lastHead) return
    const entries = head === null ? [] : await this.opts.remote.list(this.opts.remoteDir || '/')
    const files = new Map<string, RemoteEntry>()
    const dirs = new Set<string>()
    const prefix = `${this.opts.remoteDir}/`
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue
      const rel = e.path.slice(prefix.length)
      if (!rel || rel === 'lost+found' || rel.startsWith('lost+found/')) continue
      if (e.type === 'file') files.set(rel, e)
      else if (e.type === 'dir') dirs.add(rel)
    }
    this.remoteFiles = files
    this.remoteDirs = dirs
    this.lastHead = head
    this.lastListAt = Date.now()
  }

  private async scanLocal(): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>()
    const walk = async (dir: string, rel: string): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (name.startsWith(TEMP_PREFIX)) continue
        const childRel = rel ? `${rel}/${name}` : name
        if (!rel && name === 'lost+found') continue
        const full = join(dir, name)
        const st = await lstat(full).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) await walk(full, childRel)
        else if (st.isFile()) out.set(childRel, { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) })
      }
    }
    await walk(this.opts.localDir, '')
    return out
  }

  private async localStat(rel: string): Promise<LocalFile | null> {
    const st = await lstat(this.localPath(rel)).catch(() => null)
    return st?.isFile() ? { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) } : null
  }

  /** Pull the drive's file into place, unless the local file changed since `expect` was read. */
  private async pull(rel: string, entry: RemoteEntry, expect: LocalFile | null): Promise<boolean> {
    const dest = this.localPath(rel)
    await mkdir(dirname(dest), { recursive: true })
    const tmp = join(dirname(dest), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
    try {
      const sha = await this.opts.remote.download(this.remotePath(rel), tmp)
      const now = await this.localStat(rel)
      const same = (a: LocalFile | null, b: LocalFile | null) =>
        (!a && !b) || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs)
      if (!same(now, expect)) {
        // Written here while the download ran: the next cycle sees both changes.
        await rm(tmp, { force: true })
        return false
      }
      if (this.opts.readOnly) await chmod(tmp, 0o444)
      await rename(tmp, dest)
      const st = (await this.localStat(rel))!
      this.manifest.set(rel, { rv: remoteToken(entry), ls: st.size, lm: st.mtimeMs, sha })
      return true
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Push the local file. Returns 'conflict' when the drive's file changed since both last agreed. */
  private async push(rel: string, local: LocalFile): Promise<'ok' | 'conflict' | 'changed'> {
    const base = this.manifest.get(rel)
    const before = await this.opts.remote.stat(this.remotePath(rel))
    // Gone from the drive: the change here re-creates it.
    const drifted = before ? !base || remoteToken(before) !== base.rv : false
    if (drifted) return 'conflict'
    // Conditional on the version just checked: a write landing on the drive
    // in between is refused by the API (409), and both versions are kept.
    let uploaded: { version: string | null; sha256: string }
    try {
      uploaded = await this.opts.remote.upload(this.remotePath(rel), this.localPath(rel), before ? remoteToken(before) : 'absent')
    } catch (err) {
      if (err instanceof RemoteChanged) return 'conflict'
      throw err
    }
    const { version, sha256 } = uploaded
    const after = await this.opts.remote.stat(this.remotePath(rel))
    const now = await this.localStat(rel)
    // Someone else wrote the path right after this upload: keep the old base, so
    // the next cycle sees the drive changed and pulls their version.
    const theirs = !after || (version !== null && after.version !== null && after.version !== version)
    const rv = theirs ? (base?.rv ?? 'gone') : remoteToken(after!)
    if (!now || now.size !== local.size || now.mtimeMs !== local.mtimeMs) {
      // Changed again while uploading: record what was sent, the next cycle sends the rest.
      this.manifest.set(rel, { rv, ls: local.size, lm: local.mtimeMs, sha: sha256 })
      return 'changed'
    }
    this.manifest.set(rel, { rv, ls: now.size, lm: now.mtimeMs, sha: sha256 })
    if (after) this.remoteFiles.set(rel, { path: this.remotePath(rel), type: 'file', size: after.size, mtime: after.mtime })
    return 'ok'
  }

  /** Keep both: this box's version moves aside as a conflict copy (pushed), the drive's takes the name. */
  private async keepBoth(rel: string, local: LocalFile, entry: RemoteEntry | undefined, stats: CycleStats): Promise<void> {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const name = rel.slice(dir ? dir.length + 1 : 0)
    let copyRel = ''
    for (let n = 1; n < 1000; n++) {
      const candidate = (dir ? `${dir}/` : '') + conflictCopyName(name, new Date(local.mtimeMs), n)
      if (!this.remoteFiles.has(candidate) && !(await this.localStat(candidate))) {
        copyRel = candidate
        break
      }
    }
    await rename(this.localPath(rel), this.localPath(copyRel))
    stats.conflicts++
    logger.warn('[drive-sync] conflict: kept both versions', { path: rel, copy: copyRel })
    const moved = await this.localStat(copyRel)
    if (moved) {
      const r = await this.push(copyRel, moved)
      if (r !== 'conflict') stats.pushed++
    }
    if (entry) {
      await this.pull(rel, entry, null)
      stats.pulled++
    } else {
      this.manifest.delete(rel)
    }
  }

  private async runCycle(flush: boolean): Promise<CycleStats> {
    const stats = emptyStats()
    await this.loadManifest()
    await mkdir(this.opts.localDir, { recursive: true })
    await this.refreshRemote(false)
    const local = await this.scanLocal()
    const remote = this.remoteFiles
    const settled = (l: LocalFile) => flush || Date.now() - l.mtimeMs >= this.opts.settleMs
    const writable = !this.opts.readOnly

    const changedHere = (rel: string, l: LocalFile | undefined, m: ManifestEntry | undefined) =>
      !!l && (!m || l.size !== m.ls || l.mtimeMs !== m.lm)
    const changedThere = (rel: string, r: RemoteEntry | undefined, m: ManifestEntry | undefined) =>
      !!r && (!m || remoteToken(r) !== m.rv)

    // Renames: a file gone from here, unchanged on the drive, whose bytes now sit under a new name here.
    const handled = new Set<string>()
    if (writable) {
      const gone = [...this.manifest.entries()].filter(
        ([rel, m]) => !local.has(rel) && m.sha && remote.has(rel) && !changedThere(rel, remote.get(rel), m),
      )
      const fresh = [...local.entries()].filter(([rel, l]) => !this.manifest.has(rel) && !remote.has(rel) && settled(l))
      for (const [oldRel, m] of gone) {
        const candidates = fresh.filter(([rel, l]) => !handled.has(rel) && l.size === m.ls)
        for (const [newRel, l] of candidates) {
          if ((await sha256File(this.localPath(newRel)).catch(() => null)) !== m.sha) continue
          try {
            await this.opts.remote.move(this.remotePath(oldRel), this.remotePath(newRel))
          } catch (err) {
            if (err instanceof DriveSyncRefused) break
            throw err
          }
          const r = remote.get(oldRel)!
          remote.delete(oldRel)
          remote.set(newRel, { ...r, path: this.remotePath(newRel) })
          this.manifest.delete(oldRel)
          this.manifest.set(newRel, { rv: m.rv, ls: l.size, lm: l.mtimeMs, sha: m.sha })
          handled.add(oldRel).add(newRel)
          stats.moved++
          break
        }
      }
    }

    let ops = 0
    const paths = new Set<string>([...this.manifest.keys(), ...local.keys(), ...remote.keys()])
    for (const rel of [...paths].sort()) {
      if (handled.has(rel)) continue
      const m = this.manifest.get(rel)
      const l = local.get(rel)
      const r = remote.get(rel)
      const here = changedHere(rel, l, m)
      const there = changedThere(rel, r, m)
      try {
        if (l && r && !here && !there) continue
        if (!l && !r) {
          this.manifest.delete(rel)
          continue
        }
        if (l && !r) {
          if (m && !here) {
            // Deleted on the drive, untouched here.
            await rm(this.localPath(rel), { force: true })
            this.manifest.delete(rel)
            stats.deletedLocal++
          } else if (!writable) {
            // A read-only drive: a file only this box has is never sent.
            if (m) {
              await rm(this.localPath(rel), { force: true })
              this.manifest.delete(rel)
              stats.deletedLocal++
            }
            stats.refused += here ? 1 : 0
          } else if (!settled(l)) {
            stats.pending++
          } else {
            // New here, or changed here while the drive deleted it: the change is kept.
            const res = await this.push(rel, l)
            if (res === 'conflict') {
              await this.refreshRemote(true)
              await this.keepBoth(rel, l, this.remoteFiles.get(rel), stats)
            } else stats.pushed++
          }
          continue
        }
        if (!l && r) {
          if (m && !there && writable) {
            // Deleted here, untouched on the drive.
            await this.opts.remote.remove(this.remotePath(rel))
            remote.delete(rel)
            this.manifest.delete(rel)
            stats.deletedRemote++
          } else {
            // New on the drive, changed there (a change wins over a delete), or a read-only drive.
            if (m && !writable && !there) stats.refused++
            if (await this.pull(rel, r, null)) stats.pulled++
          }
          continue
        }
        // Both sides have the file.
        if (here && !there) {
          if (!writable) {
            stats.refused++
            if (await this.pull(rel, r!, l!)) stats.pulled++
          } else if (!settled(l!)) {
            stats.pending++
          } else {
            const res = await this.push(rel, l!)
            if (res === 'conflict') {
              await this.refreshRemote(true)
              await this.keepBoth(rel, l!, this.remoteFiles.get(rel), stats)
            } else stats.pushed++
          }
        } else if (there && !here) {
          if (await this.pull(rel, r!, l!)) stats.pulled++
        } else {
          // Changed on both sides (or new on both without a shared base).
          const sameBytes = l!.size === Number(r!.size) ? await this.sameAsRemote(rel, r!) : false
          if (sameBytes) continue
          if (!writable) {
            stats.refused++
            if (await this.pull(rel, r!, l!)) stats.pulled++
          } else if (!settled(l!)) {
            stats.pending++
          } else {
            await this.keepBoth(rel, l!, r!, stats)
          }
        }
      } catch (err) {
        if (err instanceof DriveSyncRefused) {
          stats.refused++
          logger.warn('[drive-sync] refused', { path: rel, status: err.status, error: err.message })
          continue
        }
        throw err
      } finally {
        if (++ops % 50 === 0) await this.saveManifest().catch(() => {})
      }
    }
    // Folders the drive has and this box does not (an empty folder made in the web app).
    for (const dir of this.remoteDirs) {
      await mkdir(this.localPath(dir), { recursive: true }).catch(() => {})
    }
    await this.saveManifest()
    return stats
  }

  /** New on both sides with no shared base: equal bytes are not a conflict. */
  private async sameAsRemote(rel: string, r: RemoteEntry): Promise<boolean> {
    const tmp = join(dirname(this.localPath(rel)), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`)
    try {
      const sha = await this.opts.remote.download(this.remotePath(rel), tmp)
      const localSha = await sha256File(this.localPath(rel))
      if (sha !== localSha) return false
      const l = (await this.localStat(rel))!
      this.manifest.set(rel, { rv: remoteToken(r), ls: l.size, lm: l.mtimeMs, sha })
      return true
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** Is anything here not yet on the drive? */
  async pendingLocalChanges(): Promise<number> {
    await this.loadManifest()
    const local = await this.scanLocal()
    let n = 0
    for (const [rel, l] of local) {
      const m = this.manifest.get(rel)
      if (!m || m.ls !== l.size || m.lm !== l.mtimeMs) n++
    }
    for (const rel of this.manifest.keys()) if (!local.has(rel)) n++
    return this.opts.readOnly ? 0 : n
  }

  /**
   * Keep the local copy at `dest` instead of deleting it: the drive left the
   * session (or turned read-only) with changes the drive does not have.
   * `move` false copies it, leaving the mount in place.
   */
  async setAside(dest: string, move: boolean): Promise<void> {
    await mkdir(dirname(dest), { recursive: true })
    if (move) {
      await rename(this.opts.localDir, dest)
      await rm(this.opts.statePath, { force: true }).catch(() => {})
    } else {
      await cp(this.opts.localDir, dest, { recursive: true, filter: (src) => !src.split('/').pop()!.startsWith(TEMP_PREFIX) })
    }
  }

  /** Remove the local copy and its state (the drive left the session). */
  async discard(): Promise<void> {
    await rm(this.opts.localDir, { recursive: true, force: true }).catch(() => {})
    await rm(this.opts.statePath, { force: true }).catch(() => {})
  }
}

export async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}
