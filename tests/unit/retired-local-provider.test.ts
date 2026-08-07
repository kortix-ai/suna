import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const retiredProviderIds = [
  ['local', 'docker'].join('-'),
  ['local', 'docker'].join('_'),
];
const scannedExtensions = new Set([
  '.cjs', '.js', '.json', '.md', '.mjs', '.sh', '.sql', '.ts', '.tsx', '.yaml', '.yml',
]);
const excludedPrefixes = [
  'packages/db/drizzle/meta/',
  'packages/db/migrations/',
];
const excludedFiles = new Set([
  // Historical decision record. It documents why the provider was removed and
  // why smolVM is not its replacement on ordinary VPS hosts.
  'docs/adr/006-local-sandbox-runtime.md',
  // Migration acceptance coverage must construct the retired value to prove
  // that an upgrade fails closed instead of relabelling historical rows.
  'packages/db/scripts/local-docker-provider-removal.integration.test.ts',
  'packages/sdk/PROGRESS.md',
  'tests/unit/retired-local-provider.test.ts',
]);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (scannedExtensions.has(extname(entry.name))) files.push(absolute);
  }
  return files;
}

describe('retired local sandbox provider', () => {
  it('has no live code, test, CLI, SDK, web, or documentation surface', () => {
    const offenders = sourceFiles(root)
      .map((absolute) => ({ absolute, path: relative(root, absolute) }))
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
