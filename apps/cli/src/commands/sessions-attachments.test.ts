import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeDownloadPath } from './sessions-attachments.ts';

const ID = '33333333-3333-4333-8333-333333333333';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kortix-attachments-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A download's name comes from the transcript, so a user or an agent chose it.
// Every case below is a name that must not be allowed to choose the PATH.
describe('safeDownloadPath', () => {
  test('an ordinary name lands in the output directory as itself', () => {
    expect(safeDownloadPath(dir, 'revenue.png', ID)).toBe(path.join(dir, 'revenue.png'));
  });

  test('a traversal is reduced to its last segment and stays inside', () => {
    for (const name of ['../../etc/passwd', '/etc/passwd', '..\\..\\windows\\win.ini', 'a/b/../../../c.txt']) {
      const target = safeDownloadPath(dir, name, ID);
      expect(path.dirname(target)).toBe(dir);
    }
    expect(safeDownloadPath(dir, '../../etc/passwd', ID)).toBe(path.join(dir, 'passwd'));
    expect(safeDownloadPath(dir, '..\\..\\windows\\win.ini', ID)).toBe(path.join(dir, 'win.ini'));
  });

  test('a name that is only dots, control characters, or nothing falls back to the id', () => {
    for (const name of [null, '', '..', '.', '\u0000\u0007', '   ']) {
      expect(safeDownloadPath(dir, name, ID)).toBe(path.join(dir, 'attachment-33333333'));
    }
  });

  test('a leading dot cannot create a hidden file', () => {
    expect(safeDownloadPath(dir, '.bashrc', ID)).toBe(path.join(dir, 'bashrc'));
  });

  test('control characters are removed, not written into the name', () => {
    expect(safeDownloadPath(dir, 'rep\u0000ort\u001b.pdf', ID)).toBe(path.join(dir, 'report.pdf'));
  });

  test('an existing file is never overwritten', () => {
    writeFileSync(path.join(dir, 'revenue.png'), 'first');
    writeFileSync(path.join(dir, 'revenue (1).png'), 'second');
    expect(safeDownloadPath(dir, 'revenue.png', ID)).toBe(path.join(dir, 'revenue (2).png'));
  });
});
