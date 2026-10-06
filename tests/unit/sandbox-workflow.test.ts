import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/tests.yml'), 'utf8');

// One `lane` job step, from its `- name:` to the next step at the same indent.
// Asserting on the whole file cannot tell `if: always()` on the Supabase stop
// from the same line on the artifact upload.
const laneStep = (name: string): string => {
  const start = testWorkflow.indexOf(`      - name: ${name}\n`);
  expect(start, `step "${name}" is missing`).toBeGreaterThan(-1);
  const rest = testWorkflow.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
};

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

  test('gives the browser lanes Chromium and a prestarted Supabase', () => {
    expect(testWorkflow).toContain('pnpm --dir tests exec playwright install --with-deps chromium');
    expect(testWorkflow).toContain('pnpm exec supabase start --ignore-health-check');
  });

  test('stops Supabase on every lane and frees its ports before one starts', () => {
    // The stop used to be `if: always() && matrix.mode == 'browser'`. The core
    // and packages lanes start Supabase too (through `pnpm test`), so a lane
    // that ended without stopping it stranded 54321-54324 on the reused
    // Blacksmith runner and the next `supabase start` died with
    // `address already in use` — four runs on 2026-09-21.
    const stop = laneStep('Stop the local Supabase stack');
    expect(stop).toContain('pnpm exec supabase stop --no-backup || true');
    expect(stop).toContain('if: always()');
    expect(stop).not.toContain("matrix.mode == 'browser'");

    // `supabase stop` only reaches containers of the SAME project name, so a
    // stack left by another checkout has to be removed by published port.
    const free = laneStep('Free the local Supabase ports');
    expect(free).toContain('docker ps -aq --filter "publish=$port"');
    expect(free).toContain('54321 54322 54323 54324');
    expect(free).not.toContain('if:');

    // Removing the container is not the same as getting the port back, so the
    // sweep also WAITS — by attempting a real bind.
    //
    // It used to wait on `ss -ltnH`, which lists LISTENING sockets only and so
    // reports a port free while `bind()` still returns EADDRINUSE. Measured on
    // browser-2: `supabase stop` returned at 09:19:26.710, the loop cleared all
    // four ports by 09:19:27.448 — 0.74s, first poll — and `supabase start`
    // still failed to bind 54324 twenty-five seconds later. A bind cannot
    // disagree with Docker, because it is what Docker does.
    expect(free).toContain('SO_REUSEADDR');
    expect(free).toContain("s.bind(('0.0.0.0',int(sys.argv[1])))");
    // A ONE-LINER on purpose: multi-line python inside this block scalar sits
    // at column 0, which ends the scalar and makes the whole workflow fail to
    // parse — a run with zero jobs, and a pull request that reads CLEAN with no
    // lane checks at all. That is how this shipped broken the first time.
    expect(free).toContain('bindable() {');
    expect(free).not.toMatch(/^import socket/m);
    expect(free).not.toMatch(/ss -ltnH[^\n]*\|\s*grep -q/);
    expect(free).toMatch(/::warning::port \$port still refuses a bind/);
    // The diagnostic still names the holder, and now reads ALL socket states —
    // the listening-only view is what hid this for two rounds of fixes.
    expect(free).toContain('ss -ltnp "sport = :$port"');
    expect(free).toContain('ss -tanH "sport = :$port"');
    expect(free).toContain('docker ps -a --filter "publish=$port"');
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
    // turns into `x-vercel-protection-bypass`. Restored in #6415. The
    // credentials come from AWS Secrets Manager (.github/actions/aws-env), so
    // every staging-facing job must read them itself.
    for (const job of ['  sweep-before:', '  api:', '  browser:', '  sweep-after:']) {
      const start = release.indexOf(`\n${job}\n`);
      expect(start, `${job.trim()} job`).toBeGreaterThan(-1);
      const next = release.slice(start + job.length + 2).search(/\n {2}[a-z0-9-]+:\n/);
      const block = release.slice(start, next === -1 ? undefined : start + job.length + 2 + next);
      expect(block).toContain('uses: ./.aws-env/.github/actions/aws-env');
      expect(block).toContain('id-token: write');
      expect(block).toMatch(/^ {12}VERCEL_AUTOMATION_BYPASS_SECRET$/m);
      expect(block).toContain('WEB_PROTECTION_PASSWORD=kortix-staging-web-env:WEB_PROTECTION_PASSWORD');
    }
    expect(release).toContain('https://staging-api.kortix.com/v1');
    expect(release).toContain('https://staging.kortix.com');
  });

  test('runs the local suite on a schedule, on a release pull request, or when a person adds `test`', () => {
    // 2026-09-28. Labels ran the suite on nearly every pull request into
    // `main`: every agent PR carried `preview`, and each push re-ran six lanes.
    // Into `main`, only the act of adding `test` runs it, once; a push does not.
    expect(testWorkflow).toContain('branches: [dev, staging]');
    expect(testWorkflow).toContain('types: [opened, reopened, synchronize, ready_for_review, labeled]');
    expect(testWorkflow).not.toContain('labels.*.name');
    expect(testWorkflow).not.toContain("'preview'");
    const laneJob = testWorkflow.slice(
      testWorkflow.indexOf('\n  lane:'),
      testWorkflow.indexOf('\n  trunk-report:'),
    );
    expect(laneJob).toContain("github.event_name != 'pull_request'");
    expect(laneJob).toContain("|| (github.base_ref == 'staging' && github.event.action != 'labeled')");
    expect(laneJob).toContain("|| (github.event.action == 'labeled' && github.event.label.name == 'test')");
    // A later push must not cancel the run a person asked for.
    expect(testWorkflow).toContain(
      "group: tests-${{ github.ref }}${{ github.event.action == 'labeled' && '-label' || '' }}",
    );
    expect(laneJob).toContain('fail-fast: false');
    // `trunk-report` finds failed lanes by `endswith("lane")` on this name.
    expect(laneJob).toContain('name: ${{ matrix.lane }} lane');

    // One file, one gate. The reusable-workflow plumbing and its `decide` job
    // are gone; a second dispatch path is how the gate drifts.
    expect(testWorkflow).not.toContain('workflow_call');
    expect(testWorkflow).not.toContain('inputs.mode');
    expect(testWorkflow).not.toMatch(/^  decide:/m);
  });

  test('no workflow runs a job on a pull request into main by itself', () => {
    // A pull request into `main` is mergeable the moment it opens. CI runs on
    // pull requests into `staging` and `prod`, and after the merge on `main`.
    // Two workflows listen to pull requests into `main`, and each runs a job
    // only when a person adds its label: tests.yml (`test`) and
    // deploy-preview.yml (`preview`). Both gates are pinned above.
    const labelGated = new Set(['tests.yml', 'deploy-preview.yml']);
    const dir = resolve(root, '.github/workflows');
    const offenders = readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file) && !labelGated.has(file))
      .filter((file) => {
        // Walk the top-level `on:` block line by line: a pull request trigger
        // is an offender unless its `branches:` list exists and omits `main`.
        const lines = readFileSync(resolve(dir, file), 'utf8').split('\n');
        const on = lines.indexOf('on:');
        if (on < 0) return false;
        const end = lines.findIndex((line, i) => i > on && /^\S/.test(line));
        const block = lines.slice(on + 1, end < 0 ? undefined : end);
        return block.some((line, i) => {
          if (!/^  pull_request(_target)?:/.test(line)) return false;
          const next = block.slice(i + 1).findIndex((l) => /^  \S/.test(l));
          const body = block.slice(i + 1, next < 0 ? undefined : i + 1 + next);
          const branches = body.find((l) => /^    branches:/.test(l));
          return !branches || /\bdev\b/.test(branches);
        });
      });
    expect(offenders).toEqual([]);
  });

  test('a push to main runs no suite: the trunk is tested on a daily schedule and cannot block anything', () => {
    // 2026-10-03 (Actions minutes). The per-merge gate is the local attestation
    // and the pre-push hook. A scheduled run on `main` HEAD is the safety net.
    const on = testWorkflow.slice(testWorkflow.indexOf('\non:'), testWorkflow.indexOf('\nconcurrency:'));
    expect(on).not.toMatch(/^ {2}push:/m);
    expect(on).toMatch(/^ {2}schedule:\n(?: {4}#.*\n)* {4}- cron: '/m);
    expect(on).toContain('workflow_dispatch:');
    // The suite parses markdown (tests/spec/end-to-end.md feeds route coverage).
    expect(testWorkflow).not.toMatch(/^\s+paths-ignore:/m);

    // Per-ref group: a PR run (refs/pull/N/merge) can never cancel the trunk.
    expect(testWorkflow).toContain('group: tests-${{ github.ref }}');
    // A PR cancels its superseded run; a scheduled run queues.
    expect(testWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    const report = testWorkflow.slice(testWorkflow.indexOf('\n  trunk-report:'));
    expect(report).toContain('needs: lane');
    // A lane that hits `timeout-minutes` concludes `cancelled`, not `failure`,
    // so `failure()` would miss it. `cancelled()` covers a replaced queued run.
    expect(report).toContain(
      "if: github.event_name == 'schedule' && !cancelled() && needs.lane.result != 'success'",
    );
    expect(report).not.toMatch(/^\s+if:.*failure\(\)/m);
    // Top level is `contents: read`; the commit comment 403s without this.
    expect(report).toContain('contents: write');

    // A red trunk has to reach someone, or nobody learns main is broken.
    expect(testWorkflow).toContain('repos/$REPO/commits/$SHA/comments');
    expect(testWorkflow).toContain('::error::main is red at $SHA');
  });

  test('a push to main triggers only the cheap guards and path-gated infra applies', () => {
    // 2026-10-03 (Actions minutes). Dev deploy, Tests, CI, CodeQL, Drata and the
    // desktop build are dispatch, schedule, or release-branch only.
    const dir = resolve(root, '.github/workflows');
    const pushesToMain = (file: string): boolean => {
      const lines = readFileSync(resolve(dir, file), 'utf8').split('\n');
      const on = lines.indexOf('on:');
      if (on < 0) return false;
      const end = lines.findIndex((line, i) => i > on && /^\S/.test(line));
      const block = lines.slice(on + 1, end < 0 ? undefined : end);
      const push = block.findIndex((line) => /^ {2}push:/.test(line));
      if (push < 0) return false;
      const next = block.slice(push + 1).findIndex((l) => /^ {2}\S/.test(l));
      const body = block.slice(push + 1, next < 0 ? undefined : push + 1 + next);
      const branches = body.find((l) => /^ {4}branches:/.test(l));
      return !branches || /\bdev\b/.test(branches);
    };
    const onMain = readdirSync(dir)
      .filter((file) => /\.ya?ml$/.test(file) && pushesToMain(file))
      .sort();
    expect(onMain).toEqual([
      'db-migrations.yml', // path-gated: packages/db/**
      'deploy-api-router-dev.yml', // path-gated: the router worker
      'i18n-catalogs.yml', // path-gated: translations
      'secret-scan.yml', // ~15 s
      'secrets-guard.yml', // ~15 s
      'terraform-apply-global.yml', // path-gated: infra/terraform roots
    ]);
    // Release branches keep their gates.
    for (const file of ['ci.yml', 'tests.yml', 'secret-scan.yml', 'secrets-guard.yml', 'codeql.yml']) {
      expect(readFileSync(resolve(dir, file), 'utf8'), file).toMatch(/pull_request:[\s\S]*?branches: \[(?:dev, )?staging/);
    }
    const deployDev = readFileSync(resolve(dir, 'deploy-dev.yml'), 'utf8');
    expect(deployDev).toContain('workflow_dispatch:');
    expect(deployDev).toMatch(/^ {6}surface:\n(?:.*\n)*? {8}default: changed/m);
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

/**
 * The preview comment and its deployment status must not claim a test run that
 * did not happen.
 *
 * A labelled preview is a persistent branch environment, and a redeploy from a
 * push deliberately SKIPS the suite (`PREVIEW_RUN_TESTS`). Both surfaces branched
 * on the deploy's outcome alone, so every such redeploy published "Preview
 * environment - live and tested" and "`pnpm test -- --target-full` passed" —
 * the most reassuring sentence on the pull request, over a deploy that ran
 * nothing. Observed on #7506, whose last deploy carried `PREVIEW_RUN_TESTS: 0`.
 */
describe('the preview status tells the truth about the suite', () => {
  const previewWorkflow = readFileSync(
    resolve(root, '.github/workflows/deploy-preview.yml'),
    'utf8',
  );
  const deployScript = readFileSync(resolve(root, 'tests/bin/sandbox-preview.ts'), 'utf8');

  test('the deploy reports whether this run tests, from the value it decided with', () => {
    // One authority. Re-deriving `PREVIEW_RUN_TESTS === '1'` in YAML would be a
    // second copy of a rule that is really `... || !branchEnv`.
    expect(deployScript).toContain("const runTests = process.env.PREVIEW_RUN_TESTS?.trim() === '1' || !branchEnv;");
    expect(deployScript).toContain("await writeOutput('suite', runTests ? '1' : '0');");
    expect(previewWorkflow).toContain(
      "if: steps.preview.outcome == 'success' && steps.preview.outputs.suite == '1'",
    );
  });

  test('only the suite links a report — the persistent box still holds the last one', () => {
    const suiteAction = deployScript.slice(deployScript.indexOf("} else if (action === 'suite') {"));
    expect(suiteAction.slice(0, 1800)).toMatch(/await writeOutput\(\s*'report_url'/);
    // A refused suite (it no longer serves the commit) links no report.
    expect(suiteAction.slice(0, 1800)).toContain('exitCode !== PREVIEW_SUITE_REFUSED');
    const deployAction = deployScript.slice(0, deployScript.indexOf("} else if (action === 'suite') {"));
    expect(deployAction).not.toContain('report_url');
  });

  test('the origin is published before the suite starts, and "tested" comes only from the suite step', () => {
    const at = (needle: string) => {
      const index = previewWorkflow.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const deploy = at('- name: Deploy the preview stack');
    const status = at('- name: Publish GitHub deployment result');
    const early = at('- name: Publish the preview on the pull request');
    const suite = at('- name: Run pnpm test -- --target-full against the preview');
    const final = at('- name: Update the preview comment with the suite result');
    expect(deploy).toBeLessThan(status);
    expect(status).toBeLessThan(suite);
    expect(early).toBeLessThan(suite);
    expect(suite).toBeLessThan(final);
    // The early comment never carries a suite outcome; the final one reads the
    // suite step's own outcome.
    expect(previewWorkflow.slice(early, suite)).toContain('SUITE_OUTCOME: ""');
    // A suite a newer commit superseded reports that, not a failure.
    expect(previewWorkflow.slice(final)).toContain(
      "SUITE_OUTCOME: ${{ steps.suite.outputs.superseded == '1' && 'superseded' || steps.suite.outcome || 'cancelled' }}",
    );
    expect(previewWorkflow.match(/bash scripts\/ci\/preview-sticky-comment\.sh/g)).toHaveLength(2);
    // The deployment status describes the deploy, never the suite.
    expect(previewWorkflow.slice(status, early)).not.toMatch(/target-full|tested/i);
    // A failed suite still fails the job.
    expect(previewWorkflow).toContain(
      "if: steps.preview.outcome != 'success' || steps.suite.outcome == 'failure'",
    );
  });
});

/**
 * The `preview` label is one explicit request for a deploy (~7 min). It never
 * starts the 40-80 min deployed suite; only a dispatch does.
 *
 * 2026-09-28: every PR carried the label and every label ran `--target-full`.
 * Five ran at once, shared one preview GitHub App, hit its secondary rate
 * limit, and each ran ~80 min to red. A push never starts a run either.
 */
describe('the preview label is one fast deploy, and a superseded run never deploys', () => {
  const previewWorkflow = readFileSync(resolve(root, '.github/workflows/deploy-preview.yml'), 'utf8');
  const revalidate = previewWorkflow.slice(
    previewWorkflow.indexOf('- name: Revalidate exact preview approval'),
    previewWorkflow.indexOf('- uses: actions/download-artifact@v8'),
  );

  test('only an explicit act starts a run, and only a dispatch runs the suite', () => {
    expect(previewWorkflow).toContain(
      "PREVIEW_RUN_TESTS: ${{ github.event_name == 'workflow_dispatch' && '1' || '0' }}",
    );
    expect(previewWorkflow).toContain('types: [labeled, unlabeled]');
    expect(previewWorkflow).not.toContain('synchronize');
  });

  test('a moved head, a removed label, or a deleted branch cancels the run instead of deploying', () => {
    expect(revalidate).toContain('supersede "approved ${COMMIT}; head is now ${current}."');
    expect(revalidate).toContain('supersede "the preview label was removed."');
    expect(revalidate).toContain('git/ref/heads/${BRANCH}');
    expect(revalidate).toContain('gh run cancel "$GITHUB_RUN_ID"');
    // Superseded is not a failure of this commit: no red check. (A lost write
    // permission still is.)
    expect(revalidate).not.toContain('is stale');
    expect(revalidate).not.toContain('label was removed before deployment');
    expect(previewWorkflow).toContain('BRANCH: ${{ needs.authorize.outputs.head_branch }}');
    expect(previewWorkflow).toMatch(/deployments: write\n\s+# A superseded run cancels itself[^\n]*\n\s+actions: write/);
  });

  test('a cancelled run neither comments nor re-points a stable hostname', () => {
    const comment = previewWorkflow.slice(previewWorkflow.indexOf('- name: Publish the preview on the pull request'));
    expect(comment.split('\n')[1]).toContain('if: ${{ !cancelled() }}');
    expect(previewWorkflow).not.toContain("if: always() && needs.authorize.outputs.public_worker != ''");
  });
});
