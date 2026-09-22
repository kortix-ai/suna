import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');
const STARTER_CONFIG_PKG = resolve(
  REPO_ROOT,
  'packages/starter/templates/base/.kortix/opencode/package.json',
);

describe('opencode config dependencies', () => {
  test('uses the local tool ABI instead of the version-coupled plugin package', () => {
    const pkg = JSON.parse(readFileSync(STARTER_CONFIG_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['@opencode-ai/plugin']).toBeUndefined();
  });

  test('keeps the exact starter runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(STARTER_CONFIG_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies).toEqual({
      '@modelcontextprotocol/sdk': '^1.30.0',
      zod: '4.1.8',
    });
  });
});
