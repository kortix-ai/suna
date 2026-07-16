import { describe, expect, it } from 'bun:test'
// devDependency import — the conformance guard is the ONLY place this app touches
// @kortix/shared. The sandbox agent server ships as a standalone `bun build
// --compile` binary with zero @kortix/* runtime dependencies today, so harness
// identity is NOT re-derived from the descriptor at runtime (see decision-rule
// note in the task report). This test only guards against drift between the two
// hand-maintained harness id lists.
// Import the narrow './harnesses' subpath, not the '@kortix/shared' root
// barrel — the root barrel re-exports './tools', which fails this app's
// stricter `noUncheckedIndexedAccess` typecheck (packages/shared itself
// doesn't enable that flag, so the barrel is clean there but not here). The
// harness descriptor module is dependency-free by contract (see its header
// docstring), so this subpath pulls in nothing but harness identity.
import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses'

import {
  ACP_HARNESS_IDS,
  createAcpHarnessRegistry,
  isolateHarnessAuthEnv,
  resolveAcpHarnessLaunchEnv,
  type RuntimeAuthKind,
} from './harness-registry'

describe('sandbox harness registry conforms to the canonical descriptor', () => {
  it('covers exactly HARNESS_IDS (order-insensitive)', () => {
    expect([...ACP_HARNESS_IDS].sort()).toEqual([...HARNESS_IDS].sort())
  })

  it('every canonical harness has a launch definition with a non-empty command', () => {
    const registry = createAcpHarnessRegistry({})
    for (const id of HARNESS_IDS) {
      const descriptor = registry.get(id as (typeof ACP_HARNESS_IDS)[number])
      expect(descriptor).toBeDefined()
      expect(typeof descriptor?.launch.command).toBe('string')
      expect(descriptor?.launch.command.length).toBeGreaterThan(0)
      expect(Array.isArray(descriptor?.launch.args)).toBe(true)
      expect(descriptor?.launch.args.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every canonical harness routes native config through its own distinct env var', () => {
    // `harness-registry.ts` does not encode the descriptor's `configDir` path
    // strings ('.claude', '.codex', '.kortix/opencode', '.pi') — those are
    // supplied at runtime via KORTIX_RUNTIME_CONFIG_DIR by the caller. What
    // this module DOES encode is which native-config env var name each
    // harness id resolves to (nativeConfigEnv, harness-registry.ts:82). That
    // mapping has a same-shape drift risk: a canonical id this module doesn't
    // explicitly recognize silently falls through to the `pi` branch's
    // PI_CODING_AGENT_DIR. Assert every canonical id gets its own distinct
    // var so a future harness added to HARNESS_IDS without a matching branch
    // here is caught instead of silently colliding with Pi's config dir.
    const env = {
      KORTIX_RUNTIME_AUTH_KIND: 'native_config',
      KORTIX_RUNTIME_CONFIG_DIR: '.native-config-probe',
      KORTIX_WORKSPACE: '/workspace',
    }
    const seenVars = new Map<string, string>()
    for (const id of HARNESS_IDS) {
      const launchEnv = resolveAcpHarnessLaunchEnv(id as (typeof ACP_HARNESS_IDS)[number], env)
      expect(launchEnv).toBeDefined()
      const keys = Object.keys(launchEnv ?? {})
      expect(keys).toHaveLength(1)
      const [varName] = keys as [string]
      expect(varName.length).toBeGreaterThan(0)
      expect(seenVars.has(varName)).toBe(false)
      seenVars.set(varName, id)
    }
    // Every descriptor still declares a configDir even though this module
    // doesn't consume the literal value — guard the descriptor shape itself
    // so the assumption above (identity-only wiring) stays honest.
    for (const id of HARNESS_IDS) {
      expect(typeof HARNESSES[id].configDir).toBe('string')
      expect(HARNESSES[id].configDir.length).toBeGreaterThan(0)
    }
  })
})

// WS2-P4-a — env-based auth wiring vs the descriptor's `authKinds` matrix.
// Founder decisions pinned here (2026-07-15): Claude Code and Codex are
// harness-access only (subscription, own provider key, or native config —
// NEVER the Kortix managed gateway, NEVER a custom endpoint); OpenCode and Pi
// keep the full gateway story; `anthropic_compatible` is parked (zero
// compatible harnesses at the api layer, see composer-capabilities.ts).
//
// The full env pipeline a real launch goes through, for reference (only the
// first two stages are exercised by this file — `runtime.ts`'s `sanitizeHarnessEnv`
// is a separate module and out of scope here):
//   isolateHarnessAuthEnv(rawEnv) -> resolveAcpHarnessLaunchEnv(id, isolated)
//   childEnv = sanitizeHarnessEnv({ ...isolated, ...launchEnvOverride })
// This file models the merge of the first two stages as
// `{ ...isolated, ...(launchEnvOverride ?? {}) }`.
function mergedLaunchEnv(id: (typeof ACP_HARNESS_IDS)[number], env: NodeJS.ProcessEnv) {
  const isolated = isolateHarnessAuthEnv(env)
  const launchEnvOverride = resolveAcpHarnessLaunchEnv(id, isolated)
  return { isolated, launchEnvOverride, merged: { ...isolated, ...(launchEnvOverride ?? {}) } }
}

describe('env-based auth: descriptor authKinds reach the right env names (WS2-P4-a)', () => {
  it('claude + anthropic_api_key: ANTHROPIC_API_KEY reaches the child env directly, no gateway env is injected', () => {
    expect(HARNESSES.claude.authKinds).toContain('anthropic_api_key')
    const { merged } = mergedLaunchEnv('claude', {
      KORTIX_RUNTIME_AUTH_KIND: 'anthropic_api_key',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      // Leaked cross-provider cred — must not affect this assertion; the
      // isolation law (below) covers it not reaching the child at all.
      OPENAI_API_KEY: 'sk-oai-leak',
    })
    expect(merged.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(merged.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(merged.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('claude + claude_subscription: CLAUDE_CODE_OAUTH_TOKEN reaches the child env directly, no gateway env is injected', () => {
    expect(HARNESSES.claude.authKinds).toContain('claude_subscription')
    const { merged } = mergedLaunchEnv('claude', {
      KORTIX_RUNTIME_AUTH_KIND: 'claude_subscription',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token',
    })
    expect(merged.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test-token')
    expect(merged.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('codex + openai_api_key: OPENAI_API_KEY reaches the child env directly, no gateway env is injected', () => {
    expect(HARNESSES.codex.authKinds).toContain('openai_api_key')
    const { merged } = mergedLaunchEnv('codex', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_api_key',
      OPENAI_API_KEY: 'sk-oai-test',
      KORTIX_API_URL: 'https://api.example.com',
      KORTIX_TOKEN: 'sandbox-token',
    })
    expect(merged.OPENAI_API_KEY).toBe('sk-oai-test')
    expect(merged.DEFAULT_AUTH_REQUEST).toBeUndefined()
  })

  it('codex + openai_api_key: CODEX_API_KEY also reaches the child env directly (the registry treats it as an alias of OPENAI_API_KEY for this kind)', () => {
    const { merged } = mergedLaunchEnv('codex', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_api_key',
      CODEX_API_KEY: 'sk-codex-test',
      KORTIX_API_URL: 'https://api.example.com',
      KORTIX_TOKEN: 'sandbox-token',
    })
    expect(merged.CODEX_API_KEY).toBe('sk-codex-test')
    expect(merged.DEFAULT_AUTH_REQUEST).toBeUndefined()
  })

  it('codex + codex_subscription: CODEX_AUTH_JSON does NOT reach the adapter directly — it routes through the Kortix gateway (server-side refresh) instead', () => {
    // Pin what IS, not the symmetric-with-claude behavior one might expect:
    // the code comment at harness-registry.ts's codex branch is explicit that
    // subscription auth is "intentionally different" — CODEX_AUTH_JSON stays
    // server-side (the adapter authenticates to the Kortix gateway with the
    // sandbox token instead of ever seeing the subscription blob).
    expect(HARNESSES.codex.authKinds).toContain('codex_subscription')
    const { isolated, launchEnvOverride, merged } = mergedLaunchEnv('codex', {
      KORTIX_RUNTIME_AUTH_KIND: 'codex_subscription',
      CODEX_AUTH_JSON: 'super-secret-subscription-blob',
      KORTIX_API_URL: 'https://api.example.com',
      KORTIX_TOKEN: 'sandbox-token',
    })
    // isolateHarnessAuthEnv keeps it (it's the selected kind's own cred)...
    expect(isolated.CODEX_AUTH_JSON).toBe('super-secret-subscription-blob')
    // ...but resolveAcpHarnessLaunchEnv routes through the gateway instead of
    // forwarding it, and the gateway request never embeds the raw blob.
    expect(launchEnvOverride?.DEFAULT_AUTH_REQUEST).toContain('Kortix Gateway')
    expect(launchEnvOverride?.DEFAULT_AUTH_REQUEST).not.toContain('super-secret-subscription-blob')
    expect(merged.DEFAULT_AUTH_REQUEST).toContain('sandbox-token')
  })

  it('claude + native_config: only the native config dir env is injected, no provider credential', () => {
    expect(HARNESSES.claude.authKinds).toContain('native_config')
    const { merged } = mergedLaunchEnv('claude', {
      KORTIX_RUNTIME_AUTH_KIND: 'native_config',
      KORTIX_RUNTIME_CONFIG_DIR: '.claude',
      KORTIX_WORKSPACE: '/workspace',
      // Even if a stray provider key is present in the raw env, native_config
      // is an explicit auth source and must not pick it up (isolateHarnessAuthEnv
      // strips every provider cred for this kind — see the isolation-law block).
      ANTHROPIC_API_KEY: 'sk-ant-should-not-be-used',
    })
    expect(merged.CLAUDE_CONFIG_DIR).toBe('/workspace/.claude')
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined()
    expect(merged.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('opencode + openai_compatible: CUSTOM_LLM_* reaches the OpenCode launch config (descriptor keeps the full gateway/BYOK story for OpenCode)', () => {
    expect(HARNESSES.opencode.authKinds).toContain('openai_compatible')
    const { merged } = mergedLaunchEnv('opencode', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_compatible',
      CUSTOM_LLM_PROTOCOL: 'openai',
      CUSTOM_LLM_BASE_URL: 'https://byok.example.com',
      CUSTOM_LLM_API_KEY: 'byok-key',
      CUSTOM_LLM_MODEL_ID: 'byok-model',
    })
    expect(merged.OPENCODE_CONFIG_CONTENT).toBeDefined()
    const config = JSON.parse(merged.OPENCODE_CONFIG_CONTENT as string)
    expect(config.provider.custom.options.baseURL).toBe('https://byok.example.com')
    expect(config.provider.custom.options.apiKey).toBe('byok-key')
  })

  it('pi + openai_compatible: CUSTOM_LLM_* reaches the Pi launch config (descriptor keeps the full gateway/BYOK story for Pi)', () => {
    expect(HARNESSES.pi.authKinds).toContain('openai_compatible')
    const { merged } = mergedLaunchEnv('pi', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_compatible',
      CUSTOM_LLM_PROTOCOL: 'openai',
      CUSTOM_LLM_BASE_URL: 'https://byok.example.com',
      CUSTOM_LLM_API_KEY: 'byok-key',
      CUSTOM_LLM_MODEL_ID: 'byok-model',
    })
    expect(merged.KORTIX_PI_MODELS_JSON).toBeDefined()
    const config = JSON.parse(merged.KORTIX_PI_MODELS_JSON as string)
    expect(config.providers.custom.baseUrl).toBe('https://byok.example.com')
    expect(config.providers.custom.apiKey).toBe('byok-key')
  })
})

describe('env-based auth: negative case — kind not in the harness descriptor authKinds (WS2-P4-a)', () => {
  it('claude + managed_gateway (NOT in HARNESSES.claude.authKinds): the sandbox has no incompatible-kind guard — it builds a full gateway env exactly as it would for a legitimately gateway-routed harness', () => {
    // Pin what IS, per the brief: do not invent a sandbox-side guard. Read
    // through harness-registry.ts's claude branch of resolveAcpHarnessLaunchEnv
    // — the only authKind it special-cases is 'native_config'; every other
    // value (including one the descriptor never lists for claude) falls
    // through to "no direct provider cred present? try the managed-gateway
    // default" whenever KORTIX_API_URL/KORTIX_TOKEN happen to be set. The
    // conformance guarantee that claude is never actually routed this way in
    // production rests entirely on the api layer: `CONNECTIONS.managed_gateway
    // .compatible_harnesses` (composer-capabilities.ts) excludes 'claude', so
    // the api never sends KORTIX_RUNTIME_AUTH_KIND=managed_gateway for a
    // claude session in the first place. That api-side law is pinned in
    // composer-capabilities.test.ts (assertions 4-6 of this task).
    expect(HARNESSES.claude.authKinds).not.toContain('managed_gateway')
    const { merged } = mergedLaunchEnv('claude', {
      KORTIX_RUNTIME_AUTH_KIND: 'managed_gateway',
      KORTIX_API_URL: 'https://api.example.com',
      KORTIX_TOKEN: 'sandbox-token',
      // No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN —
      // isolateHarnessAuthEnv strips them anyway for kind=managed_gateway
      // (AUTH_ENV_BY_KIND.managed_gateway === []).
    })
    // Documenting the actual (unguarded) behavior, not a desired one:
    expect(merged.ANTHROPIC_BASE_URL).toBe('https://api.example.com/router')
    expect(merged.ANTHROPIC_AUTH_TOKEN).toBe('sandbox-token')
  })

  it('codex + openai_compatible (NOT in HARNESSES.codex.authKinds): same absence of a sandbox-side guard — a leaked CUSTOM_LLM_* config still produces a gateway-routed DEFAULT_AUTH_REQUEST for codex', () => {
    expect(HARNESSES.codex.authKinds).not.toContain('openai_compatible')
    const { merged } = mergedLaunchEnv('codex', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_compatible',
      CUSTOM_LLM_PROTOCOL: 'openai',
      CUSTOM_LLM_BASE_URL: 'https://byok.example.com',
      CUSTOM_LLM_API_KEY: 'byok-key',
    })
    // Again: pinned as an api-layer trust boundary, not a sandbox guard.
    // CONNECTIONS.openai_compatible.compatible_harnesses (composer-capabilities.ts)
    // excludes 'codex', so this KORTIX_RUNTIME_AUTH_KIND value is never
    // actually produced for a codex session by the api.
    expect(merged.DEFAULT_AUTH_REQUEST).toContain('byok.example.com')
  })
})

describe('env-based auth: cred-isolation law — the selected kind\'s own env names only, every other provider stripped (WS2-P4-a)', () => {
  // Hand-mirrors harness-registry.ts's private AUTH_ENV_BY_KIND (not exported;
  // this is the pin against accidental drift — if that table changes, this
  // literal must be updated to match, and a mismatch fails the loop below).
  const KIND_TO_OWN_ENV: Record<RuntimeAuthKind, string[]> = {
    managed_gateway: [],
    claude_subscription: ['CLAUDE_CODE_OAUTH_TOKEN'],
    anthropic_api_key: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    codex_subscription: ['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON'],
    openai_api_key: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    openai_compatible: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_MODEL_ID'],
    anthropic_compatible: ['CUSTOM_LLM_PROTOCOL', 'CUSTOM_LLM_BASE_URL', 'CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_MODEL_ID'],
    native_config: [],
  }
  // All provider-credential env names that could ever be present, mirroring
  // harness-registry.ts's private PROVIDER_CREDENTIAL_ENV.
  const ALL_PROVIDER_ENV: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: 'leak-claude-oauth',
    ANTHROPIC_API_KEY: 'leak-anthropic-key',
    ANTHROPIC_AUTH_TOKEN: 'leak-anthropic-token',
    CODEX_AUTH_JSON: 'leak-codex-auth',
    OPENCODE_AUTH_JSON: 'leak-opencode-auth',
    OPENAI_API_KEY: 'leak-openai-key',
    CODEX_API_KEY: 'leak-codex-key',
    CUSTOM_LLM_PROTOCOL: 'leak-protocol',
    CUSTOM_LLM_BASE_URL: 'leak-base-url',
    CUSTOM_LLM_API_KEY: 'leak-custom-key',
    CUSTOM_LLM_MODEL_ID: 'leak-model-id',
  }

  // Only exercise kinds that actually appear in some harness's descriptor
  // authKinds, i.e. everything except the parked anthropic_compatible — that
  // kind is exercised separately below since no harness declares it.
  const kindsInAnyHarness = new Set<RuntimeAuthKind>(
    HARNESS_IDS.flatMap((id) => HARNESSES[id].authKinds as RuntimeAuthKind[]),
  )

  it('every descriptor-listed kind isolates correctly: its own env names pass through, every other provider is stripped', () => {
    for (const kind of kindsInAnyHarness) {
      const env: NodeJS.ProcessEnv = { KORTIX_RUNTIME_AUTH_KIND: kind, ...ALL_PROVIDER_ENV }
      const isolated = isolateHarnessAuthEnv(env)
      const ownNames = KIND_TO_OWN_ENV[kind]
      for (const name of Object.keys(ALL_PROVIDER_ENV)) {
        if (ownNames.includes(name)) {
          expect(isolated[name]).toBe(ALL_PROVIDER_ENV[name]!)
        } else {
          expect(isolated[name]).toBeUndefined()
        }
      }
    }
  })

  it('native_config strips every provider credential even though it is a valid kind for all four harnesses', () => {
    const env: NodeJS.ProcessEnv = { KORTIX_RUNTIME_AUTH_KIND: 'native_config', ...ALL_PROVIDER_ENV }
    const isolated = isolateHarnessAuthEnv(env)
    for (const name of Object.keys(ALL_PROVIDER_ENV)) {
      expect(isolated[name]).toBeUndefined()
    }
  })

  it('anthropic_compatible (parked, zero compatible_harnesses at the api layer) still isolates correctly at this layer — the sandbox mapping was left intact, only the api route to it was removed', () => {
    const env: NodeJS.ProcessEnv = { KORTIX_RUNTIME_AUTH_KIND: 'anthropic_compatible', ...ALL_PROVIDER_ENV }
    const isolated = isolateHarnessAuthEnv(env)
    const ownNames = KIND_TO_OWN_ENV.anthropic_compatible
    for (const name of Object.keys(ALL_PROVIDER_ENV)) {
      if (ownNames.includes(name)) expect(isolated[name]).toBe(ALL_PROVIDER_ENV[name]!)
      else expect(isolated[name]).toBeUndefined()
    }
  })

  it('claude + anthropic_api_key selected: OPENAI_API_KEY (a different provider) does not reach the child env', () => {
    const { merged } = mergedLaunchEnv('claude', {
      KORTIX_RUNTIME_AUTH_KIND: 'anthropic_api_key',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-oai-leak',
      CODEX_API_KEY: 'sk-codex-leak',
    })
    expect(merged.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(merged.OPENAI_API_KEY).toBeUndefined()
    expect(merged.CODEX_API_KEY).toBeUndefined()
  })

  it('codex + openai_api_key selected: ANTHROPIC_API_KEY (a different provider) does not reach the child env', () => {
    const { merged } = mergedLaunchEnv('codex', {
      KORTIX_RUNTIME_AUTH_KIND: 'openai_api_key',
      OPENAI_API_KEY: 'sk-oai-test',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-leak',
    })
    expect(merged.OPENAI_API_KEY).toBe('sk-oai-test')
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined()
    expect(merged.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})
