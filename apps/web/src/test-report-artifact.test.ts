import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/tests.yml'), 'utf8');
const release = readFileSync(join(repoRoot, '.github/workflows/tests-release.yml'), 'utf8');
const playwrightConfig = readFileSync(join(repoRoot, 'tests/playwright.config.ts'), 'utf8');

describe('frontend browser report artifact contract', () => {
  test('runs browser journeys only in the release suite, through the canonical root test command', () => {
    // Testing reset, 2026-10-16: no browser lane in tests.yml; the release
    // suite runs the journeys against deployed staging.
    expect(workflow).not.toContain('--browser-only');
    expect(release).toContain('pnpm test -- --target-browser-full --browser-shard=${{ matrix.shard }}/4');
    expect(workflow).toContain('pnpm test -- $TEST_ARGS');
  });

  test('uploads every generated JSON and HTML report for inspection', () => {
    expect(playwrightConfig).toContain("outputFolder: './test-results/html'");
    expect(playwrightConfig).toContain("outputDir: './test-results/artifacts'");
    expect(workflow).toContain('actions/upload-artifact@v7');
    // Multi-line `path: |` since the bypass-state exclusion landed in tests.yml.
    expect(workflow).toMatch(/path: \|\s*\n\s*tests\/test-results\/\*\*/);
    expect(workflow).toContain('!tests/test-results/deployment-bypass-state.json');
    expect(workflow).toContain('if: always()');
  });
});
