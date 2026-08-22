import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface StoredNodeConfig {
  api_url: string
  compute_node_id: string
  credential: string
  artifact_signing_public_key?: string
}

export function nodeStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KORTIXD_HOME?.trim()) return env.KORTIXD_HOME.trim()
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || homedir(), 'Kortix', 'kortixd')
  return join(env.XDG_STATE_HOME || homedir(), '.kortixd')
}

export function nodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(nodeStateDirectory(env), 'node.json')
}

export function readStoredNodeConfig(env: NodeJS.ProcessEnv = process.env): StoredNodeConfig | null {
  const path = nodeConfigPath(env)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('node credential path must be a regular file')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('node credential file mode must be 0600')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredNodeConfig>
    if (typeof parsed.api_url !== 'string' || typeof parsed.compute_node_id !== 'string' || typeof parsed.credential !== 'string') {
      throw new Error('node credential file is invalid')
    }
    if (parsed.artifact_signing_public_key !== undefined && typeof parsed.artifact_signing_public_key !== 'string') throw new Error('node signing public key is invalid')
    return parsed as StoredNodeConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function writeStoredNodeConfig(config: StoredNodeConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = nodeConfigPath(env)
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  return path
}

export function clearStoredNodeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    unlinkSync(nodeConfigPath(env))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
