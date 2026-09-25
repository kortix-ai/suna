import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, constants, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
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
 */
export const OPENCODE_PREV_LINK = '/opt/kortix/opencode.prev'
export const OPENCODE_PINNED_LATCH = '/opt/kortix/opencode.pinned'

/** Where a link points, or null when it is absent or not a link. */
export async function readOpencodeLinkTarget(linkPath: string): Promise<string | null> {
  try {
    const target = await readlink(linkPath)
    return target.length > 0 ? target : null
  } catch {
    return null
  }
}

/**
 * Remember the binary that is serving RIGHT NOW, before anything replaces it.
 *
 * Returns the recorded target, or null when there was nothing to record — which
 * the caller must treat as "there is no rollback target", not as "fine".
 */
export async function recordOpencodePrevious(
  currentLinkPath = OPENCODE_CURRENT_LINK,
  prevLinkPath = OPENCODE_PREV_LINK,
): Promise<string | null> {
  const target = await readOpencodeLinkTarget(currentLinkPath)
  if (!target) return null
  const temporaryLink = `${prevLinkPath}.next-${process.pid}-${randomUUID()}`
  try {
    await symlink(target, temporaryLink)
    await rename(temporaryLink, prevLinkPath)
    return target
  } catch {
    return null
  } finally {
    await rm(temporaryLink, { force: true }).catch(() => {})
  }
}

/** Point `opencode.current` back at the recorded predecessor. */
export async function restoreOpencodePrevious(
  currentLinkPath = OPENCODE_CURRENT_LINK,
  prevLinkPath = OPENCODE_PREV_LINK,
): Promise<string | null> {
  const target = await readOpencodeLinkTarget(prevLinkPath)
  if (!target) return null
  await publishOpencodeNativeLink(target, currentLinkPath)
  return target
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
