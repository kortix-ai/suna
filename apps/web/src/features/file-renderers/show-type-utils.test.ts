import { describe, expect, it } from 'bun:test';
import {
  getShowFileCategory,
  resolveShowType,
  shouldRenderFromSandboxFile,
} from './show-type-utils';

describe('getShowFileCategory', () => {
  it('maps rich extensions to their viewer category', () => {
    expect(getShowFileCategory('/w/a.pdf')).toBe('pdf');
    expect(getShowFileCategory('/w/a.csv')).toBe('csv');
    expect(getShowFileCategory('/w/a.xlsx')).toBe('xlsx');
    expect(getShowFileCategory('/w/a.docx')).toBe('docx');
    expect(getShowFileCategory('/w/a.pptx')).toBe('pptx');
    expect(getShowFileCategory('/w/a.png')).toBe('image');
  });

  it('leaves plain text formats as generic files', () => {
    expect(getShowFileCategory('/w/kortix.yaml')).toBe('file');
    expect(getShowFileCategory('/w/notes.md')).toBe('file');
    expect(getShowFileCategory('/w/main.py')).toBe('file');
  });
});

describe('resolveShowType', () => {
  it('lets a rich extension override a textish declared type', () => {
    expect(resolveShowType('markdown', '/w/report.pdf')).toBe('pdf');
    expect(resolveShowType('text', '/w/data.csv')).toBe('csv');
    expect(resolveShowType('file', '/w/deck.pptx')).toBe('pptx');
  });

  it('leaves a non-rich extension on its declared type', () => {
    expect(resolveShowType('markdown', '/w/notes.md')).toBe('markdown');
    expect(resolveShowType('code', '/w/kortix.yaml')).toBe('code');
  });

  it('never overrides an explicit non-textual declaration', () => {
    expect(resolveShowType('url', '/w/a.pdf')).toBe('url');
    expect(resolveShowType('error', '/w/a.csv')).toBe('error');
  });
});

// ─── The regression this rule exists for: a file shown with a path and no
// inline content must render regardless of which type label the agent chose.
// Gating on `type === 'file'` made a .md shown as 'markdown' — and a .yaml
// shown as 'code'/'text' — fall through every branch into an empty box. ─────

describe('shouldRenderFromSandboxFile', () => {
  it('reads from disk whenever there is a path and no inline content', () => {
    expect(shouldRenderFromSandboxFile('/workspace/kortix.yaml', '')).toBe(true);
    expect(shouldRenderFromSandboxFile('/workspace/asana-projects.md', '')).toBe(true);
    expect(shouldRenderFromSandboxFile('/workspace/main.py', '')).toBe(true);
  });

  it('prefers inline content when the payload carried it', () => {
    expect(shouldRenderFromSandboxFile('/workspace/kortix.yaml', 'a: 1')).toBe(false);
  });

  it('has nothing to read without a sandbox path', () => {
    expect(shouldRenderFromSandboxFile(null, '')).toBe(false);
    expect(shouldRenderFromSandboxFile(null, 'some text')).toBe(false);
  });
});
