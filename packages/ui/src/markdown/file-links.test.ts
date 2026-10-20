import { describe, expect, test } from 'bun:test';

import { parseFileLinkHref, workspaceFileLinkPath } from './file-links';

// A markdown document renders with `documentPath` — the file it lives in.
// Relative links inside it are relative to that document's directory, and the
// rewrite must resolve them lexically. Traversal that escapes the sandbox
// roots stays `null` so rehype-harden keeps blocking it.
describe('workspaceFileLinkPath — document-relative resolution', () => {
  const DIR = '/workspace/memory';

  test('a sibling resolves against the document directory', () => {
    expect(workspaceFileLinkPath('kortix-company.md', DIR)).toBe('/workspace/memory/kortix-company.md');
  });

  test('a nested path resolves under the document directory', () => {
    expect(workspaceFileLinkPath('guides/setup.md', DIR)).toBe('/workspace/memory/guides/setup.md');
  });

  test('./ and one ../ resolve', () => {
    expect(workspaceFileLinkPath('./a.md', DIR)).toBe('/workspace/memory/a.md');
    expect(workspaceFileLinkPath('../kortix.md', DIR)).toBe('/workspace/kortix.md');
  });

  test('traversal outside the sandbox roots stays null', () => {
    expect(workspaceFileLinkPath('../../../../etc/passwd', DIR)).toBeNull();
    expect(workspaceFileLinkPath('../../../../etc/passwd', '/tmp')).toBeNull();
  });

  for (const href of ['../../etc/passwd', '/workspace/../../etc/passwd', 'sandbox:/etc/passwd', '%2fetc/passwd']) {
    test(`document links reject outside-root target ${href}`, () => {
      expect(workspaceFileLinkPath(href, DIR)).toBeNull();
    });
  }

  test('encoded traversal decodes before resolution and stays null', () => {
    expect(workspaceFileLinkPath('%2e%2e/%2e%2e/%2e%2e/etc/passwd', DIR)).toBeNull();
  });

  test('an absolute sandbox path is kept, outside-root absolute stays null', () => {
    expect(workspaceFileLinkPath('/workspace/a.md', DIR)).toBe('/workspace/a.md');
    expect(workspaceFileLinkPath('/etc/passwd', DIR)).toBeNull();
  });

  test('sandbox and file schemes resolve to their absolute path', () => {
    expect(workspaceFileLinkPath('sandbox:/workspace/a.md', DIR)).toBe('/workspace/a.md');
    expect(workspaceFileLinkPath('file:///workspace/a.md', DIR)).toBe('/workspace/a.md');
  });

  test('query and hash are stripped before resolution', () => {
    expect(workspaceFileLinkPath('a.md?download=1', DIR)).toBe('/workspace/memory/a.md');
  });

  test('no baseDir keeps the message-variant behavior untouched', () => {
    expect(workspaceFileLinkPath('../x.md')).toBe('../x.md');
    expect(workspaceFileLinkPath('output/report.docx')).toBe('output/report.docx');
    expect(workspaceFileLinkPath('sandbox:/workspace/a.docx')).toBe('/workspace/a.docx');
  });

  test('empty and anchor hrefs stay null', () => {
    expect(workspaceFileLinkPath('', DIR)).toBeNull();
    expect(workspaceFileLinkPath('#section', DIR)).toBeNull();
    expect(workspaceFileLinkPath('https://kortix.com', DIR)).toBeNull();
  });
});

describe('parseFileLinkHref — round-trip', () => {
  test('a rewritten fragment decodes back to the resolved path', () => {
    const path = workspaceFileLinkPath('kortix-company.md', '/workspace/memory');
    expect(parseFileLinkHref(`#kortix-file:${encodeURIComponent(path ?? '')}`)).toBe(path);
  });
});
