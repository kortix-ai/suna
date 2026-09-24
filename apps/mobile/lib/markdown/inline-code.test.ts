import { describe, expect, test } from 'bun:test';

import {
  classifyInlineCode,
  INLINE_CODE_SEGMENT,
  isHexColor,
  looksLikeFilePath,
  looksLikeUrl,
  splitInlineCode,
} from './inline-code';

describe('isHexColor', () => {
  test('accepts exactly the four CSS hex forms', () => {
    for (const hex of ['#fff', '#FFFA', '#0ea5e9', '#deadbeef']) expect(isHexColor(hex)).toBe(true);
    for (const text of ['#ff', '#fffff', '#0ea5e9ff0', '#ggg', 'fff', '#fff-ish', ' #fff']) {
      expect(isHexColor(text)).toBe(false);
    }
  });
});

describe('looksLikeUrl', () => {
  test('needs a scheme and no whitespace', () => {
    expect(looksLikeUrl('https://kortix.com/docs')).toBe(true);
    expect(looksLikeUrl('ftp://host/file')).toBe(true);
    expect(looksLikeUrl('kortix.com')).toBe(false);
    expect(looksLikeUrl('https://a b')).toBe(false);
  });
});

describe('looksLikeFilePath', () => {
  test('matches paths with a slash and an extension', () => {
    expect(looksLikeFilePath('/workspace/src/app.tsx')).toBe(true);
    expect(looksLikeFilePath('src/lib/utils.ts')).toBe(true);
    expect(looksLikeFilePath('./README.md')).toBe(true);
  });

  test('rejects commands, URLs, bare names, and prose abbreviations', () => {
    expect(looksLikeFilePath('npm run build')).toBe(false);
    expect(looksLikeFilePath('https://x.com/a.js')).toBe(false);
    expect(looksLikeFilePath('package.json')).toBe(false);
    expect(looksLikeFilePath('src/lib')).toBe(false);
    expect(looksLikeFilePath('e.g.')).toBe(false);
    expect(looksLikeFilePath(`/${'a'.repeat(300)}.ts`)).toBe(false);
  });
});

describe('classifyInlineCode', () => {
  test('orders hex, url, path, plain', () => {
    expect(classifyInlineCode(' #0ea5e9 ')).toBe('hex');
    expect(classifyInlineCode('https://kortix.com')).toBe('url');
    expect(classifyInlineCode('/workspace/a.py')).toBe('path');
    expect(classifyInlineCode('useState')).toBe('plain');
  });
});

describe('splitInlineCode', () => {
  const lossless = (code: string) => expect(splitInlineCode(code).join('')).toBe(code);

  test('keeps short code as one chip', () => {
    expect(splitInlineCode('useState')).toEqual(['useState']);
    expect(splitInlineCode('#0ea5e9')).toEqual(['#0ea5e9']);
    expect(splitInlineCode('a'.repeat(INLINE_CODE_SEGMENT.splitAbove))).toEqual(['a'.repeat(INLINE_CODE_SEGMENT.splitAbove)]);
    expect(splitInlineCode('')).toEqual(['']);
  });

  test('breaks a long path after each slash and hyphen, packing short pieces', () => {
    const path = 'apps/mobile/components/session/turn/user-message.tsx';
    expect(splitInlineCode(path)).toEqual(['apps/', 'mobile/', 'components/', 'session/', 'turn/user-', 'message.tsx']);
    lossless(path);
  });

  test('keeps a URL scheme and a flag prefix whole', () => {
    expect(splitInlineCode('https://kortix.com/docs/sdk?x=1')).toEqual(['https://', 'kortix.com/', 'docs/sdk?', 'x=1']);
    expect(splitInlineCode('pnpm test -- --sdk-only')).toEqual(['pnpm test ', '-- --sdk-', 'only']);
  });

  test('breaks after spaces', () => {
    expect(splitInlineCode('npx expo export --platform ios')).toEqual(['npx expo ', 'export ', '--platform ', 'ios']);
  });

  test('falls back to dots and underscores, then hard chunks, so no piece exceeds the max', () => {
    const dotted = 'com.kortix.mobile.session.turn.renderer';
    const snake = 'very_long_identifier_name_that_never_ends_at_all';
    const hash = 'f'.repeat(64);
    for (const code of [dotted, snake, hash]) {
      const pieces = splitInlineCode(code);
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(INLINE_CODE_SEGMENT.max);
      lossless(code);
    }
    expect(splitInlineCode(dotted)).toEqual(['com.kortix.mobile.', 'session.turn.', 'renderer']);
    expect(splitInlineCode(hash)).toEqual(['f'.repeat(20), 'f'.repeat(20), 'f'.repeat(20), 'ffff']);
  });

  test('never emits an empty piece', () => {
    for (const code of ['a//////////////////////b', '-----------------------', '   spaced    out    words   ']) {
      const pieces = splitInlineCode(code);
      expect(pieces.every((piece) => piece.length > 0)).toBe(true);
      lossless(code);
    }
  });
});
