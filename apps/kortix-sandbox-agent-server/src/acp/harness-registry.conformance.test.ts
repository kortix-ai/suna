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

import { ACP_HARNESS_IDS, createAcpHarnessRegistry, resolveAcpHarnessLaunchEnv } from './harness-registry'

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
