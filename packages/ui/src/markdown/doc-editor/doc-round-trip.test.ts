import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Editor } from '@tiptap/core';
import { Window } from 'happy-dom';

import { docExtensions } from './doc-extensions';
import { htmlToMarkdown, markdownToHtml } from './markdown';

// TipTap parses and prints HTML with the browser DOM.
const DOM_GLOBALS = ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'navigator'] as const;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  const win = new Window();
  for (const key of DOM_GLOBALS) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === 'window' ? win : (win as unknown as Record<string, unknown>)[key];
  }
});
afterAll(() => {
  for (const key of DOM_GLOBALS) (globalThis as Record<string, unknown>)[key] = saved[key];
});

/** Markdown → the editor → Markdown, through a real TipTap editor with the doc schema. */
function throughEditor(markdown: string): string {
  const editor = new Editor({ extensions: docExtensions({ editable: true, placeholder: () => '' }), content: markdownToHtml(markdown) });
  const out = htmlToMarkdown(editor.getHTML());
  editor.destroy();
  return out;
}

describe('the document editor saves Markdown it opened unchanged', () => {
  test("the starter agent's instructions (agents/kortix.md)", () => {
    const starter = readFileSync(
      fileURLToPath(new URL('../../../../starter/templates/base/agents/kortix.md', import.meta.url)),
      'utf8',
    );
    expect(throughEditor(starter)).toBe(starter);
  });

  test('headings, lists, bold, inline code, code blocks and links', () => {
    const md = [
      '# Title',
      '',
      'A **bold** word, an *italic* one, `inline code` and a [link](https://kortix.com).',
      '',
      '## Steps',
      '',
      '1. First',
      '2. Second',
      '   - Nested',
      '',
      '- One',
      '- Two',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
    ].join('\n');
    expect(throughEditor(md)).toBe(md);
  });

  test('a <placeholder> in a sentence, an escaped backtick and a snake_case word stay as written', () => {
    const md = 'Run it with <package> and \\`pnpm\\`, or answer feature_disabled.\n';
    expect(throughEditor(md)).toBe(md);
  });
});
