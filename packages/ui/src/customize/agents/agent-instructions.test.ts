import { describe, expect, test } from 'bun:test';

import { splitFrontmatter } from './agent-instructions';

describe('splitFrontmatter', () => {
  test('an agent file with frontmatter: the head keeps its exact bytes, the body starts after it', () => {
    const file = '---\ndescription: "Reflector."\nmode: primary\npermission:\n  # sandboxed, unattended\n  "*": allow\n---\n\nYou are the reflector.\n';
    const { head, body } = splitFrontmatter(file);
    expect(body).toBe('\nYou are the reflector.\n');
    expect(head + body).toBe(file);
    expect(body).not.toContain('# sandboxed');
  });

  test('no frontmatter: the body is the whole text', () => {
    expect(splitFrontmatter('# Title\n\n---\n\ntext')).toEqual({ head: '', body: '# Title\n\n---\n\ntext' });
  });

  test('a CRLF file and a file that is only frontmatter both split', () => {
    expect(splitFrontmatter('---\r\nmode: primary\r\n---\r\nBody')).toEqual({ head: '---\r\nmode: primary\r\n---\r\n', body: 'Body' });
    expect(splitFrontmatter('---\nmode: primary\n---')).toEqual({ head: '---\nmode: primary\n---', body: '' });
  });
});
