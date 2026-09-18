import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { logger } from './logger'

/**
 * The converged OpenCode config directory, OUTSIDE the repository.
 *
 * WHY IT EXISTS. OpenCode reads its agents, skills, tools and plugins from
 * `OPENCODE_CONFIG_DIR`, and that used to be `/workspace/.kortix/opencode` —
 * one directory doing three jobs: the project's tracked source, the session's
 * scratch space, and the runtime's working directory. A config reload therefore
 * wrote the base branch's files into the session's tracked working tree, and
 * everything downstream of that was a guard against its own side effects:
 * telling the platform's writes from the session's by reading `git status`,
 * remembering the previous sync so the next one did not mistake it for an edit,
 * and surviving an agent's `git add -A`. The last one could not be survived.
 * Measured 2026-09-18 with real git: the swept-in bytes showed up in the change
 * request as "modified by the session", and the merge CONFLICTED on a file
 * nobody in the session had touched.
 *
 * WHAT IT IS. `git archive <sha>:<config dir>` extracted into
 * `<root>/<sha>/`. Content-addressed by the commit, so "which config is this
 * box running" has an exact answer. The platform never writes `/workspace`.
 *
 * READ-ONLY IS NOT THE GUARANTEE. The agent runs as the same user as this
 * daemon and has sudo, so a mode bit is a guard against ACCIDENTS — an agent
 * that edits the wrong copy gets EACCES instead of a change that silently
 * evaporates. The guarantee is `verifyBootConfig`: every project file is
 * re-hashed against the commit before a spawn, and a copy that does not match is
 * thrown away and rebuilt. An edit here never survives.
 *
 * `/workspace` stays the floor. No pointer, a pointer that fails verification,
 * or an extraction that fails all resolve to the working-tree config dir — the
 * behaviour every box had before this existed.
 */

/**
 * Beside `agent.current` and the runtime-assets state: `/opt/kortix` is the
 * daemon's own writable state directory. The override exists for tests and for
 * images that mount that path read-only.
 */
export function bootConfigRoot(): string {
  return (process.env.KORTIX_BOOT_CONFIG_ROOT ?? '').trim() || '/opt/kortix/config'
}
const POINTER_FILE = 'current.json'

/**
 * Written by the platform INTO the copy, so neither sealed nor verified:
 * opencode's installer rewrites the plugin pin and the lockfile at spawn, and
 * dependencies are linked in from the image's baked set.
 */
const PLATFORM_WRITTEN = new Set(['package.json', 'bun.lock', 'bun.lockb', 'package-lock.json'])
const PLATFORM_WRITTEN_DIRS = new Set(['node_modules'])

export interface BootConfigPointer {
  sha: string
  /** Repo-relative config dir the copy was cut from — it follows the manifest. */
  relConfigDir: string
  dir: string
}

export interface BootConfigInput {
  /** The session checkout. Only its OBJECT STORE is read; it is never written. */
  repo: string
  sha: string
  relConfigDir: string
  root?: string
  /** Skill directories the managed overlay owns; rewritten by runtime-assets. */
  managedSkillsDir?: string
}

const SHA = /^[0-9a-f]{40,64}$/

/**
 * `relConfigDir` comes from a repository-controlled manifest and ends up inside
 * a git tree-ish. Same rule as the daemon's other manifest readers: a literal
 * relative path and nothing cleverer.
 */
function assertSafeInput(input: { sha: string; relConfigDir: string }): void {
  if (!SHA.test(input.sha)) throw new Error('boot config: sha must be a full commit id')
  const rel = input.relConfigDir
  const plain =
    rel.length > 0 &&
    !isAbsolute(rel) &&
    rel.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && /^[\w .-]+$/.test(part)) &&
    !rel.startsWith('-')
  if (!plain) throw new Error('boot config: config dir must be a plain relative path')
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; input?: Buffer } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr }))
    child.stdin.end(opts.input)
  })
}

