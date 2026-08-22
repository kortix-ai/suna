/**
 * Run-scoped identity helpers.
 *
 * Deliberately dependency-free (no `bun:` imports) so the unit lane, which runs
 * under vitest/node, can load it directly.
 */

/**
 * The re-run suffix for a run-scoped identity, or '' on the first attempt.
 *
 * `github.run_id` is IDENTICAL across attempts of one workflow run, and the
 * release gate seeds every run-scoped fixture name from it (`principals.ts`
 * names principals `e2e-<runId>-…`). Without this suffix `gh run rerun --failed`
 * re-derives names its own first attempt already claimed: run 32330628092
 * attempt 2 failed KAAB-7 in 2.2s with `409 IDEMPOTENCY_KEY_CONFLICT` on its
 * first `POST /sessions`, reporting a healthy flow as a failure on the release
 * gate during a release.
 *
 * Attempt 1 returns '' so first-attempt ids stay byte-identical to what they
 * have always been — only a re-run is namespaced. A malformed value degrades to
 * '' rather than inventing a junk namespace that nothing would ever reclaim.
 */
export function runAttemptSuffix(
  env: Record<string, string | undefined> = process.env,
): string {
  const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? '1', 10);
  return Number.isFinite(attempt) && attempt > 1 ? `-a${attempt}` : '';
}
