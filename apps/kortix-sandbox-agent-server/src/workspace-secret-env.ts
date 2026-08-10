const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/

type WorkspaceSecretEnvSnapshot = {
  revision: string | null
  env: Record<string, string>
  names: string[]
  /** Union of every name this store has managed, including revoked ones. */
  knownNames: string[]
}

type WorkspaceSecretEnvUpdate = {
  changed: boolean
  revision: string
  /** The FULL current name set, not a delta. */
  names: string[]
  /**
   * Names whose VALUE actually moved — added, removed, or rewritten.
   *
   * `names` is the whole allowlist, so it cannot answer "did THIS secret just
   * change". The caller needs that: a few values are consumed by `spawnChild`
   * outside the opencode config file (they are materialized into auth.json), so
   * a change to one of those demands a full respawn rather than the ~51ms
   * dispose. Keying that decision off `names` would respawn on every push for
   * any workspace that merely has such a secret.
   */
  changedNames: string[]
}

export type WorkspaceSecretEnvStore = {
  snapshot(): WorkspaceSecretEnvSnapshot
  apply(input: { revision: string; env: Record<string, unknown>; names?: unknown }): WorkspaceSecretEnvUpdate
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

export function createWorkspaceSecretEnvStore(initialEnv: NodeJS.ProcessEnv = process.env): WorkspaceSecretEnvStore {
  const initialRevision = (
    initialEnv.KORTIX_WORKSPACE_SECRETS_REVISION ??
    initialEnv.KORTIX_PROJECT_SECRETS_REVISION
  )?.trim()
  let revision: string | null = initialRevision || null
  let names = (
    initialEnv.KORTIX_WORKSPACE_SECRET_NAMES ??
    initialEnv.KORTIX_PROJECT_SECRET_NAMES ??
    ''
  )
    .split(',')
    .map((name) => name.trim().toUpperCase())
    .filter((name) => SECRET_NAME_REGEX.test(name) && !name.startsWith('KORTIX_'))
    .sort()
  let env: Record<string, string> = {}
  for (const name of names) {
    const value = initialEnv[name]
    if (typeof value === 'string') env[name] = value
  }
  // Every name this store has ever managed. A revoked secret drops out of
  // `names`, so this is the only record that it must be actively cleared.
  const knownNames = new Set<string>(names)

  return {
    snapshot() {
      return {
        revision,
        env: { ...env },
        names: [...names],
        knownNames: [...knownNames].sort(),
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

      for (const name of nextNames) knownNames.add(name)
      for (const name of Object.keys(nextEnv)) knownNames.add(name)

      // Computed against the PREVIOUS env, so it must run before the assignment.
      const changedNames = [
        ...new Set([...Object.keys(env), ...Object.keys(nextEnv)]),
      ]
        .filter((name) => env[name] !== nextEnv[name])
        .sort()

      if (changed) {
        revision = nextRevision
        env = nextEnv
        names = nextNames
      }

      return {
        changed,
        revision: nextRevision,
        names: [...nextNames],
        changedNames,
      }
    },
  }
}

export function reconcileWorkspaceSecretEnv(
  targetEnv: NodeJS.ProcessEnv,
  store: WorkspaceSecretEnvStore,
): NodeJS.ProcessEnv {
  const snapshot = store.snapshot()
  // Clear every name this store has EVER managed, not just the ones still
  // granted. The server pushes only currently-granted names, so a revoked
  // secret never appears in `names` — deleting only those would leave its value
  // in place, inherited from the daemon's own process.env, and re-inject it into
  // opencode on the next restart (opencode.ts spawns from mergeWorkspaceSecretEnv).
  // MCP servers and direct child spawns never pass through BASH_ENV, so the
  // `unset` written to agent-env.sh does not cover them.
  for (const name of snapshot.knownNames) {
    delete targetEnv[name]
  }
  for (const [name, value] of Object.entries(snapshot.env)) {
    targetEnv[name] = value
  }
  return targetEnv
}

export function mergeWorkspaceSecretEnv(baseEnv: NodeJS.ProcessEnv, store: WorkspaceSecretEnvStore): NodeJS.ProcessEnv {
  return reconcileWorkspaceSecretEnv({ ...baseEnv }, store)
}
