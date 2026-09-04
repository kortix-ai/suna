import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DocMarkdown } from './doc-markdown';

function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

const TABLE_MD = ['| Priority | Name |', '| --- | --- |', '| High | G1 |', ''].join('\n');
const ALIGN_TABLE_MD = ['| Center | Right |', '| :---: | ---: |', '| b | c |', ''].join('\n');
const CONFLICTING_CLASS_TABLE_HTML = [
  '<table><tr><th class="whitespace-normal">Head</th></tr>',
  '<tr><td class="break-all">cell</td></tr></table>',
].join('\n');

function cellClasses(html: string, tag: 'th' | 'td'): string[] {
  const matches = [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, 'g'))];
  return matches.map((m) => m[1]);
}

function cellTextAligns(html: string, tag: 'th' | 'td'): (string | undefined)[] {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\s+([^>]*)>`, 'g'))];
  return matches.map((m) => /text-align:\s*([a-z]+)/.exec(m[1])?.[1]);
}

describe('DocMarkdown table cells', () => {
  test('th carries whitespace-nowrap and break-normal', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={TABLE_MD} />));
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td carries break-normal', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={TABLE_MD} />));
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('th forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={ALIGN_TABLE_MD} />));
    const aligns = cellTextAligns(html, 'th');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('td forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={ALIGN_TABLE_MD} />));
    const aligns = cellTextAligns(html, 'td');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('th keeps whitespace-nowrap and break-normal when a raw HTML class conflicts', () => {
    const html = renderToStaticMarkup(
      withIntl(<DocMarkdown content={CONFLICTING_CLASS_TABLE_HTML} />),
    );
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td keeps break-normal when a raw HTML class conflicts', () => {
    const html = renderToStaticMarkup(
      withIntl(<DocMarkdown content={CONFLICTING_CLASS_TABLE_HTML} />),
    );
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('does not leak the react-markdown node prop onto th/td', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={TABLE_MD} />));

    expect(html).not.toContain('node=');
  });
});

// The docs renderer shares `MarkdownCode` and the same `li` path-wrapping walk
// as UnifiedMarkdown, so it carried the same fence regression. See
// `unified-markdown.test.tsx` for the full account.

const FENCE_IN_LIST_MD = [
  '1. Install:',
  '',
  '   ```bash',
  '   cd ~/UnrealEngine',
  '   ./Setup.sh',
  '   ```',
  '',
].join('\n');

/**
 * The text a reader sees, with the markup removed.
 *
 * Asserting on raw markup is only stable while the fence is UNHIGHLIGHTED:
 * where Shiki's grammar loads synchronously it emits one span per token, so
 * `cd ~/UnrealEngine` lands in two elements and a substring match on the HTML
 * misses. Splitting on the tag delimiters — rather than a `replace()` that
 * reads as an HTML sanitizer it is not — keeps this a test-only text
 * extractor.
 */
function visibleText(html: string): string {
  return html
    .split('<')
    .map((chunk, index) => (index === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join('');
}

describe('DocMarkdown code fence inside a list', () => {
  test('renders the snippet, not a stringified React element', () => {
    const html = renderToStaticMarkup(withIntl(<DocMarkdown content={FENCE_IN_LIST_MD} />));

    expect(visibleText(html)).not.toContain('[object Object]');
    expect(visibleText(html)).toContain('./Setup.sh');
    expect(html).not.toContain('Click to preview');
  });
});
