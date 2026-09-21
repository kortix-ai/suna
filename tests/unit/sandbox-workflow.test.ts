import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/tests.yml'), 'utf8');

describe('native test-lane workflow', () => {
  test('runs six root lanes natively on Blacksmith at the pull request head SHA', () => {
    // Since 2026-08-26 the lanes run on the runner itself. The old
    // sandbox-worker path failed on ~every third lane the day before.
    expect(testWorkflow).toContain(
      'TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    );
    expect(testWorkflow).toContain("runs-on: ${{ vars.CI_RUNNER_L || 'blacksmith-8vcpu-ubuntu-2404' }}");
    expect(testWorkflow).toContain('- lane: core');
    expect(testWorkflow).toContain('- lane: browser-1');
    expect(testWorkflow).toContain('- lane: browser-2');
    expect(testWorkflow).toContain('- lane: packages');
    // Four browser shards since 2026-09-18: 10m19s -> 8m17s. `packages`
    // (8m01s) is now the binding lane, so a fifth shard buys nothing.
    expect(testWorkflow).toContain('- lane: browser-3');
    expect(testWorkflow).toContain('- lane: browser-4');
    for (const n of [1, 2, 3, 4]) {
      expect(testWorkflow).toContain(`args: --browser-only --browser-shard=${n}/4`);
    }
    expect(testWorkflow).not.toContain('--browser-shard=1/2');
    expect(testWorkflow).toContain('args: --packages-only');
    // The unchanged root command is the whole lane.
    expect(testWorkflow).toContain('if [[ -n "$TEST_ARGS" ]]; then pnpm test -- $TEST_ARGS; else pnpm test; fi');
    // Every run is a full run now, so the packages guard keys off the lane
    // alone. `TEST_MODE` went away with `workflow_call`.
    expect(testWorkflow).toContain('if [[ "$TEST_LANE" == "packages" ]]; then');
    expect(testWorkflow).toContain('export KORTIX_PACKAGE_SKIP_SDK_TESTS=1');
    expect(testWorkflow).not.toContain('TEST_MODE');
    expect(testWorkflow).toContain('pnpm install --frozen-lockfile');
    expect(testWorkflow).toContain('bun-version: 1.3.14');
    // A hang detector, sized from 57 runs (packages p50 370s, max 570s). A hung
    // lane used to burn 60 min before the trunk verdict could fire.
    expect(testWorkflow).toMatch(/^ {4}timeout-minutes: 20$/m);
    expect(testWorkflow).not.toMatch(/^ {4}timeout-minutes: 60$/m);
  });

  test('gives the browser lanes Chromium and a prestarted Supabase, and always stops it', () => {
    expect(testWorkflow).toContain('pnpm --dir tests exec playwright install --with-deps chromium');
    expect(testWorkflow).toContain('pnpm exec supabase start --ignore-health-check');
    expect(testWorkflow).toContain('pnpm exec supabase stop --no-backup || true');
    expect(testWorkflow).toMatch(/if: always\(\) && matrix\.mode == 'browser'/);
  });

  test('has no cloud-sandbox worker path left', () => {
    for (const path of [
      'tests/bin/sandbox-ci.ts',
      'tests/bin/sandbox-ci-cleanup.ts',
      'tests/src/core/sandbox-ci.ts',
      'tests/bin/platinum-ci.ts',
      'tests/bin/platinum-ci-cleanup.ts',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
    for (const token of ['sandbox-ci', 'PLATINUM_API_KEY', 'DAYTONA_API_KEY', 'TEST_SANDBOX_PROVIDER']) {
      expect(testWorkflow, token).not.toContain(token);
    }
  });

  test('uploads results after the worker returns', () => {
    expect(testWorkflow).toContain('actions/upload-artifact@v7');
    // The upload path is a multi-line block since the bypass-state exclusion
    // landed: `path: |` then the glob, then `!…/deployment-bypass-state.json`.
    expect(testWorkflow).toMatch(/path: \|\s*\n\s*tests\/test-results\/\*\*/);
    expect(testWorkflow).toContain('!tests/test-results/deployment-bypass-state.json');
    expect(testWorkflow).toContain('if: always()');
  });

  test('keeps reports in workflow artifacts without hosted portal infrastructure', () => {
    expect(existsSync(resolve(root, 'infra/terraform/environments/qa/main.tf'))).toBe(false);
    expect(existsSync(resolve(root, 'infra/terraform/modules/qa-portal/main.tf'))).toBe(false);

    const workflowRoot = resolve(root, '.github/workflows');
    const workflows = readdirSync(workflowRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => readFileSync(resolve(workflowRoot, name), 'utf8'))
      .join('\n');

    expect(workflows).not.toContain('QA_REPORTS_');
    expect(workflows).not.toContain('qa.kortix.com');
  });

  test('release tests prove every deployed staging flow and browser journey', () => {
    const release = readFileSync(resolve(root, '.github/workflows/tests-release.yml'), 'utf8');

    // Branch protection on `prod` requires exactly this one context, so the
    // aggregator job keeps the name while the shards do the work. Renaming it
    // breaks the required check silently.
    expect(release).toContain('name: full suite + quality gates');
    expect(release).toContain('needs: [api, browser]');
    // Six API shards, and the workflow must ask for the same denominator that
    // `unit/shard.test.ts` proves the partition against. On run 32240074477
    // four shards of 137 flows were all killed by their cap ~60% through.
    expect(release).toContain('shard: [1, 2, 3, 4, 5, 6]');
    expect(release).toContain('pnpm test -- --target-api-full --api-shard=${{ matrix.shard }}/6');
    expect(release).toContain('pnpm test -- --target-browser-full --browser-shard=${{ matrix.shard }}/3');
    expect(release).toContain('fail-fast: false');
    // A cap is a hang detector, not a throttle. 40 minutes throttled: it killed
    // shards that were passing 76/87 and 68/77 of what they had run.
    expect(release).toMatch(/^ {4}timeout-minutes: 60$/m);
    // Keep each shard below staging's proven concurrency ceiling.
    expect(release).toContain("KE2E_API_WORKERS: '1'");
    expect(release).toContain("KE2E_SANDBOX_WORKERS: '1'");
    expect(release).toContain("KE2E_TIMEOUT_ATTEMPTS: '2'");
    // Dry run against staging without a release PR. `RELEASE_SOURCE_SHA` only
    // exists on a `release/*` branch, so without this input the gate could
    // never be rehearsed — which is how it stayed un-green.
    expect(release).toContain('expected_sha:');
    expect(release).toContain('EXPECTED_SHA: ${{ inputs.expected_sha }}');
    // Every reference to the input is an `env:` binding. A dispatch input
    // interpolated straight into a `run:` script is arbitrary code execution,
    // so the counts must match exactly — once per SHA-checking job.
    const bindings = release.match(/^\s+EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}$/gm) ?? [];
    const references = release.match(/inputs\.expected_sha/g) ?? [];
    expect(bindings).toHaveLength(2);
    expect(references).toHaveLength(bindings.length);
    expect(release.match(/\[\[ "\$source_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/g)).toHaveLength(2);
    // Cleanup-on-cancel: a cancelled job never reaches the runner's `finally`
    // teardown, so the sweep must be wired pre-run and `if: always()` post-run.
    expect(release).toContain('bun tests/bin/ke2e.ts gc --older-than 2h');
    expect(release).toContain('bun tests/bin/ke2e.ts gc --run-id');
    // The pre-run sweep is a janitor, never a gate. On run 32226539107 its
    // job cap fired mid-delete, the job went `cancelled`, and every shard was
    // skipped. Two guards: a bounded gc STEP, and shards that run unless the
    // whole workflow was cancelled.
    const sweepBefore = release.slice(release.indexOf('  sweep-before:'), release.indexOf('  api:'));
    expect(sweepBefore).toContain('continue-on-error: true');
    expect(sweepBefore).toMatch(/- name: Reclaim test accounts older than 2h\n\s+timeout-minutes: 12/);
    for (const job of ['  api:', '  browser:']) {
      const start = release.indexOf(job);
      const block = release.slice(start, release.indexOf('runs-on:', start));
      expect(block, `${job.trim()} must not depend on the janitor's result`).toContain('if: ${{ !cancelled() }}');
    }
    expect(release).toContain('RELEASE_SOURCE_SHA');
    expect(release).toContain('WEB_PROTECTION_PASSWORD');
    // Staging sits behind Vercel SSO: every authenticated page 302s to
    // vercel.com/sso-api without this bypass secret, which playwright.config
    // turns into `x-vercel-protection-bypass`. Restored in #6415.
    expect(release).toContain(
      'VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
    );
    expect(release).toContain('https://staging-api.kortix.com/v1');
    expect(release).toContain('https://staging.kortix.com');
  });

  test('gates the local suite on promotes and on an opt-in label, never on every main PR', () => {
    // 2026-09-18. Every PR into `main` used to wait ~11 min (68 min worst
    // case) for a suite that gated nothing: `main` and `staging` have NO
    // required status checks. Keep this test and the workflow header in sync.
    expect(testWorkflow).toContain('branches: [main, staging]');
    expect(testWorkflow).not.toContain('branches: [main, staging, prod]');

    // Adding the label to an already-open PR must re-trigger the workflow, or
    // the opt-in silently needs a push to take effect.
    expect(testWorkflow).toContain(
      'types: [opened, reopened, synchronize, ready_for_review, labeled, unlabeled]',
    );

    // The four clauses of the gate, asserted inside the `lane` job block so
    // moving the `if:` onto another job fails here. `contains(<array>, 'test')`
    // compares whole elements, so `no-tests-needed` cannot match.
    const laneJob = testWorkflow.slice(
      testWorkflow.indexOf('\n  lane:'),
      testWorkflow.indexOf('\n  trunk-report:'),
    );
    expect(laneJob).toContain("github.event_name != 'pull_request'");
    expect(laneJob).toContain("|| github.base_ref == 'staging'");
    expect(laneJob).toContain("|| contains(github.event.pull_request.labels.*.name, 'test')");
    expect(laneJob).toContain("|| contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(laneJob).toContain('fail-fast: false');
    // `trunk-report` finds failed lanes by `endswith("lane")` on this name.
    expect(laneJob).toContain('name: ${{ matrix.lane }} lane');

    // One file, one gate. The reusable-workflow plumbing and its `decide` job
    // are gone; a second dispatch path is how the gate drifts.
    expect(testWorkflow).not.toContain('workflow_call');
    expect(testWorkflow).not.toContain('inputs.mode');
    expect(testWorkflow).not.toMatch(/^  decide:/m);
  });

  test('the dev trunk tests its own latest commit, and cannot block anything', () => {
    // A push-triggered run has nothing left to gate: the code merged, and
    // deploy-dev.yml deploys the same push without waiting.
    expect(testWorkflow).toMatch(/\n  push:\n(?:\s+#.*\n)*\s+branches: \[main\]/);
    // The suite parses markdown (tests/spec/end-to-end.md feeds route coverage).
    // Skipping docs-only pushes leaves main red with no run and blames the
    // next commit.
    expect(testWorkflow).not.toMatch(/^\s+paths-ignore:/m);

    // Per-ref group: a PR run (refs/pull/N/merge) can never cancel the trunk.
    expect(testWorkflow).toContain('group: tests-${{ github.ref }}');
    expect(testWorkflow).toContain('cancel-in-progress: true');

    const report = testWorkflow.slice(testWorkflow.indexOf('\n  trunk-report:'));
    expect(report).toContain('needs: lane');
    // A lane that hits `timeout-minutes` concludes `cancelled`, not `failure`,
    // so `failure()` would miss it. `cancelled()` covers the superseded run.
    expect(report).toContain(
      "if: github.event_name == 'push' && !cancelled() && needs.lane.result != 'success'",
    );
    expect(report).not.toMatch(/^\s+if:.*failure\(\)/m);
    // Top level is `contents: read`; the commit comment 403s without this.
    expect(report).toContain('contents: write');

    // A red trunk has to reach its author, or nobody learns main is broken.
    expect(testWorkflow).toContain('repos/$REPO/commits/$SHA/comments');
    expect(testWorkflow).toContain('::error::main is red at $SHA');
  });

  test('does not repeat local tests after staging merge or on the production PR', () => {
    expect(existsSync(resolve(root, '.github/workflows/qa-pr.yml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/qa-staging.yml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/qa-release.yml'))).toBe(false);

    const release = readFileSync(resolve(root, '.github/workflows/tests-release.yml'), 'utf8');
    expect(release).not.toContain('uses: ./.github/workflows/tests.yml');
    expect(release).not.toContain('mode: full');
  });

  test('has one local-suite workflow and two intentional deployed targets', () => {
    const workflowRoot = resolve(root, '.github/workflows');
    const workflows = readdirSync(workflowRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({ name, source: readFileSync(resolve(workflowRoot, name), 'utf8') }));

    // `tests.yml` owns its own triggers since 2026-09-18. The two caller
    // workflows are deleted; a new caller would run the suite somewhere
    // nobody decided on.
    expect(existsSync(resolve(workflowRoot, 'tests-pr.yml'))).toBe(false);
    expect(existsSync(resolve(workflowRoot, 'tests-main.yml'))).toBe(false);
    expect(
      workflows
        .filter(({ source }) => source.includes('uses: ./.github/workflows/tests.yml'))
        .map(({ name }) => name),
    ).toEqual([]);
    // deploy-preview drives ONE sandbox origin from one job, so it keeps the
    // combined `--target-full` command. The release gate splits the same two
    // lanes across parallel GitHub jobs, so it calls the per-lane commands.
    const targetFullCallers = workflows.filter(({ source }) =>
      source.includes('pnpm test -- --target-full'),
    );
    expect(targetFullCallers.map(({ name }) => name).sort()).toEqual(['deploy-preview.yml']);

    const shardedTargetCallers = workflows.filter(
      ({ source }) =>
        source.includes('pnpm test -- --target-api-full') &&
        source.includes('pnpm test -- --target-browser-full'),
    );
    expect(shardedTargetCallers.map(({ name }) => name).sort()).toEqual(['tests-release.yml']);
  });
});
