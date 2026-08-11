import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./hero-surfaces.tsx', import.meta.url),
  'utf8',
);
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('marketing hero Workspace vocabulary', () => {
  test('uses a code-native canonical CLI transcript instead of stale Project media', () => {
    expect(source).not.toContain('CLI_MEDIA');
    expect(source).not.toContain('/media/cli/');
    expect(code).not.toMatch(/\bProjects?\b/);
    expect(code).toContain('kortix workspaces use acme-ops');
    expect(code).toContain('Default workspace: acme-ops');
    expect(code).toContain('workspace acme-ops (default)');
  });
});
