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
});
