/**
 * Claude Code for a box whose image does not carry it.
 *
 * Every Kortix image installs Claude Code (`/opt/kortix/claude/bin/claude`). A box
 * booted from an image built before that (a project image that is rebuilding, a
 * self-hosted image) installs the same pinned, unmodified binary here on its first
 * Claude turn: the npm tarball of the SDK's native package for this platform,
 * checked against the sha512 kortixd's lockfile records, into the runtime state dir.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { logger } from '@/lib/log/logger'
import { claudeExecutable } from './sdk'

/** The `@anthropic-ai/claude-agent-sdk` release kortixd runs (package.json); it ships Claude Code 2.1.316. */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.316'

/** The lockfile's integrity of each platform package (bun.lock). A test keeps them equal. */
export const CLAUDE_CODE_INTEGRITY: Record<'x64' | 'arm64', string> = {
  x64: 'sha512-+csYyGkHziNp4It+ZykqTmXRZBuNrieTiBnji+zwAxNmLLCWz8xEWjNmwhaLPIMpUiaYREkDhZXt/AS6xXta5w==',
  arm64: 'sha512-+lm9XSw/em14yMZ41fbo80kfblbylfBQc9nYS6GgLoZVvgT3wSeEbv88v+mEK/jFw9g3VCH4ZI01sjNM34o7uw==',
}

const DOWNLOAD_MS = 120_000

let installing: Promise<string> | null = null

function platformArch(): 'x64' | 'arm64' {
  const current = arch()
  if (current === 'x64' || current === 'arm64') return current
  throw new Error(`Claude Code has no build for this sandbox's architecture (${current})`)
}

/** The tarball's npm URL. `KORTIX_NPM_REGISTRY` points a box behind a mirror elsewhere. */
export function claudeTarballUrl(target: 'x64' | 'arm64', env: NodeJS.ProcessEnv = process.env): string {
  const registry = (env.KORTIX_NPM_REGISTRY?.trim() || 'https://registry.npmjs.org').replace(/\/+$/, '')
  const name = `claude-agent-sdk-linux-${target}`
  return `${registry}/@anthropic-ai/${name}/-/${name}-${CLAUDE_AGENT_SDK_VERSION}.tgz`
}

async function install(stateDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const target = platformArch()
  const dir = join(stateDir, 'claude-code', CLAUDE_AGENT_SDK_VERSION)
  const binary = join(dir, 'claude')
  if (existsSync(binary)) return binary
  const startedAt = Date.now()
  const response = await fetch(claudeTarballUrl(target, env), { signal: AbortSignal.timeout(DOWNLOAD_MS) })
  if (!response.ok) throw new Error(`Could not download Claude Code (HTTP ${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== CLAUDE_CODE_INTEGRITY[target]) throw new Error('The downloaded Claude Code does not match its pinned checksum')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const work = mkdtempSync(join(dir, '.install-'))
  try {
    const archive = join(work, 'package.tgz')
    writeFileSync(archive, bytes)
    await tar.x({ file: archive, cwd: work, filter: (path) => path === 'package/claude' })
    const extracted = join(work, 'package', 'claude')
    if (!existsSync(extracted)) throw new Error('The Claude Code package holds no binary')
    chmodSync(extracted, 0o755)
    renameSync(extracted, binary)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  logger.info('[claude] installed Claude Code into the runtime state dir', { version: CLAUDE_AGENT_SDK_VERSION, arch: target, ms: Date.now() - startedAt })
  return binary
}

/** The `claude` binary: the image's, else one installed here (once per daemon, then cached on disk). */
export async function ensureClaudeExecutable(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const existing = claudeExecutable(env) ?? installedClaudeExecutable(stateDir)
  if (existing) return existing
  installing ??= install(stateDir, env).finally(() => {
    installing = null
  })
  return installing
}

/** The binary a previous install left, if any. */
export function installedClaudeExecutable(stateDir: string): string | undefined {
  const binary = join(stateDir, 'claude-code', CLAUDE_AGENT_SDK_VERSION, 'claude')
  return existsSync(binary) ? binary : undefined
}
