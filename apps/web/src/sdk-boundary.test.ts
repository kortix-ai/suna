import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { scanSdkBoundary, violationKey } from '../scripts/sdk-boundary.mjs';

describe('apps/web SDK boundary', () => {
  test('production code adds no forbidden Kortix or runtime imports', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(import.meta.dir, 'sdk-boundary-baseline.json'), 'utf8'),
    ) as string[];
    const actual = scanSdkBoundary(resolve(import.meta.dir)).map(violationKey);
    expect(actual).toEqual(baseline);
  }, 30_000);
});

/** Scan one planted source file and return `kind source` per violation. */
function scanPlanted(name: string, code: string): string[] {
  const root = mkdtempSync(resolve(tmpdir(), 'kortix-web-sdk-boundary-'));
  try {
    writeFileSync(resolve(root, name), code);
    return scanSdkBoundary(root).map((violation) => `${violation.kind} ${violation.source}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('harness-neutral runtime rules (F2)', () => {
  test('a not-ready phrase spelled in the host is rejected: the SDK classifies it', () => {
    expect(scanPlanted('toast.ts', "export const quiet = (m: string) => /opencode not ready/i.test(m);\n")).toEqual([
      'runtime-not-ready-string /opencode not ready/i',
    ]);
    expect(scanPlanted('list.ts', "export const REFUSED = ['OpenCode not ready', 'forbidden'];\n")).toEqual([
      'runtime-not-ready-string OpenCode not ready',
    ]);
    expect(scanPlanted('tpl.ts', 'export const m = (r: string) => `opencode not ready: ${r}`;\n')).toEqual([
      'runtime-not-ready-string opencode not ready: ${}',
    ]);
  });

  test('a hand-written runtime query key is rejected: the SDK owns the cache keys', () => {
    expect(
      scanPlanted('restart.ts', "export const reset = (qc: any) => qc.removeQueries({ queryKey: ['opencode'] });\n"),
    ).toEqual(['runtime-query-key opencode']);
    expect(
      scanPlanted('seed.ts', "export const seed = (qc: any, id: string) => qc.setQueryData(['opencode', 'session-todo', id], []);\n"),
    ).toEqual(['runtime-query-key opencode']);
  });

  test('the SDK names and unrelated uses of the word pass', () => {
    expect(
      scanPlanted(
        'ok.ts',
        [
          "import { isRuntimeNotReadyResponse } from '@kortix/sdk';",
          "import { resetRuntimeQueries, runtimeKeys } from '@kortix/sdk/react';",
          "export const providers = ['opencode', 'anthropic'];",
          "export const label = 'OpenCode Zen';",
          'export const use = [isRuntimeNotReadyResponse, resetRuntimeQueries, runtimeKeys.all];',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
