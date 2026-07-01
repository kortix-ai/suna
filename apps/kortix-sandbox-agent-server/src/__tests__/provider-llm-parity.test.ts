import { describe, test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { buildOpencodeConfigContent } from '../opencode'
import { resolveLlmRuntime, shouldDisableProxyModeGateway } from '../llm-proxy'

// The integrator (session-sandbox.ts) calls provider.create(envVars) through ONE
// SandboxProvider interface and never branches on Daytona vs Platinum. This suite
// enforces the matching promise one layer down: the in-sandbox daemon must resolve
// the SAME OBSERVABLE LLM runtime for the same logical input, whichever provider's
// boot model produced the env. Daytona (cold: real gateway creds in env) and
// Platinum (warm: gateway via the localhost hot-swap proxy) use different transports
// — that is an internal detail the caller must not see. A per-provider difference in
// the OBSERVABLE outcome (gateway available? which providers enabled?) is a bug, and
// fails here.

// Small baked catalog so config materialization is deterministic (no /models fetch)
// for BOTH the direct and proxy transports.
const catalog = join(mkdtempSync(join(tmpdir(), 'parity-cat-')), 'catalog.json')
writeFileSync(catalog, JSON.stringify({ models: { 'kortix/auto': { id: 'kortix/auto', name: 'Auto' } } }))

// Provider-shaped envs for the SAME logical input. These mirror what each provider
// hands the daemon: Daytona bakes the real gateway creds into opencode's env; a
// Platinum warm template bakes KORTIX_LLM_HOTSWAP + routes through KORTIX_LLM_PROXY_URL
// and injects the real token into the proxy at adoption (modelled by proxyHasToken).
const daytonaEntitled: NodeJS.ProcessEnv = {
  KORTIX_LLM_API_KEY: 'real-session-key',
  KORTIX_LLM_BASE_URL: 'https://gateway.kortix.test/v1/llm',
  KORTIX_LLM_CATALOG_FILE: catalog,
}
const platinumEntitled: NodeJS.ProcessEnv = {
  KORTIX_LLM_HOTSWAP: '1',
  KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
  KORTIX_LLM_CATALOG_FILE: catalog,
}
const daytonaUnentitled: NodeJS.ProcessEnv = {}
const platinumUnentitled: NodeJS.ProcessEnv = {
  KORTIX_LLM_HOTSWAP: '1',
  KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
  KORTIX_LLM_CATALOG_FILE: catalog,
}

// Model the daemon's fork-adoption reconciliation then materialize opencode's config,
// and reduce it to what the agent/integrator actually observes — deliberately
// ignoring internal transport (proxy baseURL vs direct baseURL).
async function observableRuntime(env: NodeJS.ProcessEnv, proxyHasToken: boolean) {
  const e = { ...env }
  const hotswapBaked = e.KORTIX_LLM_HOTSWAP === '1'
  const proxyUrlSet = !!e.KORTIX_LLM_PROXY_URL
  // Adoption reconciliation (what main.ts does): drop the warm proxy transport if it
  // will never serve, so the config downgrades to the same outcome a cold box gets.
  if (
    shouldDisableProxyModeGateway({
      hotswapBaked,
      proxyUrlSet,
      proxyReady: proxyHasToken,
      directGatewayCredsPresent: !!e.KORTIX_LLM_API_KEY && !!e.KORTIX_LLM_BASE_URL,
    })
  ) {
    delete e.KORTIX_LLM_PROXY_URL
  }
  const raw = await buildOpencodeConfigContent(e)
  const cfg = raw ? JSON.parse(raw) : null
  return {
    gatewayAvailable: !!cfg?.provider?.kortix,
    enabledProviders: (cfg?.enabled_providers as string[] | undefined) ?? null,
  }
}

describe('provider parity — Daytona and Platinum yield identical OBSERVABLE LLM runtime', () => {
  test('entitled account: both expose the gateway (transport differs internally, capability identical)', async () => {
    const daytona = await observableRuntime(daytonaEntitled, /* proxyHasToken */ false)
    const platinum = await observableRuntime(platinumEntitled, /* proxyHasToken */ true)

    expect(daytona.gatewayAvailable).toBe(true)
    expect(platinum.gatewayAvailable).toBe(true)
    // The whole point: same observable result on both providers.
    expect(platinum.gatewayAvailable).toBe(daytona.gatewayAvailable)
    expect(platinum.enabledProviders).toEqual(daytona.enabledProviders) // ['kortix'] on both
  })

  test('unentitled account: both fall back to native — no dead gateway left on Platinum', async () => {
    const daytona = await observableRuntime(daytonaUnentitled, false)
    const platinum = await observableRuntime(platinumUnentitled, /* proxyHasToken */ false)

    expect(daytona.gatewayAvailable).toBe(false)
    expect(platinum.gatewayAvailable).toBe(false)
    expect(platinum.gatewayAvailable).toBe(daytona.gatewayAvailable)
    expect(platinum.enabledProviders).toEqual(daytona.enabledProviders) // null (native) on both
  })

  test('the pure oracle agrees for both provider shapes (same kind regardless of transport)', () => {
    // Entitled: Daytona resolves via direct creds, Platinum via a tokened proxy —
    // different transport, SAME kind.
    const dEnt = resolveLlmRuntime({ proxyTransportAvailable: false, proxyHasToken: false, directGatewayCredsPresent: true })
    const pEnt = resolveLlmRuntime({ proxyTransportAvailable: true, proxyHasToken: true, directGatewayCredsPresent: false })
    expect(dEnt.kind).toBe('gateway')
    expect(pEnt.kind).toBe('gateway')
    expect(pEnt.kind).toBe(dEnt.kind)

    // Unentitled: neither has a usable gateway → both native.
    const dUn = resolveLlmRuntime({ proxyTransportAvailable: false, proxyHasToken: false, directGatewayCredsPresent: false })
    const pUn = resolveLlmRuntime({ proxyTransportAvailable: true, proxyHasToken: false, directGatewayCredsPresent: false })
    expect(dUn.kind).toBe('native')
    expect(pUn.kind).toBe('native')
    expect(pUn.kind).toBe(dUn.kind)
  })

  // Guardrail: prove the reconciliation is LOAD-BEARING. Without it, Platinum's raw
  // unentitled seed config mounts a token-less (dead) `kortix` provider while Daytona
  // is native — the exact divergence this contract forbids. If someone deletes the
  // adoption teardown, the parity tests above still need this to stay meaningful.
  test('regression proof: raw Platinum seed config DIVERGES from Daytona for unentitled (why reconciliation exists)', async () => {
    const rawPlatinum = JSON.parse((await buildOpencodeConfigContent(platinumUnentitled))!)
    const rawDaytona = await buildOpencodeConfigContent(daytonaUnentitled)

    expect(rawPlatinum.provider.kortix).toBeDefined() // token-less dead gateway mounted
    expect(rawDaytona).toBeUndefined() // native
    // They differ WITHOUT reconciliation → observableRuntime()'s convergence above is real work.
  })
})
