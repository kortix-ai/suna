import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getLanguageFromExt } from './file-content-renderer';

const src = readFileSync(resolve(import.meta.dir, 'file-content-renderer.tsx'), 'utf8');

/**
 * Markdown is prose and gets a reading measure; code does not. These pin the
 * split, because "why is this column narrow?" is exactly the kind of class a
 * later refactor drops or copies onto the wrong branch.
 */
describe('markdown preview measure', () => {
  test('both .md and .mdx take the markdown branch', () => {
    // The preview branch keys off `language === 'markdown'`, so this is what
    // decides whether a file is capped at all.
    expect(getLanguageFromExt('README.md')).toBe('markdown');
    expect(getLanguageFromExt('page.mdx')).toBe('markdown');
  });

  test('code files do not take the markdown branch', () => {
    for (const [file, language] of [
      ['app.tsx', 'tsx'],
      ['util.ts', 'typescript'],
      ['main.py', 'python'],
    ]) {
      expect(getLanguageFromExt(file)).toBe(language);
      expect(getLanguageFromExt(file)).not.toBe('markdown');
    }
  });

  test('the markdown preview caps its column and centers it', () => {
    const start = src.indexOf('isMarkdownPreview && isMarkdownFile ?');
    // `<CodeEditor` also appears earlier (the HTML "view source" branch), so
    // anchor the end to the next one after the markdown branch, not the first.
    const branch = src.slice(start, src.indexOf('<CodeEditor', start));
    // Anti-vacuity guard: prove the slice is the branch we mean.
    expect(branch).toContain('MarkdownWithFrontmatter');
    expect(branch).toContain('max-w-2xl');
    expect(branch).toContain('mx-auto');
  });

  test('the code editor stays full width', () => {
    // The main editor is the last <CodeEditor> in the file.
    const start = src.lastIndexOf('<CodeEditor');
    const editor = src.slice(start, src.indexOf('/>', start));
    expect(editor).toContain('codeEditorProps');
    // A measure on code would re-break lines the author already formatted.
    expect(editor).not.toContain('max-w-');
  });
});
