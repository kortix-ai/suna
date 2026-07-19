import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { providerLabel, repositoryWebUrl } from './git-view-helpers';

test('formats the live Code Storage provider identifier', () => {
  expect(providerLabel('code-storage')).toBe('Kortix Code Storage');
  expect(providerLabel('code_storage')).toBe('Kortix Code Storage');
});

test('only links repository providers with a human web page', () => {
  expect(repositoryWebUrl('github', 'https://github.com/acme/project.git')).toBe(
    'https://github.com/acme/project',
  );
  expect(repositoryWebUrl('code-storage', 'https://kortix.code.storage/project.git')).toBeNull();
});

test('copy control keeps both icons in an animated fixed-size box', () => {
  const source = readFileSync(join(import.meta.dir, 'git-view.tsx'), 'utf8');
  expect(source).toContain('<AnimatePresence initial={false}');
  expect(source).toContain("filter: 'blur(4px)'");
  expect(source).toContain('duration: 0.3, bounce: 0');
});

test('develop locally includes the environment-aware CLI installer before clone', () => {
  const source = readFileSync(join(import.meta.dir, 'git-view.tsx'), 'utf8');
  expect(source).toContain('getKortixCliInstallCommand(getEnv().VERSION)');
  expect(source).toContain('label="Install command"');
  expect(source.indexOf('label="Install command"')).toBeLessThan(
    source.indexOf('label="Clone command"'),
  );
});
