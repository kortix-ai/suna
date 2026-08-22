import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nodeStateDirectory } from './config-store'

export type NodeCapability = 'filesystem' | 'shell' | 'desktop'

export interface NodeLocalPolicy {
  enabledCapabilities: NodeCapability[]
  allowedPaths: string[]
  blockedPaths: string[]
  allowedCommands: string[]
  blockedCommands: string[]
  maxFileSize: number
  shellTimeout: number
  shellMaxTimeout: number
  shellMaxOutputSize: number
  shellEnvPassthrough: string[]
}

const DEFAULT_POLICY: NodeLocalPolicy = {
  enabledCapabilities: ['filesystem', 'shell', 'desktop'],
  allowedPaths: [homedir()],
  blockedPaths: ['/etc/shadow', '/etc/passwd', '/etc/sudoers', '/etc/ssh', '/root/.ssh', '/proc', '/sys', '/dev'],
  allowedCommands: [],
  blockedCommands: [],
  maxFileSize: 10 * 1024 * 1024,
  shellTimeout: 30_000,
  shellMaxTimeout: 120_000,
  shellMaxOutputSize: 1024 * 1024,
  shellEnvPassthrough: ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'NODE_ENV', 'HOSTNAME'],
}

export function nodePolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(nodeStateDirectory(env), 'policy.json')
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`Node policy ${name} must be an array of strings`)
  return value
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Node policy ${name} must be a positive safe integer`)
  return value as number
}

export function loadNodeLocalPolicy(env: NodeJS.ProcessEnv = process.env): NodeLocalPolicy {
  const path = nodePolicyPath(env)
  if (!existsSync(path)) return { ...DEFAULT_POLICY, enabledCapabilities: [...DEFAULT_POLICY.enabledCapabilities], allowedPaths: [...DEFAULT_POLICY.allowedPaths], blockedPaths: [...DEFAULT_POLICY.blockedPaths], allowedCommands: [], blockedCommands: [], shellEnvPassthrough: [...DEFAULT_POLICY.shellEnvPassthrough] }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Node policy must be a regular file')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Node policy is not owned by the current user')
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600)
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error('Node policy permissions are not private')
  }
  let input: Record<string, unknown>
  try { input = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
  catch (error) { throw new Error(`Node policy is invalid: ${error instanceof Error ? error.message : String(error)}`) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Node policy root must be an object')
  const enabled = input.enabledCapabilities === undefined ? DEFAULT_POLICY.enabledCapabilities : strings(input.enabledCapabilities, 'enabledCapabilities')
  if (new Set(enabled).size !== enabled.length || !enabled.every((item) => item === 'filesystem' || item === 'shell' || item === 'desktop')) throw new Error('Node policy enabledCapabilities contains an unsupported or duplicate capability')
  return {
    enabledCapabilities: enabled as NodeCapability[],
    allowedPaths: input.allowedPaths === undefined ? [...DEFAULT_POLICY.allowedPaths] : strings(input.allowedPaths, 'allowedPaths'),
    blockedPaths: input.blockedPaths === undefined ? [...DEFAULT_POLICY.blockedPaths] : strings(input.blockedPaths, 'blockedPaths'),
    allowedCommands: input.allowedCommands === undefined ? [] : strings(input.allowedCommands, 'allowedCommands'),
    blockedCommands: input.blockedCommands === undefined ? [] : strings(input.blockedCommands, 'blockedCommands'),
    maxFileSize: input.maxFileSize === undefined ? DEFAULT_POLICY.maxFileSize : positive(input.maxFileSize, 'maxFileSize'),
    shellTimeout: input.shellTimeout === undefined ? DEFAULT_POLICY.shellTimeout : positive(input.shellTimeout, 'shellTimeout'),
    shellMaxTimeout: input.shellMaxTimeout === undefined ? DEFAULT_POLICY.shellMaxTimeout : positive(input.shellMaxTimeout, 'shellMaxTimeout'),
    shellMaxOutputSize: input.shellMaxOutputSize === undefined ? DEFAULT_POLICY.shellMaxOutputSize : positive(input.shellMaxOutputSize, 'shellMaxOutputSize'),
    shellEnvPassthrough: input.shellEnvPassthrough === undefined ? [...DEFAULT_POLICY.shellEnvPassthrough] : strings(input.shellEnvPassthrough, 'shellEnvPassthrough'),
  }
}

export function sandboxNodePolicy(): NodeLocalPolicy {
  return { ...DEFAULT_POLICY, allowedPaths: ['/workspace', '/tmp', '/home', '/opt'], enabledCapabilities: [...DEFAULT_POLICY.enabledCapabilities], blockedPaths: [...DEFAULT_POLICY.blockedPaths], allowedCommands: [], blockedCommands: [], shellEnvPassthrough: [...DEFAULT_POLICY.shellEnvPassthrough] }
}
