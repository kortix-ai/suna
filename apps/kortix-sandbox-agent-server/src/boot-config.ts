import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as tar from 'tar'
import {
  isPlainConfigDir,
  isPlainRelativePath,
  type ConfigReleaseFile,
} from './config-release/descriptor'
import { logger } from './logger'
import { managedSkillsDir } from './managed-skills'

/**
 * The store of config releases, OUTSIDE the repository.
 * Spec: docs/specs/config-releases.md, "Daemon".
 *
 * WHY IT EXISTS. OpenCode reads its agents, skills, tools and plugins from
 * `OPENCODE_CONFIG_DIR`. That used to be `/workspace/.kortix/opencode`: the
 * project's tracked source, the session's scratch space, and the runtime's
 * config, in one directory. A config reload then wrote the base branch's files
 * into the session's tracked tree. An agent's `git add -A` swept them into a
 * session commit, and the change request's merge conflicted on a file nobody
 * in the session touched (measured 2026-09-18). The platform never writes
 * `/workspace` now.
 *
 * WHAT IT IS. One directory per config release, `<root>/<release_id>/`, built
 * from the config archive the API serves. Beside it, `<root>/<release_id>.json`
 * holds the release manifest: the file list with Git blob IDs and the compiled
 * governance. The manifest is how a restarted daemon verifies a release and
 * composes the same config without the API.
 *
 * TRUST. The descriptor arrives over TLS from the API. The archive store is
 * untrusted transport: every extracted file is hashed as a Git blob and
 * compared to the descriptor, and a file the descriptor does not list is
 * refused. The in-box agent runs as the same user with sudo, so read-only
 * mode bits only stop accidents. The guarantee is `verifyRelease`, which runs
 * before every spawn: a copy that does not match is rebuilt or skipped.
 */

/**
 * `/opt/kortix` is the daemon's own writable state directory. The override
 * exists for tests and for images that mount that path read-only.
 */
export function bootConfigRoot(): string {
  return (process.env.KORTIX_BOOT_CONFIG_ROOT ?? '').trim() || '/opt/kortix/config'
}
const POINTER_FILE = 'current.json'
const QUARANTINE_FILE = 'quarantine.json'

/** Decompressed archive ceiling. The compressed archive is capped at 4 MiB. */
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024

const RELEASE_ID = /^[0-9a-f]{64}$/
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Written by the platform INTO a release after extraction, so neither sealed
 * nor verified afterwards: OpenCode's installer rewrites the plugin pin and the
 * lockfile at spawn, and dependencies are linked in from the image's baked set.
 * Extraction itself verifies these files like every other file.
 */
const PLATFORM_WRITTEN = new Set(['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json'])
const PLATFORM_WRITTEN_DIRS = new Set(['node_modules'])

/** Everything the daemon keeps about a release, beside its directory. */
export interface ReleaseManifest {
  release_id: string
  source_commit: string
  config_dir: string
  config_tree_id: string
  /** The API path of the archive, to rebuild a tampered copy. */
  archive_url: string
  archive_bytes: number
  files: ConfigReleaseFile[]
  compiled_governance: string | null
  compiled_governance_etag: string | null
}

/** `/opt/kortix/config/current.json`: the last release proven on this box. */
export interface BootConfigPointer {
  release_id: string
  source_commit: string
  config_dir: string
  dir: string
  proven: boolean
}

export interface QuarantineEntry {
  reason: string
  at: string
}

export function isReleaseId(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_ID.test(value)
}

export function releaseDir(root: string, releaseId: string): string {
  if (!isReleaseId(releaseId)) throw new Error('boot config: release_id must be 64 hex characters')
  return join(root, releaseId)
}

function manifestPath(root: string, releaseId: string): string {
  return `${releaseDir(root, releaseId)}.json`
}

function run(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stderr }))
  })
}

