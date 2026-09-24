import { describe, expect, test } from 'bun:test';

import { isKnownLanguage } from './code/shiki-highlighter';
import {
  LANGUAGE_ALIASES,
  hasLinkReferenceDefinition,
  isInternalUrl,
  isLinkSafeHref,
  isStreamingLinkPlaceholder,
  languageLabel,
  looksLikeFilePath,
  looksLikeUrl,
  normalizeLanguage,
  shouldUseNextLink,
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

describe('hasLinkReferenceDefinition', () => {
  test('finds a reference-style link target anywhere in the text', () => {
    expect(hasLinkReferenceDefinition('See [the docs][1].\n\n[1]: https://kortix.com/docs')).toBe(
      true,
    );
    expect(hasLinkReferenceDefinition('[docs]: <https://kortix.com> "Docs"')).toBe(true);
    expect(hasLinkReferenceDefinition('   [x]: /relative/path')).toBe(true);
  });

  test('inline links, plain brackets, and indented code are not definitions', () => {
    expect(hasLinkReferenceDefinition('[docs](https://kortix.com/docs)')).toBe(false);
    expect(hasLinkReferenceDefinition('Array access: arr[0]: first element')).toBe(false);
    expect(hasLinkReferenceDefinition('    [1]: https://kortix.com')).toBe(false);
    expect(hasLinkReferenceDefinition('[1]:')).toBe(false);
  });
});

describe('isStreamingLinkPlaceholder', () => {
  test("recognises remend's stand-in for a URL that has not arrived", () => {
    expect(isStreamingLinkPlaceholder('streamdown:incomplete-link')).toBe(true);
    expect(isStreamingLinkPlaceholder('STREAMDOWN:incomplete-link')).toBe(true);
  });

  test('real destinations are not placeholders', () => {
    expect(isStreamingLinkPlaceholder(undefined)).toBe(false);
    expect(isStreamingLinkPlaceholder('')).toBe(false);
    expect(isStreamingLinkPlaceholder('https://kortix.com/streamdown:x')).toBe(false);
    expect(isStreamingLinkPlaceholder('#streamdown')).toBe(false);
    expect(isStreamingLinkPlaceholder('/connect/ksl_abc')).toBe(false);
  });
});

describe('shouldUseNextLink', () => {
  test('uses Next Link only for trusted app-router hrefs', () => {
    expect(shouldUseNextLink('/dashboard')).toBe(true);
    expect(shouldUseNextLink('#section')).toBe(true);
    expect(shouldUseNextLink('https://kortix.com/legal/terms.')).toBe(false);
    expect(shouldUseNextLink('http://localhost:3000/dashboard')).toBe(false);
    expect(shouldUseNextLink('mailto:hi@kortix.ai')).toBe(false);
    expect(shouldUseNextLink('relative/path')).toBe(false);
  });

  test('keeps malformed absolute hrefs out of Next Link', () => {
    expect(shouldUseNextLink('http://:')).toBe(false);
    expect(shouldUseNextLink('https://:')).toBe(false);
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

  test('every alias resolves to a grammar id Shiki can load', () => {
    const stranded = Object.entries(LANGUAGE_ALIASES)
      .filter(([, target]) => !isKnownLanguage(target))
      .map(([alias, target]) => `${alias} -> ${target}`);
    expect(stranded).toEqual([]);
  });

  test('resolves hints shiki has no grammar or alias for', () => {
    expect(normalizeLanguage('golang')).toBe('go');
    expect(normalizeLanguage('env')).toBe('dotenv');
    expect(normalizeLanguage('patch')).toBe('diff');
    expect(normalizeLanguage('svg')).toBe('xml');
    expect(normalizeLanguage('psql')).toBe('sql');
  });

  test('folds shiki aliases onto the preloaded id they stand for', () => {
    expect(normalizeLanguage('plaintext')).toBe('text');
    expect(normalizeLanguage('rs')).toBe('rust');
    expect(normalizeLanguage('kt')).toBe('kotlin');
    expect(normalizeLanguage('cs')).toBe('csharp');
    expect(normalizeLanguage('c++')).toBe('cpp');
    expect(normalizeLanguage('ps1')).toBe('powershell');
    expect(normalizeLanguage('docker')).toBe('dockerfile');
    expect(normalizeLanguage('make')).toBe('makefile');
    expect(normalizeLanguage('tf')).toBe('terraform');
    expect(normalizeLanguage('gql')).toBe('graphql');
    expect(normalizeLanguage('protobuf')).toBe('proto');
  });

  test('new aliases are case-insensitive like the original set', () => {
    expect(normalizeLanguage('Golang')).toBe('go');
    expect(normalizeLanguage('RS')).toBe('rust');
    expect(normalizeLanguage('C++')).toBe('cpp');
    expect(normalizeLanguage('PS1')).toBe('powershell');
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

  test('expands the newly aliased hints to the name a reader recognises', () => {
    expect(languageLabel('rs')).toBe('rust');
    expect(languageLabel('kt')).toBe('kotlin');
    expect(languageLabel('golang')).toBe('go');
    expect(languageLabel('ps1')).toBe('powershell');
    expect(languageLabel('gql')).toBe('graphql');
    expect(languageLabel('tf')).toBe('terraform');
    expect(languageLabel('env')).toBe('dotenv');
    expect(languageLabel('txt')).toBe('text');
  });

  test('keeps the spelling a reader typed when it is already the known name', () => {
    expect(languageLabel('c++')).toBe('c++');
    expect(languageLabel('c#')).toBe('c#');
    expect(languageLabel('dockerfile')).toBe('dockerfile');
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

