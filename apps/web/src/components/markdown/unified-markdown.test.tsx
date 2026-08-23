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

describe('UnifiedMarkdown code fence inside a list', () => {
  test('renders the snippet, not a stringified React element', () => {
    const html = renderToStaticMarkup(withIntl(<UnifiedMarkdown content={FENCE_IN_LIST_MD} />));

    expect(html).not.toContain('[object Object]');
    expect(html).toContain('./Setup.sh');
    expect(html).toContain('cd ~/UnrealEngine');
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
