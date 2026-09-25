/**
 * pi ships INSIDE the daemon binary, so the runtime-assets convergence loop
 * has nothing of pi's to install or roll: no components. pi reads the managed
 * skill overlay straight from its baked dir (`resolvePiSkillDirectories`), so
 * there is nothing to inject into the working tree either.
 *
 * The overlay can still change under a running pi: runtime-assets writes it
 * from the API after boot (on a real box, ~1 s after `pi runtime ready`).
 * `injectSkills` is the hook it calls then, and pi answers by reloading its
 * skills, or the session never sees the managed `kortix-*` family.
 */
import { logger } from '../../logger'
import type { HarnessAssetsService } from '../assets'

/** Reloads the live runtime's skills; registered by `createPiHarnessService`. */
let reloadLiveSkills: (() => Promise<unknown>) | null = null

export function registerPiSkillReload(reload: () => Promise<unknown>): void {
  reloadLiveSkills = reload
}

export function createPiAssetsService(): HarnessAssetsService {
  return {
    componentNames: [],
    resolveConfigDir: async (cfg) => cfg.projectTarget || cfg.workspace || '/workspace',
    injectSkills: async () => {
      await reloadLiveSkills?.().catch((err) =>
        logger.warn('[pi] skill reload after a managed-skill overlay update failed', { err: String(err) }),
      )
    },
    reconcile: async () => ({ components: {}, reasons: {}, state: { pi: 'bundled' } }),
  }
}
