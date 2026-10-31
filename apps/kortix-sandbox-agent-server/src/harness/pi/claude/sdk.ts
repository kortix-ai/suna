/**
 * The Claude Agent SDK, the `claude` binary it drives, and the login it runs with.
 *
 * Kortix runs the unmodified `claude` program the image installs (`claudeExecutable`) through the public SDK. It never sits between Claude Code and Anthropic
 * and never changes Claude Code's requests: Claude Code makes every model call itself, with
 * the user's own Claude login.
 *
 * The login is the session user's Claude subscription token (`claude setup-token`), delivered
 * by apps/api as `KORTIX_CLAUDE_OAUTH_TOKEN` at boot or `claudeOauthToken` on `POST /kortix/env`.
 * It lives in this module only: `takeClaudeLogin` removes it from `process.env` at boot, so no
 * shell the agent runs inherits it, and only the `claude` process gets it.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type * as SDK from '@anthropic-ai/claude-agent-sdk'

let sdk: Promise<typeof SDK> | undefined

/** The SDK, loaded on first use: a box that never runs Claude never loads it. */
export function loadClaudeSdk(): Promise<typeof SDK> {
  sdk ??= import('@anthropic-ai/claude-agent-sdk').catch((cause) => {
    sdk = undefined
    throw new Error('The Claude Agent SDK could not load in this sandbox', { cause })
  })
  return sdk
}

let login: string | null = null
const listeners = new Set<() => void>()

/** Boot: move the delivered login out of the process environment. */
export function takeClaudeLogin(env: NodeJS.ProcessEnv = process.env): void {
  const token = env.KORTIX_CLAUDE_OAUTH_TOKEN?.trim()
  delete env.KORTIX_CLAUDE_OAUTH_TOKEN
  if (token) login = token
}

/** `POST /kortix/env`: the prompting user's login, or null when that user has none. Returns whether it changed. */
export function setClaudeLogin(token: string | null): boolean {
  const next = token?.trim() || null
  if (next === login) return false
  login = next
  for (const listener of listeners) listener()
  return true
}

export function hasClaudeLogin(): boolean {
  return login !== null
}

/** Runs when the login changes, so a running `claude` restarts with the new one. */
export function onClaudeLoginChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A short fingerprint of the login, so a process started with another login is restarted. */
export function claudeLoginKey(): string {
  if (!login) return 'none'
  return new Bun.CryptoHasher('sha256').update(login).digest('hex').slice(0, 16)
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Where every Kortix image installs Claude Code (`CLAUDE_CODE_PATH` in @kortix/shared). */
export const IMAGE_CLAUDE_PATH = '/opt/kortix/claude/bin/claude'

/** The `claude` binary: `KORTIX_CLAUDE_PATH`, else the image's, else `claude` on PATH. */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.KORTIX_CLAUDE_PATH?.trim()
  if (configured) return existsSync(configured) ? configured : undefined
  if (existsSync(IMAGE_CLAUDE_PATH)) return IMAGE_CLAUDE_PATH
  return onPath('claude', env)
}

/**
 * The variables that pick another login or another endpoint for Claude Code. Removed, so the
 * delivered subscription login is the one Claude Code uses: a project secret named
 * `ANTHROPIC_API_KEY` would otherwise win over it and bill an API key instead.
 */
const OTHER_LOGINS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
]

/**
 * Claude Code features that duplicate Kortix's. Kortix's version runs instead: pi compacts,
 * pi holds memory and instructions, and every tool is a Kortix tool.
 */
const ISOLATION_ENV: Record<string, string | undefined> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTO_COMPACT: '1',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  ENABLE_TOOL_SEARCH: 'false',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  // pi truncates tool output itself.
  MAX_MCP_OUTPUT_TOKENS: '200000',
  // Skips the OAuth login, so the subscription would not be used.
  CLAUDE_CODE_SIMPLE: undefined,
  // Would override the effort the Kortix picker chose.
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  // Would cap every Kortix tool call; permission prompts, questions and subagents run longer.
  MCP_TOOL_TIMEOUT: undefined,
}

/** Claude Code's own state (its transcripts): under the runtime state dir, never the user's `~/.claude`. */
export function claudeConfigDir(stateDir: string): string {
  const dir = join(stateDir, 'claude')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The environment of the `claude` process. Errors when there is no login. */
export function claudeEnv(stateDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!login) throw new ClaudeLoginMissing()
  const env: Record<string, string | undefined> = { ...base }
  for (const name of OTHER_LOGINS) delete env[name]
  // kortixd's own credentials stay in kortixd: Claude Code runs no tool of its own.
  for (const name of Object.keys(env)) if (name.startsWith('KORTIX_')) delete env[name]
  Object.assign(env, ISOLATION_ENV, { CLAUDE_CODE_OAUTH_TOKEN: login, CLAUDE_CONFIG_DIR: claudeConfigDir(stateDir) })
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** The session user has not connected a Claude subscription. The message is the user's next step. */
export class ClaudeLoginMissing extends Error {
  constructor() {
    super('Connect your Claude subscription to use Claude models: open the model picker and choose Connect Claude.')
    this.name = 'ClaudeLoginMissing'
  }
}
