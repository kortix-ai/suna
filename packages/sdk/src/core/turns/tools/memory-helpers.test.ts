import { describe, expect, test } from 'bun:test';

import { MEMORY_VERBS, memoryRelPath, parseMemoryView } from './memory-helpers';

describe('memory helpers', () => {
  test('MEMORY_VERBS names each memory command', () => {
    expect(MEMORY_VERBS).toEqual({
      view: 'View',
      create: 'Create',
      str_replace: 'Edit',
      insert: 'Insert',
      delete: 'Delete',
      rename: 'Rename',
    });
  });

  test('memoryRelPath is relative to the memory root', () => {
    expect(memoryRelPath('.kortix/memory/notes/a.md')).toBe('notes/a.md');
    expect(memoryRelPath('.kortix/memory/')).toBe('memory');
    expect(memoryRelPath(undefined)).toBe('');
  });

  test('a file view strips line numbers, including a bare trailing one', () => {
    const output =
      "Here's the content of .kortix/memory/a.md with line numbers:\n     1\tHello\n     2\tWorld\n     3";
    expect(parseMemoryView(output, '.kortix/memory/a.md')).toEqual({
      type: 'file',
      content: 'Hello\nWorld\n',
    });
  });

  test('a directory view lists entries and skips the viewed root', () => {
    const output = [
      'Here are the files and directories up to 2 levels deep in .kortix/memory:',
      '4.0K\t.kortix/memory',
      '12K\t.kortix/memory/notes',
      '1.2K\t.kortix/memory/notes/a.md',
    ].join('\n');
    expect(parseMemoryView(output, '.kortix/memory/')).toEqual({
      type: 'dir',
      entries: [
        { size: '12K', path: '.kortix/memory/notes', isDir: true },
        { size: '1.2K', path: '.kortix/memory/notes/a.md', isDir: false },
      ],
    });
  });

  test('anything else is not a view', () => {
    expect(parseMemoryView('', 'x')).toBeNull();
    expect(parseMemoryView('Memory updated.', 'x')).toBeNull();
  });
});
