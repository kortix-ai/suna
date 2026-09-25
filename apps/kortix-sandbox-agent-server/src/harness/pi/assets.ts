/**
 * pi ships INSIDE the daemon binary, so the runtime-assets convergence loop
 * has nothing of pi's to install or roll: no components. pi reads the managed
 * skill overlay straight from its baked dir (`resolvePiSkillDirectories`), so
 * there is nothing to inject into the working tree either.
 */
import type { HarnessAssetsService } from '../assets'

export function createPiAssetsService(): HarnessAssetsService {
  return {
    componentNames: [],
    resolveConfigDir: async (cfg) => cfg.projectTarget || cfg.workspace || '/workspace',
    injectSkills: async () => {},
    reconcile: async () => ({ components: {}, reasons: {}, state: { pi: 'bundled' } }),
  }
}
