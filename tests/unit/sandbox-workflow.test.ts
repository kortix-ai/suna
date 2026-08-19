import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/tests.yml'), 'utf8');

describe('sandbox test workflow', () => {
  test('runs four root workers at the pull request head SHA', () => {
    expect(testWorkflow).toContain(
      'SANDBOX_TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    );
    expect(testWorkflow).toContain('- lane: core');
    expect(testWorkflow).toContain('- lane: browser-1');
    expect(testWorkflow).toContain('- lane: browser-2');
    expect(testWorkflow).toContain('- lane: packages');
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci.ts ;;');
    expect(testWorkflow).toContain(
      'bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=1/2',
    );
    expect(testWorkflow).toContain(
      'bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=2/2',
    );
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci.ts --packages-only');
    expect(testWorkflow).toContain('export KORTIX_PACKAGE_SKIP_SDK_TESTS=1');
    expect(testWorkflow).toContain('timeout-minutes: 90');
    expect(testWorkflow).toContain('SANDBOX_TEST_RUN_ID: ${{ github.run_id }}-${{ matrix.lane }}');
  });

  test('has one provider-neutral executable surface', () => {
    expect(existsSync(resolve(root, 'tests/bin/sandbox-ci.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'tests/bin/sandbox-ci-cleanup.ts'))).toBe(true);
    expect(existsSync(resolve(root, 'tests/bin/platinum-ci.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/bin/platinum-ci-cleanup.ts'))).toBe(false);
  });

  test('supports explicit providers and automatic infrastructure failover', () => {
    expect(testWorkflow).toContain('default: auto');
    expect(testWorkflow).toContain('PLATINUM_API_KEY: ${{ secrets.PLATINUM_API_KEY }}');
    expect(testWorkflow).toContain('DAYTONA_API_KEY: ${{ secrets.DAYTONA_API_KEY }}');
    expect(testWorkflow).toContain('TEST_SANDBOX_PROVIDER: ${{ inputs.provider }}');
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci-cleanup.ts');

    const testsPr = readFileSync(resolve(root, '.github/workflows/tests-pr.yml'), 'utf8');
    expect(testsPr).toContain('type: choice');
    expect(testsPr).toContain('default: daytona');
    expect(testsPr).toContain("provider: ${{ inputs.provider || 'daytona' }}");
    expect(testsPr).toContain('- platinum');
    expect(testsPr).toContain('- daytona');
  });

  test('uploads results after the worker returns', () => {
    expect(testWorkflow).toContain('actions/upload-artifact@v7');
    expect(testWorkflow).toContain('path: tests/test-results/**');
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

    // The gate is sharded into parallel api/browser matrix jobs. Branch
    // protection on `prod` requires exactly one context — this job name — so an
    // aggregator job keeps it while the shards do the work. Renaming it breaks
    // the required check silently.
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
    // The load each shard offers staging is unchanged by the extra shards.
    expect(release).toContain("KE2E_API_WORKERS: '2'");
    expect(release).toContain("KE2E_SANDBOX_WORKERS: '1'");
    expect(release).toContain("KE2E_TIMEOUT_ATTEMPTS: '2'");
    // Dry run against staging without a release PR. `RELEASE_SOURCE_SHA` only
    // exists on a `release/*` branch, so without this input the gate could
    // never be rehearsed — which is how it stayed un-green. The input is read
    // through env, never interpolated into the shell, and both jobs still
    // enforce the same 40-hex-character check.
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
    // 15-minute JOB cap fired mid-delete, GitHub recorded the job as
    // `cancelled` (which continue-on-error does not absorb), and every
    // dependent shard was skipped. Two guards, both required: the gc STEP is
    // bounded (a step timeout is a job *failure*), and the shard jobs run
    // unless the whole workflow was cancelled.
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
    // Staging sits behind Vercel SSO deployment protection, which Basic-auth
    // httpCredentials cannot satisfy — every authenticated page 302s to
    // vercel.com/sso-api. The release job must therefore export the automation
    // bypass secret that playwright.config turns into
    // `x-vercel-protection-bypass`. It was missing when tests-release replaced
    // the old qa-release gate, so the browser lane never reached the app and
    // the "proves every browser journey" claim was hollow. Restored in #6415.
    expect(release).toContain(
      'VERCEL_AUTOMATION_BYPASS_SECRET: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
    );
    expect(release).toContain('https://staging-api.kortix.com/v1');
    expect(release).toContain('https://staging.kortix.com');
  });

  test('runs all local tests once before main or staging merges', () => {
    const testsPr = readFileSync(resolve(root, '.github/workflows/tests-pr.yml'), 'utf8');

    expect(testsPr).toContain('branches: [main, staging]');
    expect(testsPr).not.toContain('branches: [main, staging, prod]');
    expect(testsPr).toContain('uses: ./.github/workflows/tests.yml');
    expect(testsPr).toContain('mode: full');
    expect(testsPr).toContain('secrets: inherit');
  });

  test('does not repeat local tests after staging merge or on the production PR', () => {
    expect(existsSync(resolve(root, '.github/workflows/qa-pr.yml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/qa-staging.yml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/workflows/qa-release.yml'))).toBe(false);

    const release = readFileSync(resolve(root, '.github/workflows/tests-release.yml'), 'utf8');
    expect(release).not.toContain('uses: ./.github/workflows/tests.yml');
    expect(release).not.toContain('mode: full');
  });

  test('has one automatic local-suite caller and two intentional deployed targets', () => {
    const workflowRoot = resolve(root, '.github/workflows');
    const workflows = readdirSync(workflowRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => ({ name, source: readFileSync(resolve(workflowRoot, name), 'utf8') }));

    expect(
      workflows.filter(({ source }) =>
        source.includes('uses: ./.github/workflows/tests.yml'),
      ),
    ).toHaveLength(1);
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
