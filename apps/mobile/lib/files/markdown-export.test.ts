import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  downloadFormats,
  markdownPrintHtml,
  pdfFileName,
  PRINT_MARKDOWN_OPTIONS,
} from './markdown-export';

// The markdown-it build the app ships (react-native-markdown-display's), with
// the options the PDF export uses.
const appRequire = createRequire(import.meta.url);
const rendererRequire = createRequire(
  realpathSync(appRequire.resolve('react-native-markdown-display/package.json'))
);
const MarkdownIt = rendererRequire('markdown-it') as (
  options: typeof PRINT_MARKDOWN_OPTIONS
) => { render(source: string): string };
const md = MarkdownIt(PRINT_MARKDOWN_OPTIONS);

describe('downloadFormats', () => {
  test('a markdown file offers the file itself and a PDF', () => {
    expect(downloadFormats('notes.md')).toEqual(['file', 'pdf']);
    expect(downloadFormats('README.MD')).toEqual(['file', 'pdf']);
    expect(downloadFormats('/workspace/docs/guide.markdown')).toEqual(['file', 'pdf']);
  });

  test('every other file downloads as itself', () => {
    for (const name of ['report.pdf', 'data.csv', 'page.html', 'notes.txt', 'md', 'Makefile', 'notes.md.bak']) {
      expect(downloadFormats(name)).toEqual(['file']);
    }
  });
});

describe('pdfFileName', () => {
  test('swaps the markdown extension for .pdf', () => {
    expect(pdfFileName('notes.md')).toBe('notes.pdf');
    expect(pdfFileName('Guide.MARKDOWN')).toBe('Guide.pdf');
    expect(pdfFileName('release.v2.md')).toBe('release.v2.pdf');
  });

  test('uses the last path segment', () => {
    expect(pdfFileName('/workspace/docs/plan.md')).toBe('plan.pdf');
  });

  test('replaces characters a file name cannot hold', () => {
    expect(pdfFileName('a:b*c?"d"<e>|f.md')).toBe('a-b-c--d--e--f.pdf');
  });

  test('falls back to "document" when nothing is left', () => {
    expect(pdfFileName('.md')).toBe('document.pdf');
    expect(pdfFileName('')).toBe('document.pdf');
  });
});

describe('markdownPrintHtml', () => {
  const doc = (source: string, title = 'notes.md') => markdownPrintHtml(source, title, md);

  test('is a complete UTF-8 document with the print stylesheet', () => {
    const html = doc('# Title');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('@page');
    expect(html).toContain('<h1>Title</h1>');
  });

  test('renders headings, emphasis, lists, code, quotes and tables', () => {
    const html = doc(
      [
        '## Plan',
        '',
        'Some **bold** and *italic* and `code`.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '> quoted',
        '',
        '```ts',
        'const x = 1 < 2;',
        '```',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
      ].join('\n')
    );
    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>2</td>');
  });

  test('escapes raw HTML in the markdown instead of running it', () => {
    const html = doc('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('drops javascript: links', () => {
    const html = doc('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  test('escapes the title', () => {
    const html = doc('text', '</title><script>x</script>.md');
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;.md</title>');
    expect(html).not.toContain('<script>x');
  });
});
