/**
 * One fresh-boot acquisition, exactly as the daemon runs it at session start
 * (config-provider coordinator: warm check → git | prefer-s3 → hydration),
 * driven by the same KORTIX_* environment the API hands a session — but in a
 * throwaway workspace on THIS machine, with no sandbox provider in the loop.
 *
 * Used by config-provider-bench.ts; run directly for one shot:
 *
 *   KORTIX_WORKSPACE=/tmp/ws KORTIX_PROJECT_TARGET=/tmp/ws \
 *   KORTIX_REPO_URL=http://localhost:8008/v1/git/<project>.git KORTIX_TOKEN=<pat> \
 *   KORTIX_SESSION_FRESH=1 KORTIX_BASE_SHA=<tip> KORTIX_BRANCH_NAME=<session> \
 *   KORTIX_GIT_DELTA_BUNDLE_REMOTE=1 KORTIX_GIT_DELTA_PARENT_SHA=<scaffold root> \
 *   KORTIX_BENCH_SCAFFOLD_GIT=/tmp/scaffold.git \
 *   [KORTIX_PROJECT_SNAPSHOT_MODE=prefer-s3 KORTIX_PROJECT_SNAPSHOT_PIN=<sha:sha256:bytes>] \
 *   bun run scripts/materialize-once.ts
 *
 * Prints one `BENCH_RESULT {…}` line on stdout (the daemon's own log lines
 * precede it). KORTIX_BENCH_SCAFFOLD_GIT stands in for the image's
 * /opt/kortix/scaffold.git.
 */
import { loadConfig } from '../src/config'
import { materializeProject } from '../src/config-provider/config-provider'
import { __setScaffoldRepoPathForTests } from '../src/git'

const scaffold = process.env.KORTIX_BENCH_SCAFFOLD_GIT?.trim()
if (scaffold) __setScaffoldRepoPathForTests(scaffold)

const cfg = loadConfig(process.env)
const t0 = performance.now()
const marks: Record<string, number> = {}
const ms = () => Math.round(performance.now() - t0)

try {
  const result = await materializeProject(cfg, {
    bootMark: (label) => {
      marks[label] = ms()
    },
  })
  const acquireMs = ms()
  const hydration = result.hydration ? await result.hydration : null
  console.log(
    `BENCH_RESULT ${JSON.stringify({
      ok: true,
      provider: result.provider,
      sha: result.sha,
      expected_sha: result.expectedSha,
      fallback: result.fallback ?? null,
      s3: result.s3 ?? null,
      summary: result.summary,
      hydration,
      marks,
      wall_acquire_ms: acquireMs,
      wall_total_ms: ms(),
    })}`,
  )
} catch (err) {
  console.log(
    `BENCH_RESULT ${JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      marks,
      wall_total_ms: ms(),
    })}`,
  )
  process.exit(1)
}
