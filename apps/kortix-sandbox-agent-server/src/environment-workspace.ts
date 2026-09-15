import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Config } from './config'
import { materializeRepo } from './git'

export async function prepareEnvironmentWorkspace(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const sessionId = env.KORTIX_SESSION_ID
  const state = env.KORTIX_AGENT_STATE_DIR || '/opt/kortix/environment-runtime'
  const marker = join(state, 'workspace.json')
  const identity = { sessionId, projectId: cfg.projectId, workspace: resolve(cfg.workspace) }
  const owned = sessionId ? await readFile(marker, 'utf8').then((text) => {
    const saved = JSON.parse(text)
    return saved.sessionId === sessionId && saved.projectId === cfg.projectId && saved.workspace === identity.workspace
  }).catch(() => false) : false
  const preserve = owned || env.KORTIX_ENVIRONMENT_REUSE_WORKSPACE === '1'
  if (preserve) {
    const directory = await stat(cfg.workspace)
    if (!directory.isDirectory()) throw new Error('The existing environment workspace is unavailable')
  } else if (cfg.autoClone) {
    await materializeRepo(cfg)
  } else {
    await mkdir(cfg.workspace, { recursive: true })
  }
  if (sessionId) {
    await mkdir(state, { recursive: true })
    const temporary = `${marker}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(identity), { mode: 0o600 })
    await rename(temporary, marker)
  }
}
