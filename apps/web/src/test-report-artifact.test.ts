import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/tests.yml'), 'utf8');
const playwrightConfig = readFileSync(join(repoRoot, 'tests/playwright.config.ts'), 'utf8');

describe('frontend browser report artifact contract', () => {
  test('runs browser journeys through the canonical root test command', () => {
    expect(workflow).toContain('- lane: browser-1');
    expect(workflow).toContain('- lane: browser-2');
    expect(workflow).toContain('args: --browser-only --browser-shard=1/2');
    expect(workflow).toContain('args: --browser-only --browser-shard=2/2');
    expect(workflow).toContain('pnpm test -- $TEST_ARGS');
    expect(workflow).toContain('pnpm --dir tests exec playwright install --with-deps chromium');
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
