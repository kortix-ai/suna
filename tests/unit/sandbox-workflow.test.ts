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

    expect(release).toContain('name: full suite + quality gates');
    expect(release).toContain('pnpm test -- --target-full');
    expect(release).toContain('RELEASE_SOURCE_SHA');
    expect(release).toContain('WEB_PROTECTION_PASSWORD');
    expect(release).not.toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
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
    const targetFullCallers = workflows.filter(({ source }) =>
      source.includes('pnpm test -- --target-full'),
    );
    expect(targetFullCallers.map(({ name }) => name).sort()).toEqual([
      'deploy-preview.yml',
      'tests-release.yml',
    ]);
  });
});
