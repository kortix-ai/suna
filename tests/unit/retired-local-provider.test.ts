import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const retiredProviderIds = [['local', 'docker'].join('-'), ['local', 'docker'].join('_')];
const scannedExtensions = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const excludedPrefixes = [
  'packages/db/drizzle/meta/',
  'packages/db/migrations/',
  // Generated black-box reports contain captured API response history. They
  // are evidence, not a shipped source or documentation surface.
  'tests/test-results/',
];
const excludedFiles = new Set([
  // Historical decision record. It documents why the provider was removed and
  // why smolVM is not its replacement on ordinary VPS hosts.
  'docs/adr/006-local-sandbox-runtime.md',
  // Migration acceptance coverage must construct the retired value to prove
  // that an upgrade fails closed instead of relabelling historical rows.
  'packages/db/scripts/local-docker-provider-removal.integration.test.ts',
  // The checksum-guarded runtime override removes historical retired-provider
  // rows without modifying the immutable migration file.
  'packages/db/scripts/migration-runtime-overrides.ts',
  'packages/db/scripts/migration-runtime-overrides.test.ts',
  'packages/sdk/PROGRESS.md',
  'tests/unit/retired-local-provider.test.ts',
]);

function sourceFiles(): Array<{ absolute: string; path: string }> {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => scannedExtensions.has(extname(path)))
    .map((path) => ({ absolute: resolve(root, path), path }));
}

describe('retired local sandbox provider', () => {
  it('has no live code, test, CLI, SDK, web, or documentation surface', () => {
    const offenders = sourceFiles()
      .filter(({ absolute }) => existsSync(absolute))
      .filter(({ path }) => !excludedFiles.has(path))
      .filter(({ path }) => !excludedPrefixes.some((prefix) => path.startsWith(prefix)))
      .flatMap(({ absolute, path }) => {
        const source = readFileSync(absolute, 'utf8');
        return retiredProviderIds
          .filter((provider) => source.includes(provider))
          .map((provider) => `${path}: contains retired provider ${provider}`);
      });

    expect(offenders).toEqual([]);
  });
});
