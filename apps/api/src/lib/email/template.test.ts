import { describe, expect, test } from 'bun:test';
import { escapeHtml } from './template';

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('escapes an ampersand once, so an entity in the input stays visible', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  test('leaves other text unchanged', () => {
    expect(escapeHtml('plain text 123 ü')).toBe('plain text 123 ü');
  });
});
