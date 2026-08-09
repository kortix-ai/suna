import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');

describe('sandbox test workflow', () => {
  test('runs the one root command at the pull request head SHA', () => {
    expect(testWorkflow).toContain(
      'SANDBOX_TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    );
    expect(testWorkflow).toContain('bun tests/bin/sandbox-ci.ts --full');
    expect(testWorkflow).toContain('timeout-minutes: 210');
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
    expect(qaPr).toContain("provider: ${{ inputs.provider || 'auto' }}");
    expect(qaPr).toContain('- platinum');
    expect(qaPr).toContain('- daytona');
  });

  test('uploads results after the worker returns', () => {
    expect(testWorkflow).toContain('actions/upload-artifact@v7');
    expect(testWorkflow).toContain('path: tests/test-results/**');
    expect(testWorkflow).toContain('if: always()');
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
