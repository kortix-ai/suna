import { describe, expect, test } from 'bun:test';

import { hasFileExtension } from './path-utils';

describe('hasFileExtension', () => {
  test('detects real extensions on regular files', () => {
    expect(hasFileExtension('/workspace/src/index.ts')).toBe(true);
    expect(hasFileExtension('README.md')).toBe(true);
    expect(hasFileExtension('/a/b/archive.tar.gz')).toBe(true);
    expect(hasFileExtension('.eslintrc.json')).toBe(true);
  });

  test('treats dot-directories as having no extension (the .opencode bug)', () => {
    expect(hasFileExtension('/workspace/.opencode')).toBe(false);
    expect(hasFileExtension('.github')).toBe(false);
    expect(hasFileExtension('/repo/.kortix')).toBe(false);
  });

  test('treats extensionless dotfiles as having no extension', () => {
    expect(hasFileExtension('.env')).toBe(false);
    expect(hasFileExtension('/home/user/.gitignore')).toBe(false);
  });

  test('treats plain extensionless names as having no extension', () => {
    expect(hasFileExtension('/workspace/src')).toBe(false);
    expect(hasFileExtension('Makefile')).toBe(false);
    expect(hasFileExtension('')).toBe(false);
  });
});
