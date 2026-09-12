/**
 * Git transport: a thin adapter over the existing, optimized acquisition path
 * in `git.ts` (compiled checkout → image-baked scaffold + delta → clone). The
 * warm-checkout adoption runs in the coordinator before any transport, so this
 * always starts from an empty target. Nothing here changes what Git does; it
 * only reports what it delivered.
 */
import { acquireProjectViaGit, readRepoInfo } from '../../git'
import type { MaterializeRequest, MaterializedProject } from '../types'

export async function materializeViaGit(req: MaterializeRequest): Promise<MaterializedProject> {
  const started = Date.now()
  await acquireProjectViaGit(req.cfg)
  const gitMs = Date.now() - started
  const info = await readRepoInfo(req.target)
  return {
    provider: 'git',
    sha: info?.commit ?? null,
    expectedSha: req.expectedSha,
    workspacePath: req.target,
    timings: { git: gitMs },
  }
}