async function managedSkillNames(managedSkillsDir: string | undefined): Promise<Set<string>> {
  if (!managedSkillsDir) return new Set()
  const entries = await readdir(managedSkillsDir, { withFileTypes: true }).catch(() => [])
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
}

/** A path inside the copy the platform writes after extraction. */
function isPlatformWritten(path: string, managed: Set<string>): boolean {
  const [first, second] = path.split('/')
  if (!first) return false
  if (PLATFORM_WRITTEN_DIRS.has(first)) return true
  if (path === first && PLATFORM_WRITTEN.has(first)) return true
  return first === 'skills' && second !== undefined && managed.has(second)
}

interface TreeEntry {
  mode: string
  blob: string
  path: string
}

async function listTree(input: BootConfigInput): Promise<TreeEntry[]> {
  const listed = await run('git', ['-C', input.repo, 'ls-tree', '-r', '-z', `${input.sha}:${input.relConfigDir}`])
  if (listed.code !== 0) {
    throw new Error(`boot config: ${input.relConfigDir} is not in ${input.sha.slice(0, 12)}: ${listed.stderr.trim()}`)
  }
  const entries: TreeEntry[] = []
  for (const row of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t')
    const [mode, type, blob] = row.slice(0, tab).split(' ')
    if (tab > 0 && mode && blob && type === 'blob') entries.push({ mode, blob, path: row.slice(tab + 1) })
  }
  if (entries.length === 0) throw new Error(`boot config: ${input.relConfigDir} is empty at ${input.sha.slice(0, 12)}`)
  return entries
}

export function bootConfigDir(root: string, sha: string): string {
  return join(root, sha)
}

/**
 * Extract the config dir at `sha`. Idempotent per commit; `prepare` runs on the
 * staged directory — dependencies, the managed-skill overlay — before it is
 * sealed and moved into place, so a reader never sees a half-built copy.
 */
export async function materializeBootConfig(
  input: BootConfigInput & { prepare?: (stagedDir: string) => Promise<void> },
): Promise<{ dir: string }> {
  assertSafeInput(input)
  const root = input.root ?? bootConfigRoot()
  const dir = bootConfigDir(root, input.sha)
  if (existsSync(dir) && (await verifyBootConfig({ ...input, dir }))) return { dir }

  const entries = await listTree(input)
  await mkdir(root, { recursive: true })
  const staged = `${dir}.${randomUUID()}.tmp`
  try {
    await mkdir(staged, { recursive: true })
    const archived = await run('git', ['-C', input.repo, 'archive', '--format=tar', `${input.sha}:${input.relConfigDir}`])
    if (archived.code !== 0) throw new Error(`boot config: git archive failed: ${archived.stderr.trim()}`)
    const extracted = await run('tar', ['-xf', '-', '-C', staged], { input: archived.stdout })
    if (extracted.code !== 0) throw new Error(`boot config: extraction failed: ${extracted.stderr.trim()}`)

    await input.prepare?.(staged)
    await seal(staged, entries, await managedSkillNames(input.managedSkillsDir))

    if (existsSync(dir)) await removeBootConfig(dir)
    await rename(staged, dir)
  } catch (err) {
    await removeBootConfig(staged).catch(() => undefined)
    throw err
  }
  logger.info('[boot-config] materialized', { sha: input.sha, dir, files: entries.length })
  return { dir }
}

/**
 * Drop the write bit on every project file and on the directories that hold
 * only project files. The root and `skills/` stay writable: the installer and
 * the overlay create entries there.
 */
async function seal(dir: string, entries: TreeEntry[], managed: Set<string>): Promise<void> {
  const sealedDirs = new Set<string>()
  for (const entry of entries) {
    if (isPlatformWritten(entry.path, managed)) continue
    if (entry.mode !== '120000') {
      await chmod(join(dir, entry.path), entry.mode === '100755' ? 0o555 : 0o444)
    }
    const parts = entry.path.split('/')
    for (let depth = 1; depth < parts.length; depth++) sealedDirs.add(parts.slice(0, depth).join('/'))
  }
  sealedDirs.delete('skills')
  // Deepest first, so a parent is still writable while its children are sealed.
  for (const rel of [...sealedDirs].sort((a, b) => b.length - a.length)) {
    await chmod(join(dir, rel), 0o555).catch(() => undefined)
  }
}

