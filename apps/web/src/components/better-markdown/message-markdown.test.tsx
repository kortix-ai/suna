import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageMarkdown } from './message-markdown';

const TABLE_MD = ['| Priority | Name |', '| --- | --- |', '| High | G1 |', ''].join('\n');
const ALIGN_TABLE_MD = ['| Center | Right |', '| :---: | ---: |', '| b | c |', ''].join('\n');

function cellClasses(html: string, tag: 'th' | 'td'): string[] {
  const matches = [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, 'g'))];
  return matches.map((m) => m[1]);
}

function cellTextAligns(html: string, tag: 'th' | 'td'): (string | undefined)[] {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\s+([^>]*)>`, 'g'))];
  return matches.map((m) => /text-align:\s*([a-z]+)/.exec(m[1])?.[1]);
}

function tableWrapperClasses(html: string): string {
  const match = /<div class="([^"]*overflow-x-auto[^"]*)"/.exec(html);
  return match?.[1] ?? '';
}

describe('MessageMarkdown table cells', () => {
  test('th carries whitespace-nowrap and break-normal', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={TABLE_MD} />);
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('whitespace-nowrap');
      expect(cls).toContain('break-normal');
    }
  });

  test('td carries break-normal', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={TABLE_MD} />);
    const classes = cellClasses(html, 'td');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('break-normal');
    }
  });

  test('th forwards alignment without a sanitize step for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={ALIGN_TABLE_MD} />);
    const aligns = cellTextAligns(html, 'th');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('td forwards alignment without a sanitize step for :---: and ---: columns', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={ALIGN_TABLE_MD} />);
    const aligns = cellTextAligns(html, 'td');

    expect(aligns).toEqual(['center', 'right']);
  });

  test('table wrapper scrolls horizontally, not vertically', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={TABLE_MD} />);
    const wrapperClasses = tableWrapperClasses(html);

    expect(wrapperClasses).toContain('overflow-x-auto');
    expect(wrapperClasses).not.toContain('overflow-y-auto');
  });

  test('th header band uses bg-muted, not bg-accent', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={TABLE_MD} />);
    const classes = cellClasses(html, 'th');

    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).toContain('bg-muted');
      expect(cls).not.toContain('bg-accent');
    }
  });

  test('does not leak the react-markdown node prop onto th/td', () => {
    const html = renderToStaticMarkup(<MessageMarkdown content={TABLE_MD} />);

    expect(html).not.toContain('node=');
  });
});
