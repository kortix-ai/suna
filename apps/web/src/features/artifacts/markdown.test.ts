import { beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { htmlToMarkdown, markdownToHtml } from './markdown';

// The converters parse HTML with the browser's DOMParser.
beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = new Window().DOMParser;
});

/** What the editor holds: TipTap wraps each list item's text in a <p>, and a task item in label + div. */
function asEditorHtml(markdown: string): string {
  return markdownToHtml(markdown)
    .replace(/<li data-type="taskItem" data-checked="(true|false)">([^<]*)/g, (_m, c, text) =>
      `<li data-type="taskItem" data-checked="${c}"><label><input type="checkbox"${c === 'true' ? ' checked' : ''}><span></span></label><div><p>${text.trim()}</p></div>`)
    .replace(/<li>([^<]+)/g, '<li><p>$1</p>');
}

describe('doc Markdown round trip', () => {
  test('lists save tight, nested lists keep their indent, task state survives', () => {
    const md = '# Plan\n\n- One\n- Two\n  - Nested\n\n1. First\n2. Second\n\n- [x] Done\n- [ ] Open\n';
    const saved = htmlToMarkdown(asEditorHtml(md));
    expect(saved).toBe(md);
  });

  test('a loose task list (blank lines between items) still opens as a task list with its state', () => {
    const html = markdownToHtml('- [x] Done\n\n- [ ] Open\n');
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain('data-checked="true"');
    expect(html).toContain('data-checked="false"');
  });

  test('media still uploading (a local preview) is not saved; uploaded media is', () => {
    const saved = htmlToMarkdown('<p>A</p><img src="blob:http://x/1" data-uploading=""><img src="media/b.png"><video src="blob:http://x/2" data-uploading=""></video><p>B</p>');
    expect(saved).toBe('A\n\n![](media/b.png)\n\nB\n');
  });

  test('a link card saves as one escaped HTML line and opens again unchanged', () => {
    const card =
      '<div class="kx-embed"><a href="https://github.com/a/b/pull/1?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">' +
      '<span class="kx-embed-text"><span class="kx-embed-title">Fix &lt;script&gt; #1</span>' +
      '<span class="kx-embed-summary">Two lines</span><span class="kx-embed-url"><span class="kx-embed-href">https://github.com/a/b/pull/1</span></span></span>' +
      '<img class="kx-embed-image" src="https://opengraph.githubassets.com/1/a/b/pull/1" alt="" referrerpolicy="no-referrer"></a></div>';
    const saved = htmlToMarkdown(`<p>Before</p>${card}<p>After</p>`);
    expect(saved).toBe(`Before\n\n${card}\n\nAfter\n`);
    expect(markdownToHtml(saved)).toContain(card);
  });

  test('a card without an image keeps the favicon before its address through a save', () => {
    const card =
      '<div class="kx-embed"><a href="https://example.com/art" target="_blank" rel="noopener noreferrer"><span class="kx-embed-text">' +
      '<span class="kx-embed-title">Art</span><span class="kx-embed-url"><img class="kx-embed-favicon" ' +
      'src="https://www.google.com/s2/favicons?domain=example.com&amp;sz=128" alt="" referrerpolicy="no-referrer">' +
      '<span class="kx-embed-href">https://example.com/art</span></span></span></a></div>';
    const saved = htmlToMarkdown(card);
    expect(saved).toBe(`${card}\n`);
    expect(markdownToHtml(saved)).toContain(card);
  });
});
