import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, constants, rename, rm, stat, symlink } from 'node:fs/promises'
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
