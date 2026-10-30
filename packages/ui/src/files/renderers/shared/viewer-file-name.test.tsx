import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveViewerFileName, ViewerFileName } from './viewer-file-name';

describe('resolveViewerFileName', () => {
  test('uses the basename of a path', () => {
    expect(resolveViewerFileName('/workspace/reports/q3.xlsx', 'Excel')).toBe('q3.xlsx');
  });

  test('passes through a plain name', () => {
    expect(resolveViewerFileName('resume.pdf', 'PDF')).toBe('resume.pdf');
  });

  test('falls back when missing, blank, or a bare directory path', () => {
    expect(resolveViewerFileName(undefined, 'Word')).toBe('Word');
    expect(resolveViewerFileName('   ', 'CSV')).toBe('CSV');
    expect(resolveViewerFileName('/workspace/', 'PDF')).toBe('PDF');
  });
});

describe('ViewerFileName', () => {
  test('renders a truncated title-bearing span', () => {
    const html = renderToStaticMarkup(
      <ViewerFileName fileName="/workspace/deck notes.docx" fallback="Word" />,
    );
    expect(html).toContain('deck notes.docx');
    expect(html).toContain('truncate');
    expect(html).toContain('title="deck notes.docx"');
  });
});
