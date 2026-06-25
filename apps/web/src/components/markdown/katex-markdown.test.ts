import { describe, expect, test } from 'bun:test';
import katex from 'katex';
import {
  buildKatexRehypePlugins,
  escapeCurrencyDollars,
  isKatexClassName,
  KATEX_FENCE_LANGUAGES,
  katexRemarkPlugins,
} from './katex-markdown';

describe('katex-markdown', () => {
  test('remark plugins enable single-dollar inline math', () => {
    const mathEntry = katexRemarkPlugins.find(
      (p) => Array.isArray(p) && p[0]?.name === 'remarkMath',
    );
    expect(mathEntry).toBeDefined();
    if (Array.isArray(mathEntry)) {
      expect((mathEntry[1] as { singleDollarTextMath?: boolean }).singleDollarTextMath).toBe(true);
    }
  });

  test('escapeCurrencyDollars escapes digit-led dollars only', () => {
    expect(escapeCurrencyDollars('$4M')).toBe('\\$4M');
    expect(escapeCurrencyDollars('$E=mc^2$')).toBe('$E=mc^2$');
  });

  test('rehype plugins run sanitize before katex', () => {
    const plugins = buildKatexRehypePlugins(true);
    const names = plugins.map((p) => (Array.isArray(p) ? p[0]?.name : p?.name));
    const sanitizeIdx = names.indexOf('rehypeSanitize');
    const katexIdx = names.indexOf('rehypeKatex');
    expect(sanitizeIdx).toBeGreaterThan(-1);
    expect(katexIdx).toBeGreaterThan(-1);
    expect(sanitizeIdx).toBeLessThan(katexIdx);
  });

  test('isKatexClassName detects KaTeX output classes', () => {
    expect(isKatexClassName('katex')).toBe(true);
    expect(isKatexClassName(['katex-html', 'base'])).toBe(true);
    expect(isKatexClassName('math-inline')).toBe(true);
    expect(isKatexClassName('text-foreground')).toBe(false);
  });

  test('KaTeX renders fractions with HTML layer intact', () => {
    const html = katex.renderToString('\\frac{a}{b}', { displayMode: true, throwOnError: false });
    expect(html).toContain('katex-html');
    expect(html).toContain('mfrac');
  });

  test('fence language set covers latex aliases', () => {
    expect(KATEX_FENCE_LANGUAGES.has('latex')).toBe(true);
    expect(KATEX_FENCE_LANGUAGES.has('tex')).toBe(true);
  });
});
