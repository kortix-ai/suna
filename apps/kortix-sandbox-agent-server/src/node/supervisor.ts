import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { AGENT_SWAP_EXIT_CODE } from '../runtime-assets'
import { nodeStateDirectory } from './config-store'

const HEALTHY_AFTER_MS = 60_000
const MAX_EARLY_EXITS = 2

export interface SupervisorOptions {
  stateDirectory?: string
  bakedExecutable?: string
  healthyAfterMs?: number
  maxEarlyExits?: number
  spawnProcess?: (executable: string, args: string[]) => ChildProcess
  now?: () => number
}

function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

export function promoteStagedKortixd(state: string): boolean {
  const next = join(state, 'agent.next')
  const digest = `${next}.sha256`
  if (!existsSync(next)) return false
  if (existsSync(join(state, 'agent.pinned'))) { rmSync(next, { force: true }); rmSync(digest, { force: true }); return false }
  try {
    const expected = readFileSync(digest, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(expected) || sha256(next) !== expected) throw new Error('digest mismatch')
    const current = join(state, 'agent.current')
    if (existsSync(current)) copyFileSync(current, join(state, 'agent.prev'))
    chmodSync(next, 0o755)
    renameSync(next, current)
    rmSync(digest, { force: true })
    return true
  } catch {
    rmSync(next, { force: true })
    rmSync(digest, { force: true })
    return false
  }
}

export function rollbackKortixd(state: string): boolean {
  const current = join(state, 'agent.current')
  const previous = join(state, 'agent.prev')
  if (!existsSync(current)) return false
  if (existsSync(previous)) renameSync(previous, current)
  else rmSync(current, { force: true })
  writeFileSync(join(state, 'agent.pinned'), '')
  return true
}

export async function superviseKortixd(options: SupervisorOptions = {}): Promise<number> {
  const state = options.stateDirectory ?? join(nodeStateDirectory(), 'runtime')
  const baked = options.bakedExecutable ?? process.execPath
  const now = options.now ?? Date.now
  const spawnProcess = options.spawnProcess ?? ((executable, args) => spawn(executable, args, { stdio: 'inherit', env: process.env }))
  mkdirSync(state, { recursive: true, mode: 0o700 })
  let earlyExits = 0
  for (;;) {
    promoteStagedKortixd(state)
    const current = join(state, 'agent.current')
    const executable = existsSync(current) ? current : baked
    const started = now()
    const child = spawnProcess(executable, ['run'])
    const forwardInt = () => { if (child.exitCode === null) child.kill('SIGINT') }
    const forwardTerm = () => { if (child.exitCode === null) child.kill('SIGTERM') }
    process.once('SIGINT', forwardInt)
    process.once('SIGTERM', forwardTerm)
    const code = await new Promise<number>((resolve) => {
      child.once('error', () => resolve(1))
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
    })
    process.removeListener('SIGINT', forwardInt)
    process.removeListener('SIGTERM', forwardTerm)
    const ran = now() - started
    if (code === AGENT_SWAP_EXIT_CODE) { earlyExits = 0; continue }
    if (code !== 0 && ran < (options.healthyAfterMs ?? HEALTHY_AFTER_MS) && existsSync(current) && !existsSync(join(state, 'agent.pinned'))) {
      earlyExits++
      if (earlyExits >= (options.maxEarlyExits ?? MAX_EARLY_EXITS) && rollbackKortixd(state)) earlyExits = 0
      continue
    }
    return code
  }
}
