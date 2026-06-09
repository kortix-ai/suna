import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { logger } from './logger'
import type { ProjectEnvStore } from './project-env'

export const AGENT_ENV_DIR = '/run/kortix'
export const AGENT_ENV_FILE = `${AGENT_ENV_DIR}/agent-env.json`

let writeSeq = 0

export function writeAgentEnvFile(store: ProjectEnvStore, file: string = AGENT_ENV_FILE): boolean {
  const snapshot = store.snapshot()
  const payload = JSON.stringify({
    revision: snapshot.revision,
    names: snapshot.names,
    env: snapshot.env,
  })

  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
    return true
  } catch (err) {
    logger.warn('[agent-env] failed to write live env file', {
      file,
      err: (err as Error).message,
    })
    return false
  }
}
