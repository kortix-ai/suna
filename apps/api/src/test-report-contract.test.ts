import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../../..');
const runner = readFileSync(join(repoRoot, 'tests/bin/ke2e.ts'), 'utf8');
const reporter = readFileSync(join(repoRoot, 'tests/src/core/report.ts'), 'utf8');

describe('backend flow report contract', () => {
  test('writes machine-readable results and the viewable HTML projection', () => {
    expect(runner).toContain("const jsonPath = resolve(outDir, 'results.json')");
    expect(runner).toContain("const htmlPath = resolve(outDir, 'report.html')");
    expect(runner).toContain('writeResults(result, jsonPath, htmlPath)');
  });

  test('keeps the HTML report self-contained for file and artifact viewing', () => {
    expect(reporter).toContain('no framework, no network');
    expect(reporter).toContain('opens from file://');
    expect(reporter).toContain('const data = JSON.stringify(result)');
  });
});
