import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  constants,
  copyFile,
  link,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const OPENCODE_SYSTEM_LINK = '/usr/local/bin/opencode-kortix'
export const OPENCODE_CURRENT_LINK = '/opt/kortix/opencode.current'

const OPENCODE_PACKAGE = 'opencode-ai'
const OPENCODE_NATIVE_RELATIVE_PATH = 'bin/opencode.exe'

export type CaptureCommand = (file: string, args: string[]) => Promise<string>

export async function captureProcessOutput(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return String(stdout)
}

export function parsePnpmGlobalPackagePath(
  output: string,
  packageName = OPENCODE_PACKAGE,
): string | null {
  const suffix = normalize(`/node_modules/${packageName}`)
  const paths = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isAbsolute(line))

  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index]
    if (path && normalize(path).endsWith(suffix)) return path
  }
  return null
}

export async function requireExecutableFile(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`OpenCode native target is not a file: ${path}`)
  await access(path, constants.X_OK)
}

export async function resolveInstalledOpencodeNative(
  capture: CaptureCommand = captureProcessOutput,
): Promise<string> {
  const output = await capture('pnpm', [
    'list',
    '-g',
    '--parseable',
    '--depth',
    '0',
    OPENCODE_PACKAGE,
  ])
  const packagePath = parsePnpmGlobalPackagePath(output)
  if (!packagePath) {
    throw new Error('pnpm did not report the global opencode-ai package path')
  }

  const nativePath = join(packagePath, OPENCODE_NATIVE_RELATIVE_PATH)
  await requireExecutableFile(nativePath)
  return nativePath
}

export async function publishOpencodeNativeLink(
  nativePath: string,
  linkPath = OPENCODE_CURRENT_LINK,
): Promise<void> {
  await requireExecutableFile(nativePath)
  const temporaryLink = `${linkPath}.next-${process.pid}-${randomUUID()}`
  try {
    await symlink(nativePath, temporaryLink)
    await rename(temporaryLink, linkPath)
  } finally {
    await rm(temporaryLink, { force: true })
  }
}

/**
 * The rollback pair OpenCode did not have.
 *
 * The daemon half keeps `agent.prev` and `agent.pinned`, and the supervisor uses
 * them to survive a build that does not boot. OpenCode had NEITHER: the publish
 * is a symlink rename with no retained predecessor, `pnpm add -g` replaces the
 * global install, and applying it is a hard stop+start — not the verified
 * `reloadVerified` the config path uses. An OpenCode that installed cleanly and
 * then failed to serve therefore left the box down, with nothing on disk to go
 * back to and nothing to stop the next pass repeating it.
 *
 * These are the two protections OpenCode CAN have. What it cannot have is the
 * config path's candidate proof — that boots a second OpenCode on the idle half
 * of the 4096/4097 pair and only swaps once it serves. A candidate cannot be
 * proven for a binary that replaces the global install the running one came
 * from.
 *
 * The predecessor is a RETAINED BINARY, not a link. It was a symlink once, and
 * that was a rollback that could not run: see {@link recordOpencodePrevious}.
 */
export const OPENCODE_PREV_BINARY = '/opt/kortix/opencode.prev'
export const OPENCODE_PINNED_LATCH = '/opt/kortix/opencode.pinned'

/**
 * Keep a copy of `source` that no package manager can take away.
 *
 * A hard link first: it pins the inode, so the bytes survive every name being
 * unlinked, and it costs no disk — opencode 1.18.22's native binary is
 * 184,068,240 bytes (measured) and is not duplicated. `link` refuses across
 * filesystems (EXDEV) and on filesystems that do not do hard links
 * (EPERM/ENOSYS/EMLINK), so a real copy is the fallback: slower and ~184 MB,
 * but only on a pass that actually updates.
 */
async function retainExecutable(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EMLINK') throw err
  }
  await copyFile(source, target)
  await chmod(target, 0o755)
}

/**
 * Keep the binary that is serving RIGHT NOW, before anything replaces it.
 *
 * A SYMLINK to it is not enough, and that is not theory. `opencode.current`
 * points INTO pnpm's global virtual store — the image resolves
 * `# cmd-shim-target=` out of the launcher and links straight at it
 * (apps/sandbox/Dockerfile) — and `pnpm add -g opencode-ai@<new>` deletes the
 * version it replaces. A recorded symlink target therefore named a path that
 * no longer existed by the time the rollback needed it:
 * `restoreOpencodePrevious` -> `publishOpencodeNativeLink` -> `stat` threw
 * ENOENT BEFORE the pin latch was written, so the box stayed down, nothing was
 * latched, and the next pass reinstalled the same broken version.
 *
 * So the predecessor is RETAINED, not referenced. Measured in a container with
 * the image's pnpm layout: `pnpm add -g opencode-ai@1.18.23` over 1.18.22 left
 * the recorded store path GONE and `opencode.current` dangling, while a hard
 * link taken before the install still reported `1.18.22`. The retained file
 * lives until the next successful update replaces it, which is the disk this
 * rollback costs: one extra opencode binary, and zero when the link succeeds.
 *
 * Returns the retained path, or null when there was nothing to keep — which the
 * caller must treat as "there is no rollback target", not as "fine".
 */
export async function recordOpencodePrevious(
  currentLinkPath = OPENCODE_CURRENT_LINK,
  prevPath = OPENCODE_PREV_BINARY,
): Promise<string | null> {
  let source: string
  try {
    // `realpath`, not `readlink`: `opencode.current` may be a chain, and what
    // has to be retained is the file at the end of it.
    source = await realpath(currentLinkPath)
    await requireExecutableFile(source)
  } catch {
    return null
  }
  const temporaryPath = `${prevPath}.next-${process.pid}-${randomUUID()}`
  try {
    await retainExecutable(source, temporaryPath)
    // Atomic, and it replaces the predecessor kept by the previous update.
    await rename(temporaryPath, prevPath)
    return prevPath
  } catch {
    return null
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

/**
 * Point `opencode.current` back at the retained predecessor.
 *
 * Returns the path it restored, or null when there is nothing runnable to go
 * back to. It does not throw on an absent or unusable predecessor: the caller
 * is already handling a box that failed to serve, and an exception there is
 * what once skipped the pin latch.
 */
export async function restoreOpencodePrevious(
  currentLinkPath = OPENCODE_CURRENT_LINK,
  prevPath = OPENCODE_PREV_BINARY,
): Promise<string | null> {
  try {
    await requireExecutableFile(prevPath)
  } catch {
    return null
  }
  try {
    await publishOpencodeNativeLink(prevPath, currentLinkPath)
  } catch {
    return null
  }
  return prevPath
}

/** The latch: a previous OpenCode update failed to serve and was rolled back. */

export async function opencodeUpdatesPinned(
  latchPath = OPENCODE_PINNED_LATCH,
): Promise<boolean> {
  return stat(latchPath).then(
    () => true,
    () => false,
  )
}

/**
 * Latch updates off. Written only after a rollback has ALREADY restored the box,
 * so the latch always describes a box that is working on an older version.
 */
export async function latchOpencodePinned(
  reason: string,
  latchPath = OPENCODE_PINNED_LATCH,
): Promise<void> {
  await Bun.write(latchPath, `${reason}\n`).catch(() => {})
}
