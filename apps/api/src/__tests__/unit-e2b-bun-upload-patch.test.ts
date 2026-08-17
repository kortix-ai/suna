import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('E2B template uploads on Bun', () => {
  test('uses Bun.file without a runtime-inferred content type', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };
    const patchPath = packageJson.pnpm?.patchedDependencies?.['e2b@2.37.0'];

    expect(patchPath).toBe('patches/e2b@2.37.0.patch');

    const dockerfile = readRepoFile('apps/api/Dockerfile');
    expect(dockerfile).toContain('COPY patches ./patches');

    const patch = readRepoFile(patchPath as string);
    expect(patch.match(/globalThis\.Bun \? globalThis\.Bun\.file\(filePath\)/g)).toHaveLength(2);
    expect(patch.match(/"Content-Type": ""/g)).toHaveLength(2);
    expect(patch).toContain('Readable.toWeb');
  });
});
