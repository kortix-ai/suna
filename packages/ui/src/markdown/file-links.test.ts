import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

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

  test('a session drive path (a worker result file in a thread folder) is a file link; traversal out of it is not', () => {
    expect(workspaceFileLinkPath('/drives/launch/threads/t-1a2b3c4d/results/report-1.md')).toBe('/drives/launch/threads/t-1a2b3c4d/results/report-1.md');
    expect(workspaceFileLinkPath('/drives/launch/threads/t-1a2b3c4d/results/report-1.md', DIR)).toBe('/drives/launch/threads/t-1a2b3c4d/results/report-1.md');
    expect(workspaceFileLinkPath('/drives/../etc/passwd', DIR)).toBeNull();
    expect(workspaceFileLinkPath('/drives/../etc/passwd')).toBeNull();
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

// A chat message linked a Drive file as `https://<this app>/drives/me/…`. The
// web app has no `/drives` route, so the link opened the 404 page. A link to
// this app's own `/drives/…` path is the same file as the root-relative path.
describe('workspaceFileLinkPath — an absolute link to this app\'s drive path', () => {
  const ORIGIN = 'https://app.example.com';
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { value: { location: { origin: ORIGIN } }, configurable: true });
  });
  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  test('the same-origin drive URL is the drive path', () => {
    expect(workspaceFileLinkPath(`${ORIGIN}/drives/me/Avatars/avatar.jpg`)).toBe('/drives/me/Avatars/avatar.jpg');
  });

  test('spaces and encoding decode, case is kept, query and hash are dropped', () => {
    expect(workspaceFileLinkPath(`${ORIGIN}/drives/me/Team%20photos/Group%20Shot.JPG?download=1#top`)).toBe('/drives/me/Team photos/Group Shot.JPG');
  });

  test('another origin, an app route and a traversal out of /drives stay links', () => {
    expect(workspaceFileLinkPath('https://other.example.com/drives/me/a.jpg')).toBeNull();
    expect(workspaceFileLinkPath(`${ORIGIN}/projects/p1/drive`)).toBeNull();
    expect(workspaceFileLinkPath(`${ORIGIN}/drives/../projects/p1`)).toBeNull();
    expect(workspaceFileLinkPath(`${ORIGIN}/drives/me/..%2F..%2Fetc%2Fpasswd`)).toBeNull();
  });

  test('an encoded traversal in a root-relative drive path is not a file link', () => {
    expect(workspaceFileLinkPath('/drives/me/..%2F..%2Fetc%2Fpasswd')).toBeNull();
  });
});
