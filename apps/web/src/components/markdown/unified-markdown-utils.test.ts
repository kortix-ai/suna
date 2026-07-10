import { describe, expect, test } from 'bun:test';

import {
  isInternalUrl,
  languageLabel,
  looksLikeFilePath,
  looksLikeUrl,
  normalizeLanguage,
} from './unified-markdown-utils';

describe('isInternalUrl', () => {
  test('root-relative and hash links are internal', () => {
    expect(isInternalUrl('/dashboard')).toBe(true);
    expect(isInternalUrl('#section')).toBe(true);
  });

  test('http(s), mailto and other protocols are external', () => {
    expect(isInternalUrl('https://kortix.ai')).toBe(false);
    expect(isInternalUrl('http://localhost:3000')).toBe(false);
    expect(isInternalUrl('mailto:hi@kortix.ai')).toBe(false);
    expect(isInternalUrl('ftp://host/file')).toBe(false);
  });

  test('empty, undefined, or bare relative text is not internal', () => {
    expect(isInternalUrl(undefined)).toBe(false);
    expect(isInternalUrl('')).toBe(false);
    expect(isInternalUrl('relative/path')).toBe(false);
  });
});

describe('normalizeLanguage', () => {
  test('maps aliases case-insensitively', () => {
    expect(normalizeLanguage('JS')).toBe('javascript');
    expect(normalizeLanguage('ts')).toBe('typescript');
    expect(normalizeLanguage('PY')).toBe('python');
    expect(normalizeLanguage('yml')).toBe('yaml');
    expect(normalizeLanguage('sh')).toBe('bash');
    expect(normalizeLanguage('zsh')).toBe('bash');
  });

  test('passes unknown languages through, lowercased', () => {
    expect(normalizeLanguage('Rust')).toBe('rust');
    expect(normalizeLanguage('go')).toBe('go');
  });
});

describe('languageLabel', () => {
  test('empty hint falls back to text', () => {
    expect(languageLabel('')).toBe('text');
  });

  test('expands short aliases and lowercases the rest', () => {
    expect(languageLabel('js')).toBe('javascript');
    expect(languageLabel('TS')).toBe('typescript');
    expect(languageLabel('rust')).toBe('rust');
  });
});

describe('looksLikeUrl', () => {
  test('detects protocol urls', () => {
    expect(looksLikeUrl('https://kortix.ai/x')).toBe(true);
    expect(looksLikeUrl('http://localhost:3000')).toBe(true);
  });

  test('rejects paths and prose', () => {
    expect(looksLikeUrl('/etc/hosts')).toBe(false);
    expect(looksLikeUrl('just text')).toBe(false);
  });
});

describe('looksLikeFilePath', () => {
  test('a slashed path with an extension is a file path', () => {
    expect(looksLikeFilePath('/etc/hosts.conf')).toBe(true);
    expect(looksLikeFilePath('src/index.ts')).toBe(true);
  });

  test('rejects urls, too-short, no-slash, spaced, and common abbreviations', () => {
    expect(looksLikeFilePath('https://kortix.ai/a.js')).toBe(false);
    expect(looksLikeFilePath('ab')).toBe(false);
    expect(looksLikeFilePath('e.g.')).toBe(false);
    expect(looksLikeFilePath('nofile.txt')).toBe(false);
    expect(looksLikeFilePath('has space/file.ts')).toBe(false);
  });
});