async function managedSkillNames(dir: string | undefined): Promise<Set<string>> {
  // `undefined` means "the box's overlay", never "no managed skills".
  const entries = await readdir(dir ?? managedSkillsDir(), { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

/**
 * One writer or reader of the release store's managed-skill state at a time.
 *
 * `verifyRelease` reads the overlay's skill names, then walks the release.
 * The runtime-assets pass rewrites the overlay and injects it into the running
 * release. Interleaved, a walk sees an injected skill that the names it read
 * did not include, reports an ADDED file, and the convergence rebuilds the
 * release and respawns OpenCode (DEF-5, 3 of 20 fresh boots, 2026-09-22).
 * Everything that reads or writes that state runs under this lock. In-process
 * only: the daemon is the single writer of `/opt/kortix`.
 */
let releaseStoreQueue: Promise<unknown> = Promise.resolve()
export function withReleaseStoreLock<T>(section: () => Promise<T>): Promise<T> {
  const run = releaseStoreQueue.then(section, section)
  releaseStoreQueue = run.catch(() => undefined)
  return run
}

/** Is `dir` a release in the store (the platform's own copy)? */
export function isInReleaseStore(dir: string, root: string = bootConfigRoot()): boolean {
  return insideRoot(root, dir)
}

/** A path inside a release the platform writes after extraction. */
function isPlatformWritten(path: string, managed: Set<string>): boolean {
  const [first, second] = path.split('/')
  if (!first) return false
  if (PLATFORM_WRITTEN_DIRS.has(first)) return true
  if (path === first && PLATFORM_WRITTEN.has(first)) return true
  return first === 'skills' && second !== undefined && managed.has(second)
}

function gitBlobId(content: Buffer, idLength: number): string {
  const hash = createHash(idLength === 64 ? 'sha256' : 'sha1')
  hash.update(`blob ${content.length}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Every path is a plain relative path, unique, and no listed path is inside
 * another listed path. A Git tree cannot hold both `a` and `a/b`; refusing it
 * here means a listed symlink can never be the parent of a written file.
 */
function assertFileList(files: readonly ConfigReleaseFile[]): void {
  if (files.length === 0) throw new Error('boot config: a release lists no files')
  const paths = new Set<string>()
  for (const [path, mode, blob] of files) {
    if (!isPlainRelativePath(path)) throw new Error(`boot config: unsafe path ${JSON.stringify(path)}`)
    if (!['100644', '100755', '120000'].includes(mode)) throw new Error(`boot config: unsupported mode ${mode}`)
    if (!OBJECT_ID.test(blob)) throw new Error(`boot config: malformed blob ID for ${path}`)
    if (paths.has(path)) throw new Error(`boot config: duplicate path ${path}`)
    paths.add(path)
  }
  for (const path of paths) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      if (paths.has(parts.slice(0, depth).join('/'))) throw new Error(`boot config: ${path} is inside a listed file`)
    }
  }
}

interface ArchiveMember {
  kind: 'file' | 'symlink'
  content: Buffer
  executable: boolean
}

/** Read a `tar.gz` into memory. Directories and pax headers are skipped; anything else is refused. */
async function readArchive(archive: Buffer): Promise<Map<string, ArchiveMember>> {
  let tarBytes: Buffer
  try {
    tarBytes = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES })
  } catch (err) {
    throw new Error(`boot config: the archive does not decompress: ${(err as Error).message}`)
  }
  const members = new Map<string, ArchiveMember>()
  const problems: string[] = []
  const pending: Promise<void>[] = []
  await new Promise<void>((resolvePromise, reject) => {
    const parser = new tar.Parser({ strict: true })
    parser.on('entry', (entry: tar.ReadEntry) => {
      const path = entry.path.replace(/\/+$/, '')
      if (entry.type === 'Directory') {
        entry.resume()
        return
      }
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'SymbolicLink') {
        problems.push(`${path}: unsupported entry type ${entry.type}`)
        entry.resume()
        return
      }
      if (members.has(path)) problems.push(`${path}: listed twice in the archive`)
      if (entry.type === 'SymbolicLink') {
        members.set(path, { kind: 'symlink', content: Buffer.from(entry.linkpath ?? ''), executable: false })
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      pending.push(
        new Promise<void>((done) => {
          entry.on('data', (chunk: Buffer) => chunks.push(chunk))
          entry.on('end', () => {
            members.set(path, {
              kind: 'file',
              content: Buffer.concat(chunks),
              executable: ((entry.mode ?? 0) & 0o111) !== 0,
            })
            done()
          })
        }),
      )
    })
    parser.on('error', reject)
    parser.on('end', () => resolvePromise())
    parser.end(tarBytes)
  })
  await Promise.all(pending)
  if (problems.length > 0) throw new Error(`boot config: archive refused: ${problems.join('; ')}`)
  return members
}

/**
 * Extract a config archive into `staged`, and verify it on the way in.
 *
 * Nothing is written until every member has been checked: each listed file is
 * present with the listed type and blob ID, and the archive holds no file the
 * list does not name. Files are written by this code, never by `tar -x`, so an
 * archive cannot place anything outside `staged`.
 */
export async function extractConfigArchive(
  archive: Buffer,
  files: readonly ConfigReleaseFile[],
  staged: string,
): Promise<void> {
  assertFileList(files)
  const members = await readArchive(archive)
  const listed = new Map(files.map(([path, mode, blob]) => [path, { mode, blob }]))
  const unlisted = [...members.keys()].filter((path) => !listed.has(path))
  if (unlisted.length > 0) throw new Error(`boot config: archive holds unlisted files: ${unlisted.slice(0, 5).join(', ')}`)
  for (const [path, { mode, blob }] of listed) {
    const member = members.get(path)
    if (!member) throw new Error(`boot config: archive is missing ${path}`)
    if ((mode === '120000') !== (member.kind === 'symlink')) throw new Error(`boot config: ${path} has the wrong type`)
    if (gitBlobId(member.content, blob.length) !== blob) throw new Error(`boot config: ${path} does not match its blob ID`)
  }

  await mkdir(staged, { recursive: true })
  const symlinks: Array<[string, Buffer]> = []
  for (const [path, { mode }] of listed) {
    const member = members.get(path)!
    const target = join(staged, path)
    await mkdir(dirname(target), { recursive: true })
    if (mode === '120000') symlinks.push([target, member.content])
    else await writeFile(target, member.content, { mode: mode === '100755' ? 0o755 : 0o644 })
  }
  // Last, so no written file can pass through a link.
  for (const [target, linkText] of symlinks) await symlink(linkText.toString('utf8'), target)
}

export async function writeReleaseManifest(root: string, manifest: ReleaseManifest): Promise<void> {
  await mkdir(root, { recursive: true })
  const staged = join(root, `${manifest.release_id}.json.${randomUUID()}.tmp`)
  await writeFile(staged, `${JSON.stringify(manifest)}\n`, { mode: 0o644 })
  await rename(staged, manifestPath(root, manifest.release_id))
}

/** The manifest of a release in the store, or null when it is missing or malformed. */
export async function readReleaseManifest(root: string, releaseId: string): Promise<ReleaseManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(root, releaseId), 'utf8')) as ReleaseManifest
    if (parsed.release_id !== releaseId) return null
    if (!OBJECT_ID.test(parsed.source_commit) || !OBJECT_ID.test(parsed.config_tree_id)) return null
    if (typeof parsed.config_dir !== 'string' || !isPlainConfigDir(parsed.config_dir)) return null
    if (typeof parsed.archive_url !== 'string' || !Array.isArray(parsed.files)) return null
    if (parsed.compiled_governance !== null && typeof parsed.compiled_governance !== 'string') return null
    if (parsed.compiled_governance_etag !== null && typeof parsed.compiled_governance_etag !== 'string') return null
    assertFileList(parsed.files)
    return parsed
  } catch {
    return null
  }
}

/**
 * Build `<root>/<release_id>` from a downloaded archive.
 *
 * Extract and verify into `<release_id>.<uuid>.tmp`, run `prepare` there
 * (dependencies, the managed-skill overlay), seal the project files, then
 * rename into place. A reader never sees a half-built release.
 */
export async function materializeRelease(input: {
  root?: string
  manifest: ReleaseManifest
  archive: Buffer
  prepare?: (stagedDir: string) => Promise<void>
  managedSkillsDir?: string
}): Promise<{ dir: string }> {
  const root = input.root ?? bootConfigRoot()
  const { manifest } = input
  const dir = releaseDir(root, manifest.release_id)
  await mkdir(root, { recursive: true })
  const staged = `${dir}.${randomUUID()}.tmp`
  try {
    await extractConfigArchive(input.archive, manifest.files, staged)
    // The overlay injected by `prepare` and the names `seal` skips must be the same set.
    await withReleaseStoreLock(async () => {
      await input.prepare?.(staged)
      await seal(staged, manifest.files, await managedSkillNames(input.managedSkillsDir))
    })
    if (existsSync(dir)) await removeTree(dir)
    await rename(staged, dir)
    // The root is sealed AFTER the rename: renaming a directory needs write
    // permission on the directory itself, so a sealed staging dir cannot be
    // moved into place (EACCES on `rename`).
    await chmod(dir, 0o555).catch(() => undefined)
    await writeReleaseManifest(root, manifest)
  } catch (err) {
    await removeTree(staged).catch(() => undefined)
    throw err
  }
  logger.info('[boot-config] release materialized', {
    releaseId: manifest.release_id,
    sourceCommit: manifest.source_commit,
    dir,
    files: manifest.files.length,
  })
  return { dir }
}

/**
 * Drop the write bit on every project file, on the directories that hold only
 * project files, on `skills/`, and on the release root.
 *
 * The root and `skills/` used to stay writable so the installer and the
 * overlay could create entries there. That left a hole with a bad failure
 * mode, measured on a Daytona box on 2026-09-24 (release `7a60e568`, session
 * `1a685caf`): an agent's `write` tool answered "Wrote file successfully."
 * for `<release>/skills/<name>/SKILL.md` and for a root-level file, and the
 * next convergence then failed `verifyRelease`, rebuilt the release and
 * respawned OpenCode. The user got a success message, the file vanished, and
 * the runtime restarted with nothing said. Reproduced 4 times.
 *
 * A write that will be reverted must fail where it happens, so both are
 * sealed now. The two writers that legitimately need them:
 *
 *  - the dependency pass (`ensureOpencodeConfigDeps`) runs on the STAGED
 *    directory, before this seal, so it is unaffected;
 *  - the managed-skill overlay re-injects into a LIVE release, and unseals
 *    what it needs through `unsealManaged` (`managed-skills.ts`).
 *
 * The ROOT is sealed by `materializeRelease` after the rename, not here:
 * renaming a directory needs write permission on the directory itself.
 *
 * `pruneBootConfigs` already runs `chmod -R u+w` before deleting a release,
 * so the root's mode does not strand an old copy.
 *
 * Verified on the same box: with the root at `0555` OpenCode starts and
 * serves normally. It writes one file there at every spawn, a `.gitignore`
 * of its own bookkeeping, and skips it silently when it cannot — no
 * `EACCES`/`EROFS` in the daemon log or OpenCode's own log.
 */
async function seal(dir: string, files: readonly ConfigReleaseFile[], managed: Set<string>): Promise<void> {
  const sealedDirs = new Set<string>()
  for (const [path, mode] of files) {
    if (isPlatformWritten(path, managed)) continue
    if (mode !== '120000') await chmod(join(dir, path), mode === '100755' ? 0o555 : 0o444)
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) sealedDirs.add(parts.slice(0, depth).join('/'))
  }
  // Deepest first, so a parent is still writable while its children are
  // sealed. `skills/` joins the set; the ROOT is sealed by the caller after
  // the staging directory is renamed into place.
  sealedDirs.add('skills')
  for (const rel of [...sealedDirs].sort((a, b) => b.length - a.length)) {
    await chmod(join(dir, rel), 0o555).catch(() => undefined)
  }
}

export interface ReleaseVerifyInput {
  dir: string
  files: readonly ConfigReleaseFile[]
  managedSkillsDir?: string
}

/**
 * Is every project file in `dir` byte-identical to the release's file list,
 * and is nothing added? Never throws: anything unreadable is "no".
 */
export async function verifyRelease(input: ReleaseVerifyInput): Promise<boolean> {
  return (await verifyReleaseDetail(input)).ok
}

/** `verifyRelease` with the first problem it found, for the log. */
export function verifyReleaseDetail(input: ReleaseVerifyInput): Promise<{ ok: true } | { ok: false; problem: string }> {
  return withReleaseStoreLock(() => verifyReleaseUnlocked(input))
}

async function verifyReleaseUnlocked(
  input: ReleaseVerifyInput,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  let managed = new Set<string>()
  try {
    assertFileList(input.files)
    managed = await managedSkillNames(input.managedSkillsDir)
    for (const [path, mode, blob] of input.files) {
      if (isPlatformWritten(path, managed)) continue
      const onDisk = join(input.dir, path)
      const stat = await lstat(onDisk)
      // A symlink is compared by its target text and never followed: following
      // it would let a swapped link point verification at any file on the box.
      const content =
        mode === '120000'
          ? stat.isSymbolicLink()
            ? Buffer.from(await readlink(onDisk))
            : null
          : stat.isFile()
            ? await readFile(onDisk)
            : null
      if (content === null) return { ok: false, problem: `${path} has the wrong type` }
      if (gitBlobId(content, blob.length) !== blob) return { ok: false, problem: `${path} does not match its blob ID` }
    }
    // Nothing may be ADDED either: a new agent, tool or second `opencode.json`
    // beside the listed files would be loaded like any other.
    const listed = new Set(input.files.map(([path]) => path))
    for (const path of await walkFiles(input.dir, managed)) {
      if (!listed.has(path)) {
        return { ok: false, problem: `${path} is not in the release (managed overlay names: ${managed.size})` }
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, problem: `${(err as Error).message} (managed overlay names: ${managed.size})` }
  }
}

/**
 * Every file in a release that the platform did not write, relative to `dir`.
 * Root-level dotfiles are left out: they are installer output
 * (`.package-lock.json` and the like) and OpenCode reads none of them.
 */
async function walkFiles(dir: string, managed: Set<string>, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (isPlatformWritten(path, managed)) continue
    if (!prefix && entry.name.startsWith('.')) continue
    if (entry.isDirectory()) found.push(...(await walkFiles(dir, managed, path)))
    else found.push(path)
  }
  return found
}

function insideRoot(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(`..${sep}`)
}

/** The last release proven on this box, or null. */
export async function readBootConfigPointer(root: string = bootConfigRoot()): Promise<BootConfigPointer | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, POINTER_FILE), 'utf8')) as Partial<BootConfigPointer>
    if (!isReleaseId(parsed.release_id)) return null
    if (typeof parsed.source_commit !== 'string' || !OBJECT_ID.test(parsed.source_commit)) return null
    if (typeof parsed.config_dir !== 'string' || !isPlainConfigDir(parsed.config_dir)) return null
    if (typeof parsed.dir !== 'string' || typeof parsed.proven !== 'boolean') return null
    // The file sits in a directory the in-box agent can write. A pointer is only
    // honoured when it names the release's own directory inside the store, so it
    // cannot aim OpenCode at an arbitrary directory.
    if (!insideRoot(root, parsed.dir) || resolve(parsed.dir) !== resolve(releaseDir(root, parsed.release_id))) return null
    return {
      release_id: parsed.release_id,
      source_commit: parsed.source_commit,
      config_dir: parsed.config_dir,
      dir: resolve(parsed.dir),
      proven: parsed.proven,
    }
  } catch {
    return null
  }
}

/**
 * `<root>/boot`: the fixed `OPENCODE_CONFIG_DIR` of the process spawned at
 * boot. It is spawned at once, before the checkout and the release exist, and
 * the link is repointed to the chosen config before the workspace gate opens.
 * OpenCode reads the directory at Instance init, on the first
 * directory-scoped request, so the repointed target is what it loads.
 */
export function bootLinkPath(root: string = bootConfigRoot()): string {
  return join(root, 'boot')
}

/** Point the boot link at `target` with one atomic rename. Returns the link path. */
export async function pointBootLink(target: string, root: string = bootConfigRoot()): Promise<string> {
  await mkdir(root, { recursive: true })
  const link = bootLinkPath(root)
  const staged = `${link}.${randomUUID()}.tmp`
  await symlink(resolve(target), staged)
  try {
    // rename(2) replaces the link itself; it never follows it.
    await rename(staged, link)
  } catch (err) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw err
  }
  return link
}

/** Written only after a proven promotion. */
export async function activateBootConfig(root: string, pointer: BootConfigPointer): Promise<void> {
  await mkdir(root, { recursive: true })
  const staged = join(root, `${POINTER_FILE}.${randomUUID()}.tmp`)
  await writeFile(staged, `${JSON.stringify(pointer)}\n`, { mode: 0o644 })
  await rename(staged, join(root, POINTER_FILE))
}

export async function deactivateBootConfig(root: string = bootConfigRoot()): Promise<void> {
  await rm(join(root, POINTER_FILE), { force: true })
}

/** Release IDs that failed on this box. A new release ID is never blocked by an old one. */
export async function readQuarantine(root: string = bootConfigRoot()): Promise<Record<string, QuarantineEntry>> {
  try {
    const parsed = JSON.parse(await readFile(join(root, QUARANTINE_FILE), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries: Record<string, QuarantineEntry> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<QuarantineEntry> | null
      if (isReleaseId(id) && entry && typeof entry.reason === 'string' && typeof entry.at === 'string') {
        entries[id] = { reason: entry.reason, at: entry.at }
      }
    }
    return entries
  } catch {
    return {}
  }
}

export async function quarantineRelease(root: string, releaseId: string, reason: string): Promise<void> {
  if (!isReleaseId(releaseId)) return
  const entries = await readQuarantine(root)
  entries[releaseId] = { reason: reason.slice(0, 500), at: new Date().toISOString() }
  await mkdir(root, { recursive: true })
  const staged = join(root, `${QUARANTINE_FILE}.${randomUUID()}.tmp`)
  await writeFile(staged, `${JSON.stringify(entries)}\n`, { mode: 0o644 })
  await rename(staged, join(root, QUARANTINE_FILE))
}

async function removeTree(dir: string): Promise<void> {
  // Sealed directories refuse `rm` until the write bit is back.
  await run('chmod', ['-R', 'u+w', dir]).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
}

/**
 * Remove every release except `keep`: its directory, its manifest, and any
 * leftover staging directory. The pointer and the quarantine stay.
 */
export async function pruneBootConfigs(root: string, keep: readonly string[]): Promise<void> {
  const kept = new Set(keep)
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === POINTER_FILE || entry.name === QUARANTINE_FILE) continue
    const id = entry.name.slice(0, 64)
    if (kept.has(id) && (entry.name === id || entry.name === `${id}.json`)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await removeTree(path).catch(() => undefined)
    else if (entry.name.endsWith('.json') || entry.name.endsWith('.tmp')) await rm(path, { force: true }).catch(() => undefined)
  }
}
