const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/

type ProjectEnvSnapshot = {
  revision: string | null
  env: Record<string, string>
  names: string[]
}

type ProjectEnvUpdate = {
  changed: boolean
  revision: string
  names: string[]
}

export type ProjectEnvStore = {
  snapshot(): ProjectEnvSnapshot
  apply(input: { revision: string; env: Record<string, unknown>; names?: unknown }): ProjectEnvUpdate
}

function normalizeEnv(input: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toUpperCase()
    if (!SECRET_NAME_REGEX.test(name)) continue
    if (name.startsWith('KORTIX_')) continue
    if (typeof rawValue !== 'string') continue
    env[name] = rawValue
  }
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))
}

function normalizeNames(names: unknown, env: Record<string, string>): string[] {
  const out = new Set(Object.keys(env))
  if (Array.isArray(names)) {
    for (const rawName of names) {
      if (typeof rawName !== 'string') continue
      const name = rawName.trim().toUpperCase()
      if (!SECRET_NAME_REGEX.test(name)) continue
      if (name.startsWith('KORTIX_')) continue
      out.add(name)
    }
  }
  return [...out].sort()
}

export function createProjectEnvStore(initialEnv: NodeJS.ProcessEnv = process.env): ProjectEnvStore {
  const initialRevision = initialEnv.KORTIX_PROJECT_SECRETS_REVISION?.trim()
  let revision: string | null = initialRevision || null
  let names = (initialEnv.KORTIX_PROJECT_SECRET_NAMES ?? '')
    .split(',')
    .map((name) => name.trim().toUpperCase())
    .filter((name) => SECRET_NAME_REGEX.test(name) && !name.startsWith('KORTIX_'))
    .sort()
  let env: Record<string, string> = {}
  for (const name of names) {
    const value = initialEnv[name]
    if (typeof value === 'string') env[name] = value
  }

  return {
    snapshot() {
      return {
        revision,
        env: { ...env },
        names: [...names],
      }
    },

    apply(input) {
      const nextRevision = input.revision.trim()
      if (!nextRevision) {
        throw new Error('revision is required')
      }
      const nextEnv = normalizeEnv(input.env)
      const nextNames = normalizeNames(input.names, nextEnv)
      const changed =
        revision !== nextRevision ||
        JSON.stringify(env) !== JSON.stringify(nextEnv) ||
        JSON.stringify(names) !== JSON.stringify(nextNames)

      if (changed) {
        revision = nextRevision
        env = nextEnv
        names = nextNames
      }

      return {
        changed,
        revision: nextRevision,
        names: [...nextNames],
      }
    },
  }
}

export function mergeProjectEnv(baseEnv: NodeJS.ProcessEnv, store: ProjectEnvStore): NodeJS.ProcessEnv {
  const snapshot = store.snapshot()
  const merged: NodeJS.ProcessEnv = { ...baseEnv }
  for (const name of snapshot.names) {
    delete merged[name]
  }
  for (const [name, value] of Object.entries(snapshot.env)) {
    merged[name] = value
  }
  return merged
}
