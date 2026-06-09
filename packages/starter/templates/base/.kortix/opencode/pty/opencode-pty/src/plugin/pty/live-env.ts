import { readFileSync } from 'node:fs'

const AGENT_ENV_FILE = '/run/kortix/agent-env.json'

function readLiveEnv(): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(AGENT_ENV_FILE, 'utf8')) as { env?: Record<string, string> }
    if (parsed && typeof parsed.env === 'object' && parsed.env) return parsed.env
  } catch {}
  return undefined
}

export function applyLiveProjectEnv(env: Record<string, string> | undefined | null): void {
  try {
    if (!env || typeof env !== 'object') return
    const live = readLiveEnv()
    if (!live) return
    const bootNames = (process.env.KORTIX_PROJECT_SECRET_NAMES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    for (const name of bootNames) {
      if (!(name in live)) delete env[name]
    }
    Object.assign(env, live)
  } catch {}
}
