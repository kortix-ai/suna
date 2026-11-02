/**
 * The Claude Agent SDK, the `claude` binary it drives, and where its model calls go.
 *
 * Kortix runs the unmodified `claude` program the image installs (`claudeExecutable`) through
 * the public SDK, and never changes Claude Code's requests.
 *
 * Claude Code's model calls go to the Kortix LLM gateway, never with a Claude login in this box:
 * its base URL is the gateway's Claude Code passthrough (`<gateway>/claude-code`) and its login
 * is this session's gateway credential. The gateway picks the project's Claude account for the
 * request (the session's selected accounts, the session owner's own, or one shared with the
 * project), adds that account's token and forwards the request to Anthropic unchanged. No Claude
 * token is ever in this sandbox.
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

/**
 * Claude Code's login when the localhost LLM proxy runs: a fixed, non-secret placeholder in the
 * shape of a subscription token. The proxy replaces the `Authorization` header with the live
 * session credential (services/llm-proxy/llm-proxy.ts), so no credential is in Claude Code's env.
 */
export const CLAUDE_GATEWAY_PLACEHOLDER_TOKEN = 'sk-ant-oat01-kortix-gateway-placeholder'

export interface ClaudeGateway {
  /** Claude Code's `ANTHROPIC_BASE_URL`: the gateway's Claude Code passthrough. */
  baseUrl: string
  /** Claude Code's `CLAUDE_CODE_OAUTH_TOKEN`: the placeholder (proxy) or the session's gateway token. */
  token: string
}

/** Where Claude Code's model calls go: the localhost proxy when it runs, else the gateway itself. Null without a gateway. */
export function claudeGateway(env: NodeJS.ProcessEnv = process.env): ClaudeGateway | null {
  const proxy = env.KORTIX_LLM_PROXY_URL?.trim()
  if (proxy && env.KORTIX_LLM_PROXY_DISABLE !== '1') {
    return { baseUrl: `${proxy.replace(/\/+$/, '')}/claude-code`, token: CLAUDE_GATEWAY_PLACEHOLDER_TOKEN }
  }
  const base = env.KORTIX_LLM_BASE_URL?.trim()
  const token = env.KORTIX_TOKEN?.trim()
  if (!base || !token) return null
  return { baseUrl: `${base.replace(/\/+$/, '')}/claude-code`, token }
}

/** A short fingerprint of where Claude Code's calls go, so a process started for another gateway or credential restarts. */
export function claudeLoginKey(env: NodeJS.ProcessEnv = process.env): string {
  const gateway = claudeGateway(env)
  if (!gateway) return 'none'
  return new Bun.CryptoHasher('sha256').update(`${gateway.baseUrl}\n${gateway.token}`).digest('hex').slice(0, 16)
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
 * gateway is the one endpoint Claude Code uses: a project secret named `ANTHROPIC_API_KEY`
 * would otherwise win and bill an API key instead of the project's Claude account.
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

/** The environment of the `claude` process. Errors when the session has no gateway. */
export function claudeEnv(stateDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const gateway = claudeGateway(base)
  if (!gateway) throw new ClaudeLoginMissing()
  const env: Record<string, string | undefined> = { ...base }
  for (const name of OTHER_LOGINS) delete env[name]
  // kortixd's own credentials stay in kortixd: Claude Code runs no tool of its own.
  for (const name of Object.keys(env)) if (name.startsWith('KORTIX_')) delete env[name]
  Object.assign(env, ISOLATION_ENV, {
    ANTHROPIC_BASE_URL: gateway.baseUrl,
    CLAUDE_CODE_OAUTH_TOKEN: gateway.token,
    CLAUDE_CONFIG_DIR: claudeConfigDir(stateDir),
  })
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** A turn's error when no Claude account is usable for this session. Clients key the Connect Claude action on it. */
export const CLAUDE_CONNECT_MESSAGE = 'Connect your Claude subscription to use Claude models.'
/** A turn's error when Anthropic refused the Claude account (revoked or expired). Clients key Reconnect Claude on it. */
export const CLAUDE_RECONNECT_MESSAGE = 'Your Claude subscription login stopped working. Reconnect Claude to continue.'

/** The session has no gateway to reach a Claude account through. The message is the user's next step. */
export class ClaudeLoginMissing extends Error {
  constructor() {
    super(CLAUDE_CONNECT_MESSAGE)
    this.name = 'ClaudeLoginMissing'
  }
}
