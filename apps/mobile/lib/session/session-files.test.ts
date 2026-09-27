import { describe, expect, test } from 'bun:test';

import {
  appendFileMention,
  deriveSessionFiles,
  filterSessionFiles,
  isSupportingFile,
  previewsInline,
  sessionFileKindLabel,
  sessionFileMentionLabel,
} from './session-files';

let seq = 0;
function tool(name: string, input: Record<string, unknown>, state: Record<string, unknown> = {}) {
  seq += 1;
  return {
    type: 'tool',
    id: `p${seq}`,
    callID: `c${seq}`,
    tool: name,
    state: { status: 'completed', input, ...state },
  };
}
function msg(role: 'user' | 'assistant', parts: unknown[]) {
  return { info: { id: `m${(seq += 1)}`, role }, parts } as never;
}

describe('deriveSessionFiles', () => {
  test('is empty without messages', () => {
    expect(deriveSessionFiles(undefined)).toEqual([]);
    expect(deriveSessionFiles([])).toEqual([]);
  });

  test('lists a written file with its name and path', () => {
    const files = deriveSessionFiles([
      msg('assistant', [tool('write', { filePath: '/workspace/out/report.pdf', content: 'x' })]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: 'report.pdf',
      path: '/workspace/out/report.pdf',
      kind: 'file',
    });
  });

  test('skips calls that failed or still run', () => {
    const files = deriveSessionFiles([
      msg('assistant', [
        tool('write', { filePath: '/workspace/a.md' }, { status: 'error' }),
        tool('write', { filePath: '/workspace/b.md' }, { status: 'running' }),
        tool('write', { filePath: '/workspace/c.md' }, { status: 'pending' }),
      ]),
    ]);
    expect(files).toEqual([]);
  });

  test('skips files the agent only read', () => {
    const files = deriveSessionFiles([
      msg('assistant', [tool('read', { filePath: '/workspace/a.md' })]),
    ]);
    expect(files).toEqual([]);
  });

  test('reads every file of one show call, items as an array or a JSON string', () => {
    const items = [
      { path: '/workspace/data.csv', title: 'Data' },
      { path: '/workspace/deck.pptx' },
    ];
    for (const raw of [items, JSON.stringify(items)]) {
      const files = deriveSessionFiles([msg('assistant', [tool('show', { items: raw })])]);
      expect(files.map((f) => f.name)).toEqual(['data.csv', 'deck.pptx']);
      expect(files[0]).toMatchObject({ title: 'Data', shown: true, kind: 'file' });
      expect(files[1].kind).toBe('presentation');
    }
  });

  test('leaves out a shown URL and a show without a path', () => {
    const files = deriveSessionFiles([
      msg('assistant', [
        tool('show', { url: 'https://example.com', title: 'Site' }),
        tool('show', { content: 'hello' }),
      ]),
    ]);
    expect(files).toEqual([]);
  });

  test('lists each file of an apply_patch, without deletions', () => {
    const files = deriveSessionFiles([
      msg('assistant', [
        tool(
          'apply_patch',
          { patchText: '…' },
          {
            metadata: {
              files: [
                { type: 'add', filePath: '/workspace/src/a.ts', relativePath: 'src/a.ts' },
                { type: 'delete', filePath: '/workspace/src/b.ts', relativePath: 'src/b.ts' },
              ],
            },
          }
        ),
      ]),
    ]);
    expect(files.map((f) => f.path)).toEqual(['/workspace/src/a.ts']);
  });

  test('lists a generated image by its output path', () => {
    const files = deriveSessionFiles([
      msg('assistant', [
        tool(
          'image_gen',
          { prompt: 'a cat' },
          { output: JSON.stringify({ path: '/workspace/images/cat.png' }) }
        ),
      ]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: 'cat.png',
      path: '/workspace/images/cat.png',
      kind: 'image',
    });
  });

  test('one row per file: an absolute write and a relative patch of it merge, the later one wins', () => {
    const files = deriveSessionFiles([
      msg('assistant', [
        tool('write', { filePath: '/workspace/notes.md' }),
        tool('show', { path: 'notes.md', title: 'Notes' }),
      ]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ title: 'Notes', shown: true });
  });

  test('orders the latest run first, then what the user came for before source files', () => {
    const files = deriveSessionFiles([
      msg('user', []),
      msg('assistant', [
        tool('write', { filePath: '/workspace/old.ts' }),
        tool('write', { filePath: '/workspace/old.pdf' }),
      ]),
      msg('user', []),
      msg('assistant', [
        tool('write', { filePath: '/workspace/new.ts' }),
        tool('write', { filePath: '/workspace/new.xlsx' }),
      ]),
    ]);
    expect(files.map((f) => f.name)).toEqual(['new.xlsx', 'new.ts', 'old.pdf', 'old.ts']);
    expect(files.map((f) => f.fresh)).toEqual(['new', 'new', undefined, undefined]);
  });

  test('marks a file rewritten in the latest run as updated', () => {
    const files = deriveSessionFiles([
      msg('user', []),
      msg('assistant', [tool('write', { filePath: '/workspace/a.md' })]),
      msg('user', []),
      msg('assistant', [tool('edit', { filePath: '/workspace/a.md' })]),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].fresh).toBe('updated');
  });
});

describe('sessionFileKindLabel', () => {
  test('names the kind a person recognizes', () => {
    const label = (name: string, kind: 'file' | 'image' | 'video' | 'presentation' = 'file') =>
      sessionFileKindLabel({ name, kind });
    expect(label('a.pdf')).toBe('PDF');
    expect(label('a.csv')).toBe('Spreadsheet');
    expect(label('a.docx')).toBe('Document');
    expect(label('a.html')).toBe('Web page');
    expect(label('a.JPG')).toBe('Image');
    expect(label('deck', 'presentation')).toBe('Slides');
    expect(label('clip', 'video')).toBe('Video');
    expect(label('main.ts')).toBe('File');
  });
});

describe('isSupportingFile', () => {
  test('is true for source files and false for deliverables and shown files', () => {
    expect(isSupportingFile({ name: 'main.ts', kind: 'file', shown: false })).toBe(true);
    expect(isSupportingFile({ name: 'main.ts', kind: 'file', shown: true })).toBe(false);
    expect(isSupportingFile({ name: 'a.pdf', kind: 'file', shown: false })).toBe(false);
    expect(isSupportingFile({ name: 'a.png', kind: 'image', shown: false })).toBe(false);
  });
});

describe('filterSessionFiles', () => {
  const files = deriveSessionFiles([
    msg('assistant', [
      tool('write', { filePath: '/workspace/reports/q3.pdf' }),
      tool('show', { path: '/workspace/data.csv', title: 'Revenue table' }),
    ]),
  ]);

  test('returns every file for an empty query', () => {
    expect(filterSessionFiles(files, '  ')).toHaveLength(2);
  });

  test('matches the name, the title, the path and the kind, ignoring case', () => {
    expect(filterSessionFiles(files, 'Q3').map((f) => f.name)).toEqual(['q3.pdf']);
    expect(filterSessionFiles(files, 'revenue').map((f) => f.name)).toEqual(['data.csv']);
    expect(filterSessionFiles(files, 'reports/').map((f) => f.name)).toEqual(['q3.pdf']);
    expect(filterSessionFiles(files, 'spreadsheet').map((f) => f.name)).toEqual(['data.csv']);
    expect(filterSessionFiles(files, 'zzz')).toEqual([]);
  });
});

describe('sessionFileMentionLabel', () => {
  test('is the workspace-relative path', () => {
    expect(sessionFileMentionLabel('/workspace/out/report.pdf')).toBe('out/report.pdf');
    expect(sessionFileMentionLabel('out/report.pdf')).toBe('out/report.pdf');
  });
});

describe('appendFileMention', () => {
  test('adds the mention at the end of the draft, followed by a space', () => {
    expect(appendFileMention('', 'out/a.pdf')).toBe('@out/a.pdf ');
    expect(appendFileMention('Summarize', 'out/a.pdf')).toBe('Summarize @out/a.pdf ');
    expect(appendFileMention('Summarize ', 'out/a.pdf')).toBe('Summarize @out/a.pdf ');
    expect(appendFileMention('Line\n', 'out/a.pdf')).toBe('Line\n@out/a.pdf ');
  });

  test('does not add a file the draft already mentions', () => {
    expect(appendFileMention('See @out/a.pdf now', 'out/a.pdf')).toBe('See @out/a.pdf now');
  });
});

describe('previewsInline', () => {
  test('text, code, pages and images preview in the sheet', () => {
    for (const name of [
      'a.md',
      'a.html',
      'a.csv',
      'a.json',
      'main.ts',
      'notes.txt',
      'Dockerfile',
      'a.png',
      'a.JPG',
    ]) {
      expect(previewsInline(name)).toBe(true);
    }
  });

  test('documents, decks, sheets, archives and media do not: nothing is fetched for them', () => {
    for (const name of [
      'a.pdf',
      'a.PDF',
      'a.ppt',
      'a.pptx',
      'a.key',
      'a.doc',
      'a.docx',
      'a.xls',
      'a.xlsx',
      'a.zip',
      'a.tar',
      'a.gz',
      'a.mp4',
      'a.mov',
      'a.mp3',
      'a.wav',
    ]) {
      expect(previewsInline(name)).toBe(false);
    }
  });
});
