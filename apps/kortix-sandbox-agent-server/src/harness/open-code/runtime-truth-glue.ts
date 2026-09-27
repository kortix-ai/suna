import { requireOpenCodeConfig, type OpenCodeConfig } from './config'
import { ConvergeBusyError, configReleaseReport, convergeConfigRelease } from './config-release'
import {
  cachedManagedModels,
  configuredKortixProviderModelIds,
  missingManagedModelIds,
  settleManagedModelsPrefetch,
  startManagedModelsPrefetch,
  writeManagedOverlayCatalogFile,
  type Opencode,
} from './lifecycle'
import { opencodeTurnInFlight } from './opencode-turn-state'
import { OPENCODE_HOME } from './paths'
import { logger } from '../../lib/log/logger'
import { scheduleRuntimeAssetsReconcile } from '../../services/runtime-assets/runtime-assets'
import { configureRuntimeTruth, startRuntimeTruthTicker, type RuntimeTruthDeps } from '../../services/runtime-assets/runtime-truth'
import type { Config as HostConfig } from '../../lib/config/config'

/**
 * Wires `runtime-truth.ts` (host, harness-neutral) to THIS harness's concrete
 * runtime, and starts its ticker.
 *
 * This file is the one place OpenCode-specific state (config releases, the
 * managed-model catalog) crosses into the host's convergence tick. It exists
 * so `runtime-truth.ts` itself never imports `harness/open-code/*`
 * (the boundary lint, eslint.config.mjs, forbids that from a service) — the
 * ALLOWED direction is an adapter importing host code, which is what this
 * file, and its one caller (`boot.ts`'s `runtimeReadyTail`), do.
 *
 * Called from BOTH of `startSessionRuntime`'s readiness exits (boot.ts's own
 * doc on `runtimeReadyTail`), including warm-fork adoption, so `configureRuntimeTruth`
 * always holds the CURRENT `opencode`/`cfg`. `startRuntimeTruthTicker` is
 * idempotent, so a second call here never stacks a second interval.
 */
export function wireRuntimeTruth(cfg: HostConfig, opencode: Opencode): void {
  configureRuntimeTruth(buildRuntimeTruthDeps(cfg, opencode))
  startRuntimeTruthTicker()
}

function buildRuntimeTruthDeps(cfg: HostConfig, opencode: Opencode): RuntimeTruthDeps {
  return {
    reconcileAssets: () => scheduleRuntimeAssetsReconcile(cfg),
    readConfigRelease: () => configReleaseReport(),
    reconcileConfigRelease: () => reconcileConfigRelease(cfg, opencode),
    readCatalog: () => ({
      configuredIds: configuredKortixProviderModelIds(),
      liveKnown: cachedManagedModels() !== null,
      missingIds: missingManagedModelIds(cachedManagedModels()),
    }),
    reconcileCatalog: () => reconcileCatalog(cfg, opencode),
  }
}

function resolveOpenCodeConfig(cfg: HostConfig): OpenCodeConfig | null {
  try {
    return requireOpenCodeConfig(cfg)
  } catch {
    return null // Not the OpenCode harness on this box; nothing to converge.
  }
}

async function reconcileConfigRelease(cfg: HostConfig, opencode: Opencode): Promise<void> {
  const openCodeCfg = resolveOpenCodeConfig(cfg)
  if (!openCodeCfg) return
  try {
    await convergeConfigRelease({
      cfg: openCodeCfg,
      opencode,
      turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), openCodeCfg.workspace),
    })
  } catch (err) {
    if (err instanceof ConvergeBusyError) return // A convergence is already running; the next tick's read is still fresh.
    logger.warn('[runtime-truth] config-release tick failed', { err: String(err) })
  }
}

async function reconcileCatalog(cfg: HostConfig, opencode: Opencode): Promise<void> {
  const baseUrl = process.env.KORTIX_LLM_BASE_URL
  const apiKey = process.env.KORTIX_TOKEN
  if (!baseUrl || !apiKey) return
  startManagedModelsPrefetch(baseUrl, apiKey)
  const live = await settleManagedModelsPrefetch()
  if (!live) return
  const missing = missingManagedModelIds(live)
  if (missing.length === 0) return
  const openCodeCfg = resolveOpenCodeConfig(cfg)
  if (!openCodeCfg) return
  const turnInFlight = await opencodeTurnInFlight(opencode.getInternalUrl(), openCodeCfg.workspace)
  if (turnInFlight !== false) return // Never restart under a live or unreadable turn; the next tick tries again.
  try {
    const written = writeManagedOverlayCatalogFile({
      currentCatalogFile: process.env.KORTIX_LLM_CATALOG_FILE ?? '/opt/kortix/llm-catalog.json',
      targetCatalogFile: `${OPENCODE_HOME}/.config/kortix-llm-catalog.session.json`,
      managed: live,
    })
    if (written) process.env.KORTIX_LLM_CATALOG_FILE = written
    await opencode.restart()
    logger.info('[runtime-truth] catalog tick restarted opencode with newly-available managed models', { missing })
  } catch (err) {
    logger.warn('[runtime-truth] catalog tick failed', { err: String(err) })
  }
}
