import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UnifiedMarkdown } from './unified-markdown';

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

describe('UnifiedMarkdown table cells', () => {
  test('th carries whitespace-nowrap and break-normal', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={TABLE_MD} />));
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td carries break-normal', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={TABLE_MD} />));
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('th forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={ALIGN_TABLE_MD} />));
    const aligns = cellTextAligns(html, 'th');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('td forwards alignment through sanitize for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={ALIGN_TABLE_MD} />));
    const aligns = cellTextAligns(html, 'td');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('th keeps whitespace-nowrap and break-normal when a raw HTML class conflicts', () => {
    const html = renderToStaticMarkup(
      withIntl(<UnifiedMarkdown content={CONFLICTING_CLASS_TABLE_HTML} />),
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
      withIntl(<UnifiedMarkdown content={CONFLICTING_CLASS_TABLE_HTML} />),
    );
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('does not leak the react-markdown node prop onto th/td', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={TABLE_MD} />));

    expect(html).not.toContain('node=');
  });
});

// ─── Ordered-list marker gutter ─────────────────────────────────────────────
// Markers hang outside the `ol` padding box. A fixed `pl-6` gutter (22.08px)
// holds `9. ` (16.3px at 15px Roobert) but not `10. ` (25.7px), so the first
// digit painted past the list edge and an `overflow-hidden` ancestor cut it.
// ────────────────────────────────────────────────────────────────────────────

function orderedListTag(html: string): string {
  const match = /<ol\b[^>]*>/.exec(html);
  if (!match) throw new Error('no <ol> rendered');
  return match[0];
}

function numberedList(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `${start + i}. item`).join('\n') + '\n';
}

describe('UnifiedMarkdown ordered-list marker gutter', () => {
  test('a single-digit list keeps the pl-6 gutter', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown content={numberedList(9)} />)),
    );

    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 0ch)');
  });

  test('a ten-item list widens the gutter by one digit', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown content={numberedList(10)} />)),
    );

    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 1ch)');
  });

  test('markers render with tabular digits', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown content={numberedList(10)} />)),
    );

    expect(tag).toContain('marker:tabular-nums');
    expect(tag).not.toMatch(/\bpl-6\b/);
  });

  test('forwards the start ordinal and sizes the gutter from it', () => {
    const tag = orderedListTag(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown content={numberedList(3, 98)} />)),
    );

    expect(tag).toContain('start="98"');
    expect(tag).toContain('padding-inline-start:calc(var(--spacing) * 6 + 2ch)');
  });
});

// ─── A fenced block inside a list item ──────────────────────────────────────
// `li` runs its children through `wrapChildrenWithPaths`. That walk used to
// descend into the fence and swap the snippet for a React element, so
// `MarkdownCode` stringified an object and Shiki highlighted the literal
// `[object Object]` in place of the commands. Only fences whose body holds a
// detected path (`./Setup.sh`) tripped it, which is why it read as random.
// ────────────────────────────────────────────────────────────────────────────

const FENCE_IN_LIST_MD = [
  '1. Link your GitHub account',
  '',
  '2. **Clone + build**:',
  '',
  '   ```bash',
  '   git clone --depth 1 https://github.com/EpicGames/UnrealEngine ~/UnrealEngine',
  '   cd ~/UnrealEngine',
  '   ./Setup.sh',
  '   make',
  '   ```',
  '',
].join('\n');

const PATH_IN_LIST_MD = ['- open docs/readme.md now', ''].join('\n');

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

describe('UnifiedMarkdown code fence inside a list', () => {
  test('renders the snippet, not a stringified React element', () => {
    const text = visibleText(
      renderToStaticMarkup(withIntl(<UnifiedMarkdown content={FENCE_IN_LIST_MD} />)),
    );

    expect(text).not.toContain('[object Object]');
    expect(text).toContain('./Setup.sh');
    expect(text).toContain('cd ~/UnrealEngine');
  });

  test('does not inject clickable-path chrome into the fence body', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={FENCE_IN_LIST_MD} />));

    expect(html).not.toContain('Click to preview');
  });

  test('still makes a path in list prose clickable', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={PATH_IN_LIST_MD} />));

    expect(html).toContain('docs/readme.md — Click to preview');
  });
});
