import { describe, expect, test } from 'bun:test';

import {
  isInternalUrl,
  isLinkSafeHref,
  languageLabel,
  looksLikeFilePath,
  looksLikeUrl,
  normalizeLanguage,
  shikiWasmAvailable,
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

  test('shiki defaultLanguage "plaintext" collapses to text', () => {
    expect(languageLabel('plaintext')).toBe('text');
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

  // Regression: `http://:` (an empty host/port template like
  // `http://${HOST}:${PORT}` that leaked unsubstituted from content) matches
  // the `://\S+` shape, so looksLikeUrl happily returns true. The guard that
  // keeps it out of next/link lives in isLinkSafeHref below.
  test('matches the malformed http://: shape (guarded downstream)', () => {
    expect(looksLikeUrl('http://:')).toBe(true);
  });
});

describe('isLinkSafeHref', () => {
  test('rejects malformed absolute URLs that crash next/link prefetch', () => {
    // The exact production signature: `Cannot prefetch 'http://:' because it
    // cannot be converted to a URL.` — `new URL('http://:')` throws.
    expect(isLinkSafeHref('http://:')).toBe(false);
    expect(isLinkSafeHref('https://:')).toBe(false);
    expect(isLinkSafeHref('http://')).toBe(false);
    // An unsubstituted `http://${HOST}:${PORT}` template rendered with an
    // empty host collapses to this shape.
    expect(isLinkSafeHref('http://:8080')).toBe(false);
  });

  test('accepts valid absolute URLs (external is fine — prefetch short-circuits)', () => {
    expect(isLinkSafeHref('https://kortix.ai/x')).toBe(true);
    expect(isLinkSafeHref('http://localhost:3000')).toBe(true);
    // `mailto:` has no `//` and `new URL('mailto:...')` parses fine, so it is
    // safe to hand to next/link (no prefetch throw).
    expect(isLinkSafeHref('mailto:hi@kortix.ai')).toBe(true);
  });

  test('accepts internal hrefs that next/link always handles', () => {
    expect(isLinkSafeHref('/dashboard')).toBe(true);
    expect(isLinkSafeHref('#section')).toBe(true);
    expect(isLinkSafeHref('?q=1')).toBe(true);
    expect(isLinkSafeHref('relative/path')).toBe(true);
  });

  test('rejects empty / undefined', () => {
    expect(isLinkSafeHref('')).toBe(false);
    expect(isLinkSafeHref(undefined)).toBe(false);
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

// Regression for Better Stack 1604d50a (`WebAssembly is not defined`,
// `Can't find variable: WebAssembly`): the Shiki highlighter singleton must not
// be eagerly started when WebAssembly is unavailable, or its rejection fires
// `onunhandledrejection` → Sentry on every page load for visitors whose browser
// blocks/disables WebAssembly (privacy browsers, hardened WebViews, spoofed-UA
// bots). The renderer gates the eager init on this guard.
describe('shikiWasmAvailable', () => {
  test('returns true in the normal test environment (WebAssembly present)', () => {
    // bun's test runtime exposes WebAssembly, matching every modern browser.
    expect(shikiWasmAvailable()).toBe(true);
  });

  test('returns false when WebAssembly is undefined (the BS 1604d50a context)', () => {
    const original = (globalThis as { WebAssembly?: unknown }).WebAssembly;
    try {
      // Simulate a browser/context that blocks or disables WebAssembly.
      // `delete` mirrors how such runtimes expose no WebAssembly global at all.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).WebAssembly;
      expect(shikiWasmAvailable()).toBe(false);
    } finally {
      // Restore — other tests (and the live Shiki init) need WebAssembly.
      (globalThis as { WebAssembly?: unknown }).WebAssembly = original;
    }
  });
});
