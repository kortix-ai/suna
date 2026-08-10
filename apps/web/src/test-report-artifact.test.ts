import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/tests.yml'), 'utf8');
const playwrightConfig = readFileSync(join(repoRoot, 'tests/playwright.config.ts'), 'utf8');

describe('frontend browser report artifact contract', () => {
  test('runs browser journeys through the canonical root test worker', () => {
    expect(workflow).toContain('- lane: browser-1');
    expect(workflow).toContain('- lane: browser-2');
    expect(workflow).toContain(
      'bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=1/2',
    );
    expect(workflow).toContain(
      'bun tests/bin/sandbox-ci.ts --browser-only --browser-shard=2/2',
    );
  });

  test('uploads every generated JSON and HTML report for inspection', () => {
    expect(playwrightConfig).toContain("outputFolder: './test-results/html'");
    expect(playwrightConfig).toContain("outputDir: './test-results/artifacts'");
    expect(workflow).toContain('actions/upload-artifact@v7');
    expect(workflow).toContain('path: tests/test-results/**');
    expect(workflow).toContain('if: always()');
  });
});
