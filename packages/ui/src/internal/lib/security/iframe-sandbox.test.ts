import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const ALLOWED = new Set(['features/file-viewer/preview-policy.ts', 'lib/security/iframe-sandbox.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('iframe sandbox', () => {
  test('only framePolicy may pick the same-origin token set', () => {
    const offenders = walk(SRC)
      .map((p) => p.slice(SRC.length + 1))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('INTERACTIVE_PREVIEW_IFRAME_SANDBOX'));
    expect(offenders).toEqual([]);
  });
});