function gitBlobId(content: Buffer, idLength: number): string {
  const hash = createHash(idLength === 64 ? 'sha256' : 'sha1')
  hash.update(`blob ${content.length}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/**
 * Is every project file in the copy byte-identical to the commit?
 *
 * Hashed in-process against the blob ids git already holds — one `ls-tree`, no
 * process per file. Never throws: anything unreadable is "no".
 */
export async function verifyBootConfig(input: BootConfigInput & { dir: string }): Promise<boolean> {
  try {
    assertSafeInput(input)
    const managed = await managedSkillNames(input.managedSkillsDir)
    const entries = await listTree(input)
    for (const entry of entries) {
      if (isPlatformWritten(entry.path, managed)) continue
      const onDisk = join(input.dir, entry.path)
      const stat = await lstat(onDisk)
      // A symlink is compared by its target text and never followed: following
      // it would let a swapped link point verification at any file on the box.
      const content =
        entry.mode === '120000'
          ? stat.isSymbolicLink()
            ? Buffer.from(await readlink(onDisk))
            : null
          : stat.isFile()
            ? await readFile(onDisk)
            : null
      if (content === null || gitBlobId(content, entry.blob.length) !== entry.blob) return false
    }
    // Nothing may have been ADDED either: a new agent, tool or second
    // `opencode.json` next to the committed files would be loaded like any other.
    const committed = new Set(entries.map((entry) => entry.path))
    for (const path of await walkFiles(input.dir, managed)) {
      if (!committed.has(path)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Every file in the copy that the platform did not write, relative to `dir`.
 * Root-level dotfiles are left out: they are installer droppings
 * (`.package-lock.json` and the like) and opencode reads none of them as config.
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

/** The copy this box runs, or null → the working-tree config dir. */
export async function readBootConfigPointer(
  root: string = bootConfigRoot(),
): Promise<BootConfigPointer | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, POINTER_FILE), 'utf8')) as Partial<BootConfigPointer>
    if (typeof parsed.sha !== 'string' || typeof parsed.dir !== 'string' || typeof parsed.relConfigDir !== 'string') {
      return null
    }
    assertSafeInput({ sha: parsed.sha, relConfigDir: parsed.relConfigDir })
    // The file sits in a directory the in-box agent can write. A pointer is only
    // honoured when it names a copy inside the store, so it cannot aim opencode
    // at an arbitrary directory.
    if (!insideRoot(root, parsed.dir) || resolve(parsed.dir) !== resolve(bootConfigDir(root, parsed.sha))) return null
    return { sha: parsed.sha, relConfigDir: parsed.relConfigDir, dir: resolve(parsed.dir) }
  } catch {
    return null
  }
}

export async function activateBootConfig(root: string, pointer: BootConfigPointer): Promise<void> {
  await mkdir(root, { recursive: true })
  const staged = join(root, `${POINTER_FILE}.${randomUUID()}.tmp`)
  await writeFile(staged, `${JSON.stringify(pointer)}\n`, { mode: 0o644 })
  await rename(staged, join(root, POINTER_FILE))
}

export async function deactivateBootConfig(root: string = bootConfigRoot()): Promise<void> {
  await rm(join(root, POINTER_FILE), { force: true })
}

async function removeBootConfig(dir: string): Promise<void> {
  // Sealed directories refuse `rm` until the write bit is back.
  await run('chmod', ['-R', 'u+w', dir]).catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
}

/** Remove every copy except `keep` — the active one and the one it replaced. */
export async function pruneBootConfigs(root: string, keep: readonly string[]): Promise<void> {
  const kept = new Set(keep.map((dir) => resolve(dir)))
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const dir = resolve(root, entry.name)
    if (!kept.has(dir)) await removeBootConfig(dir).catch(() => undefined)
  }
}
