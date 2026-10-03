import { describe, expect, test } from 'bun:test';

import pkg from '../package.json';

/**
 * `bun test` shares ONE module registry across every test file in a run.
 *
 * Nine files under `src/` call `mock.module('@kortix/sdk', () => ({ … }))` with
 * a two- or three-key object — `maintenance-store.test.ts` and
 * `session-audit-shared.test.ts` among them. Without isolation that partial
 * object REPLACES the real module for every file that runs after it, so the
 * next file to import a genuine export dies at link time:
 *
 *   SyntaxError: Export named 'listProjectsForAccount' not found in module
 *   '…/packages/sdk/src/index.ts'
 *
 * Which export, and whether it happens at all, depends purely on file
 * discovery order — so it passed on one machine and failed the `packages` lane
 * on another, naming a different export each run. Reproduce it in two files:
 *
 *   bun test src/lib/maintenance-store.test.ts \
 *            <a file that mock.module()s @kortix/sdk>                    # red
 *   bun test --isolate <the same two>                                    # green
 *
 * `--isolate` gives each file a fresh global object, which is the same fix and
 * the same reasoning `apps/api/scripts/test.sh` documents. `--parallel=4` pays
 * for it: 680 files run in ~30s isolated versus ~109s isolated-and-serial,
 * against a ~24s non-isolated baseline that is not actually correct.
 */
describe('apps/web test runner', () => {
  test('runs isolated, so a mock.module() cannot leak across files', () => {
    expect(pkg.scripts.test).toContain('--isolate');
  });

  test('stays serial: a parallel --test-worker spun at 100% CPU past every per-test timeout', () => {
    // Twice on a 12 GiB agent sandbox (2026-10-03) one parallel --test-worker
    // looped at ~100% CPU for 17+ minutes with `--timeout=5000` unable to
    // interrupt it (a synchronous loop; the timer only fires between turns),
    // wedging the packages lane. Serial completes the suite (~348 s across
    // 922 files on the same box) — the isolation reason still holds, the
    // parallelism does not.
    expect(pkg.scripts.test).not.toMatch(/--parallel/);
  });
});
