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
 *            src/lib/onboarding/ensure-first-project.provision.test.ts   # red
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

  test('keeps the parallelism that makes isolation affordable', () => {
    expect(pkg.scripts.test).toMatch(/--parallel=\d+/);
  });
});
