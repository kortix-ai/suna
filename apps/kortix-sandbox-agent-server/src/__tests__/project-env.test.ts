import { describe, expect, test } from 'bun:test'

import { createProjectEnvStore, mergeProjectEnv } from '../project-env'

/**
 * A revoked secret must not survive into the environment opencode is spawned
 * with (opencode.ts:932 / :1203 both build it via mergeProjectEnv(process.env, …)).
 *
 * The shell path already handles this — agent-env.sh emits an explicit
 * `unset NAME`, covered by agent-env-file.test.ts. But opencode's own process
 * env, and therefore every MCP server and direct child spawn it makes, never
 * passes through BASH_ENV. If mergeProjectEnv only deletes the names still
 * granted, a revoked value survives from the daemon's process.env and is
 * re-injected on the next restart.
 */
describe('mergeProjectEnv — revocation', () => {
  test('a revoked BOOT secret is cleared, not carried over from process.env', () => {
    const bootEnv = {
      KORTIX_PROJECT_SECRETS_REVISION: 'r1',
      KORTIX_PROJECT_SECRET_NAMES: 'STRIPE_KEY,GITHUB_TOKEN',
      STRIPE_KEY: 'sk_live_boot',
      GITHUB_TOKEN: 'ghp_boot',
    }
    const store = createProjectEnvStore(bootEnv)

    // Owner deletes STRIPE_KEY. The server re-derives and pushes only what is
    // still granted — a revoked name is never in `names` (sandbox-env-names.ts:35).
    store.apply({ revision: 'r2', env: { GITHUB_TOKEN: 'ghp_boot' }, names: ['GITHUB_TOKEN'] })

    const merged = mergeProjectEnv(bootEnv, store)
    expect(merged.STRIPE_KEY).toBeUndefined()
    expect(merged.GITHUB_TOKEN).toBe('ghp_boot')
  })

  test('a secret ADDED mid-session and then revoked is also cleared', () => {
    // Not covered by the boot-name list: this name never existed at boot, so an
    // unset derived from KORTIX_PROJECT_SECRET_NAMES would miss it entirely.
    const bootEnv = {
      KORTIX_PROJECT_SECRETS_REVISION: 'r1',
      KORTIX_PROJECT_SECRET_NAMES: 'GITHUB_TOKEN',
      GITHUB_TOKEN: 'ghp_boot',
    }
    const store = createProjectEnvStore(bootEnv)

    store.apply({
      revision: 'r2',
      env: { GITHUB_TOKEN: 'ghp_boot', ADDED_KEY: 'added_value' },
      names: ['ADDED_KEY', 'GITHUB_TOKEN'],
    })
    // …then removed again.
    store.apply({ revision: 'r3', env: { GITHUB_TOKEN: 'ghp_boot' }, names: ['GITHUB_TOKEN'] })

    // Simulate the value having reached the live process env while it was granted.
    const liveEnv = { ...bootEnv, ADDED_KEY: 'added_value' }
    const merged = mergeProjectEnv(liveEnv, store)
    expect(merged.ADDED_KEY).toBeUndefined()
    expect(merged.GITHUB_TOKEN).toBe('ghp_boot')
  })

  test('a rotated secret takes the new value, not the boot one', () => {
    const bootEnv = {
      KORTIX_PROJECT_SECRETS_REVISION: 'r1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'old',
    }
    const store = createProjectEnvStore(bootEnv)
    store.apply({ revision: 'r2', env: { API_KEY: 'new' }, names: ['API_KEY'] })
    expect(mergeProjectEnv(bootEnv, store).API_KEY).toBe('new')
  })

  test('unrelated environment is left alone', () => {
    const bootEnv = {
      KORTIX_PROJECT_SECRETS_REVISION: 'r1',
      KORTIX_PROJECT_SECRET_NAMES: 'API_KEY',
      API_KEY: 'v',
      PATH: '/usr/bin',
      HOME: '/root',
    }
    const store = createProjectEnvStore(bootEnv)
    store.apply({ revision: 'r2', env: {}, names: [] })
    const merged = mergeProjectEnv(bootEnv, store)
    expect(merged.API_KEY).toBeUndefined()
    expect(merged.PATH).toBe('/usr/bin')
    expect(merged.HOME).toBe('/root')
  })
})

describe('project env store — what a push may carry', () => {
  test('a reserved KORTIX_* name is never stored or exported, and never overwrites the daemon credential', () => {
    // KORTIX_* is the platform's namespace: a project secret named KORTIX_TOKEN
    // would otherwise replace the sandbox credential in every child env.
    const store = createProjectEnvStore({} as NodeJS.ProcessEnv)
    const update = store.apply({
      revision: 'r1',
      env: { OLD_SECRET: 'new', KORTIX_TOKEN: 'blocked' },
      names: ['OLD_SECRET', 'KORTIX_API_URL'],
    })

    expect(update.names).toEqual(['OLD_SECRET'])
    expect(store.snapshot().env).toEqual({ OLD_SECRET: 'new' })
    expect(mergeProjectEnv({ KORTIX_TOKEN: 'sandbox-token' } as NodeJS.ProcessEnv, store)).toEqual({
      KORTIX_TOKEN: 'sandbox-token',
      OLD_SECRET: 'new',
    })
  })

  test('names are upper-cased and non-string values are dropped', () => {
    const store = createProjectEnvStore({} as NodeJS.ProcessEnv)
    store.apply({ revision: 'r1', env: { api_key: 'v', COUNT: 3, FLAG: true, NOTE: 'ok' } as Record<string, unknown> })

    expect(store.snapshot().env).toEqual({ API_KEY: 'v', NOTE: 'ok' })
  })
})
