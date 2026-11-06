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

  test('@kortix/ui code (the session UI moved there) adds none either', () => {
    expect(scanSdkBoundary(resolve(import.meta.dir, '../../../packages/ui/src')).map(violationKey)).toEqual([]);
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
    expect(scanPlanted('toast.ts', "export const quiet = (m: string) => /sandbox runtime not ready/i.test(m);\n")).toEqual([
      'runtime-not-ready-string /sandbox runtime not ready/i',
    ]);
    expect(scanPlanted('list.ts', "export const REFUSED = ['runtime_not_ready', 'forbidden'];\n")).toEqual([
      'runtime-not-ready-string runtime_not_ready',
    ]);
    expect(scanPlanted('tpl.ts', 'export const m = (r: string) => `Sandbox runtime not ready: ${r}`;\n')).toEqual([
      'runtime-not-ready-string Sandbox runtime not ready: ${}',
    ]);
    // The API's park reason is a different word.
    expect(scanPlanted('park.ts', "export const reason = 'runtime_not_ready_timeout';\n")).toEqual([]);
  });

  test('a hand-written runtime query key is rejected: the SDK owns the cache keys', () => {
    expect(
      scanPlanted('restart.ts', "export const reset = (qc: any) => qc.removeQueries({ queryKey: ['runtime'] });\n"),
    ).toEqual(['runtime-query-key runtime']);
    expect(
      scanPlanted('seed.ts', "export const seed = (qc: any, id: string) => qc.setQueryData(['runtime', 'session-todo', id], []);\n"),
    ).toEqual(['runtime-query-key runtime']);
  });

  test('the SDK names and unrelated uses of the word pass', () => {
    expect(
      scanPlanted(
        'ok.ts',
        [
          "import { isRuntimeNotReadyResponse } from '@kortix/sdk';",
          "import { resetRuntimeQueries, runtimeKeys } from '@kortix/sdk/react';",
          "export const kinds = ['runtime', 'build'];",
          "export const providers = ['opencode', 'anthropic'];",
          "export const label = 'OpenCode Zen';",
          'export const use = [isRuntimeNotReadyResponse, resetRuntimeQueries, runtimeKeys.all];',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('raw fetches to the Kortix backend', () => {
  test('a fetch built from the backend URL is rejected, directly or through a const', () => {
    expect(
      scanPlanted('a.ts', 'export const f = (b: string) => fetch(`${b.replace(/\\/+$/, "")}/p/config`);\n'),
    ).toEqual([]);
    expect(scanPlanted('b.ts', 'export const f = (backendUrl: string) => fetch(`${backendUrl}/p/config`);\n')).toEqual([
      'host-kortix-network ${}/p/config',
    ]);
    expect(scanPlanted('c.ts', 'export const f = () => fetch(`${getEnv().BACKEND_URL}/anything`);\n')).toEqual([
      'host-kortix-network ${}/anything',
    ]);
    expect(
      scanPlanted('d.ts', 'export async function f(backendUrl: string) { const url = `${backendUrl}/x`; return fetch(url); }\n'),
    ).toEqual(['host-kortix-network ${}/x']);
  });

  test('same-origin and third-party fetches pass', () => {
    expect(scanPlanted('ok.ts', "export const f = () => fetch('/api/thing');\nexport const g = () => fetch(`${origin}/api/x`);\n")).toEqual([]);
  });
});
