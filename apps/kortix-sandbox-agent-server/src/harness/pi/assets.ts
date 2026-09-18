/**
 * pi ships INSIDE the daemon binary, so the runtime-assets convergence loop
 * has nothing of pi's to install or roll: no components. The managed skill
 * overlay still lands in the project's skills directory, which pi reads.
 */
import { ensureInjectedManagedSkills } from '../../managed-skills'
import type { HarnessAssetsService } from '../assets'
import { resolvePiConfigDir } from './config'

export function createPiAssetsService(): HarnessAssetsService {
  return {
    componentNames: [],
    resolveConfigDir: async (cfg) => resolvePiConfigDir(cfg),
    injectSkills: (configDir, bakedDir) => ensureInjectedManagedSkills(configDir, { bakedDir }),
    reconcile: async () => ({ components: {}, reasons: {}, state: { pi: 'bundled' } }),
  }
}
