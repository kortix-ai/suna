import { expect, test } from 'bun:test';
import { memoryRelPath, parseMemoryView } from './memory-helpers';
import { looksLikeHtml, parseWebSearchOutput, wsDomain, wsFavicon } from './web-helpers';
import { cleanResultSnippet, formatRawOutput, looksLikeJsonPayload } from '../tool-output-format';

test('memory helpers retain legacy roots and strip a trailing bare line number', () => {
  expect(memoryRelPath('.kortix/memory/notes.md')).toBe('notes.md');
  expect(memoryRelPath('memory-notes/notes.md')).toBe('memory-notes/notes.md');
  expect(parseMemoryView('Content of notes with line numbers\n1\thello\n2', 'notes')).toEqual({
    type: 'file', content: 'hello\n',
  });
  expect(parseMemoryView('', 'memory')).toBeNull();
});

test('web helpers retain source parsing and invalid URL fallbacks', () => {
  expect(parseWebSearchOutput({ results: [{ title: 'Example', url: 'https://example.test' }] })).toEqual([
    { query: '', sources: [{ title: 'Example', url: 'https://example.test', snippet: undefined, author: undefined, publishedDate: undefined }] },
  ]);
  expect(parseWebSearchOutput({ success: false })).toEqual([]);
  expect(wsDomain('https://www.example.test/path')).toBe('example.test');
  expect(wsDomain('not a URL')).toBe('not a URL');
  expect(wsFavicon('not a URL')).toBeNull();
  expect(looksLikeHtml('<!DOCTYPE html><html><body>hello</body></html>')).toBe(true);
});

test('output helpers retain JSON formatting, truncation and snippet cleanup', () => {
  expect(formatRawOutput('{"ok":true}')).toEqual({ text: '{\n  "ok": true\n}', truncatedChars: 0 });
  expect(formatRawOutput('abcdef', 3)).toEqual({ text: 'abc', truncatedChars: 3 });
  expect(looksLikeJsonPayload('  [1]')).toBe(true);
  expect(cleanResultSnippet('## hello hello [world](https://example.test)')).toBe('hello world');
});
