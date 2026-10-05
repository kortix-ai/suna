import { describe, expect, test } from 'bun:test';

import { parseReadOutput } from './read-helpers';

describe('parseReadOutput', () => {
  test('a file read yields its path and content without line numbers', () => {
    const output = '<path>/a/b.ts</path>\n<content>\n1: const a = 1;\n2: export { a };\n</content>';
    expect(parseReadOutput(output)).toEqual({
      path: '/a/b.ts',
      type: 'file',
      content: 'const a = 1;\nexport { a };',
    });
  });

  test('a directory read yields its entries without the count footer', () => {
    const output = '<path>/a</path>\n<entries>\nsrc/\nREADME.md\n(2 entries)\n</entries>';
    expect(parseReadOutput(output)).toEqual({
      path: '/a',
      type: 'directory',
      entries: ['src/', 'README.md'],
    });
  });

  test('unrecognized output is null', () => {
    expect(parseReadOutput('')).toBeNull();
    expect(parseReadOutput('plain text')).toBeNull();
  });
});
