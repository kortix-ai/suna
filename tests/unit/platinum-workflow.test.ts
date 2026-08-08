import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const testWorkflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');

describe('Platinum test workflow', () => {
  test('runs the one root command at the pull request head SHA', () => {
    expect(testWorkflow).toContain('PLATINUM_TEST_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(testWorkflow).toContain("bun tests/bin/platinum-ci.ts --full");
    expect(testWorkflow).toContain('timeout-minutes: 210');
  });

  test('uploads results after the worker returns', () => {
    expect(testWorkflow).toContain('actions/upload-artifact@v7');
    expect(testWorkflow).toContain('path: tests/test-results/**');
    expect(testWorkflow).toContain('if: always()');
  });

  test.each(['qa-pr.yml', 'qa-staging.yml', 'qa-release.yml'])('%s calls the shared workflow', (name) => {
    const workflow = readFileSync(resolve(root, '.github/workflows', name), 'utf8');
    expect(workflow).toContain('uses: ./.github/workflows/test.yml');
    expect(workflow).toContain('mode: full');
    expect(workflow).toContain('secrets: inherit');
  });
});
