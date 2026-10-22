/**
 * The compiled agent config in the daemon's own env.
 *
 * OpenCode, git, every PTY and every other child inherit `process.env`, and
 * Linux refuses to exec a child whose env holds one `NAME=VALUE\0` over 131,072
 * bytes. On Platinum prod (7 days to 2026-10-14) every create whose
 * `KORTIX_COMPILED_AGENT_CONFIG` crossed that line never booted. The API now
 * sends such a config gzip-encoded in parts; these rows prove the daemon keeps
 * it that way when a config release delivers it, and reads it back.
 */
import { describe, expect, test } from 'bun:test'
import { compiledAgentConfigFromEnv, setCompiledAgentConfigEnv } from '@/services/config-provider/compiled-agent-config'
import { deliverGovernance } from '@/services/config-provider/release'
import { MAX_ENV_STRING_BYTES, encodeCompiledAgentConfigEnv, envStringBytes } from '@kortix/api-contract/compiled-agent-config-env'

const OVERSIZED = JSON.stringify({
  default_agent: 'support',
  agent: { support: { mode: 'primary', prompt: `Triage tickets. ${'Quote the order id and the policy section. '.repeat(6_500)}` } },
})
const SMALL = JSON.stringify({ agent: { support: { mode: 'primary' } } })

/** Names of the compiled config's forms, without the etag. */
const configNames = (env: NodeJS.ProcessEnv) =>
  Object.keys(env)
    .filter((name) => name.startsWith('KORTIX_COMPILED_AGENT_CONFIG') && name !== 'KORTIX_COMPILED_AGENT_CONFIG_ETAG')
    .sort()

describe('deliverGovernance', () => {
  test('an oversized release governance is stored gzip-encoded, each part within the exec limit', () => {
    expect(envStringBytes('KORTIX_COMPILED_AGENT_CONFIG', OVERSIZED)).toBeGreaterThan(MAX_ENV_STRING_BYTES)
    const env: NodeJS.ProcessEnv = { KORTIX_COMPILED_AGENT_CONFIG: SMALL, KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'old' }

    const restore = deliverGovernance(OVERSIZED, 'new', env)

    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined()
    expect(configNames(env)).toEqual(['KORTIX_COMPILED_AGENT_CONFIG_GZ_0', 'KORTIX_COMPILED_AGENT_CONFIG_GZ_PARTS'])
    for (const name of configNames(env)) expect(envStringBytes(name, env[name]!), name).toBeLessThanOrEqual(MAX_ENV_STRING_BYTES)
    expect(compiledAgentConfigFromEnv(env)).toBe(OVERSIZED)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toBe('new')

    // A failed convergence puts back what ran before, in its own form.
    restore()
    expect(env).toEqual({ KORTIX_COMPILED_AGENT_CONFIG: SMALL, KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'old' })
  })

  test('restoring an oversized governance puts the gzip form back, and none clears every form', () => {
    const env: NodeJS.ProcessEnv = { ...encodeCompiledAgentConfigEnv(OVERSIZED) }
    deliverGovernance(SMALL, 'small', env)()
    expect(compiledAgentConfigFromEnv(env)).toBe(OVERSIZED)
    expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBeUndefined()

    const empty: NodeJS.ProcessEnv = {}
    deliverGovernance(OVERSIZED, null, empty)()
    expect(configNames(empty)).toEqual([])
  })

  test('a governance that fits is the raw var, exactly as before', () => {
    const env: NodeJS.ProcessEnv = {}
    deliverGovernance(SMALL, 'e', env)
    expect(env).toEqual({ KORTIX_COMPILED_AGENT_CONFIG: SMALL, KORTIX_COMPILED_AGENT_CONFIG_ETAG: 'e' })
  })
})

describe('compiledAgentConfigFromEnv', () => {
  test('reads the raw form, the gzip form, and nothing', () => {
    expect(compiledAgentConfigFromEnv({ KORTIX_COMPILED_AGENT_CONFIG: SMALL })).toBe(SMALL)
    expect(compiledAgentConfigFromEnv({ ...encodeCompiledAgentConfigEnv(OVERSIZED) })).toBe(OVERSIZED)
    expect(compiledAgentConfigFromEnv({})).toBeUndefined()
  })

  test('a damaged gzip form reads as no config instead of throwing into the caller', () => {
    const env: NodeJS.ProcessEnv = { ...encodeCompiledAgentConfigEnv(OVERSIZED) }
    delete env.KORTIX_COMPILED_AGENT_CONFIG_GZ_0
    expect(compiledAgentConfigFromEnv(env)).toBeUndefined()
  })

  test('setCompiledAgentConfigEnv(null) clears both forms', () => {
    const env: NodeJS.ProcessEnv = { ...encodeCompiledAgentConfigEnv(OVERSIZED), OTHER: 'kept' }
    setCompiledAgentConfigEnv(env, null)
    expect(env).toEqual({ OTHER: 'kept' })
  })
})
