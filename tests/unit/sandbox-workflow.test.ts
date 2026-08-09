import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');

describe('sandbox test workflow', () => {
  test('runs three root lanes at the pull request head SHA', () => {
    expect(testWorkflow).toContain(
      'SANDBOX_TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    );
    expect(testWorkflow).toContain('lane: [core, browser, packages]');
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci.ts ;;');
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci.ts --browser-only');
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

    const qaPr = readFileSync(resolve(root, '.github/workflows/qa-pr.yml'), 'utf8');
    expect(qaPr).toContain('type: choice');
    expect(qaPr).toContain('default: daytona');
    expect(qaPr).toContain("provider: ${{ inputs.provider || 'daytona' }}");
    expect(qaPr).toContain('- platinum');
    expect(qaPr).toContain('- daytona');
  });

  test('uploads results after the worker returns', () => {
    expect(testWorkflow).toContain('actions/upload-artifact@v7');
    expect(testWorkflow).toContain('path: tests/test-results/**');
    expect(testWorkflow).toContain('if: always()');
  });

  test('release QA proves every deployed staging flow and browser journey', () => {
    const release = readFileSync(resolve(root, '.github/workflows/qa-release.yml'), 'utf8');

    expect(release).toContain('name: deployed staging API + browser');
    expect(release).toContain('pnpm test -- --target-full');
    expect(release).toContain('RELEASE_SOURCE_SHA');
    expect(release).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(release).toContain('https://staging-api.kortix.com/v1');
    expect(release).toContain('https://staging.kortix.com');
  });

  test.each(['qa-pr.yml', 'qa-staging.yml', 'qa-release.yml'])(
    '%s calls the shared workflow',
    (name) => {
      const workflow = readFileSync(resolve(root, '.github/workflows', name), 'utf8');
      expect(workflow).toContain('uses: ./.github/workflows/test.yml');
      expect(workflow).toContain('mode: full');
      expect(workflow).toContain('secrets: inherit');
    },
  );
});
