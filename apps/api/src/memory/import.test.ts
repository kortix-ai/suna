import { describe, expect, test } from 'bun:test';
import { MEMORY_LIMITS } from '@kortix/api-contract';
import { cutBody, IMPORT_MAX_FILES, importedPage, importFiles, pageTypeOf } from './import';

const DIR = '/Company/Channels/launch/Memory';
const file = (rel: string) => ({ path: `${DIR}/${rel}`, type: 'file' });

describe('importFiles', () => {
  test('takes *.md at depth ≤ 2, skips MEMORY.md, other files, dirs, hidden and conflict copies', () => {
    const entries = [
      file('MEMORY.md'),
      file('decisions.md'),
      file('topics/memory.MD'),
      file('topics/people.md'),
      file('a/b/too-deep.md'),
      file('notes.txt'),
      file('.keep'),
      file('.hidden/x.md'),
      file('roadmap (conflict 2026-10-01 1200 from laptop).md'),
      { path: `${DIR}/folder.md`, type: 'dir' },
      { path: '/Company/Memory/elsewhere.md', type: 'file' },
    ];
    expect(importFiles(DIR, entries).map((e) => e.path)).toEqual([`${DIR}/decisions.md`, `${DIR}/topics/people.md`]);
  });

  test('stops at 200 files, in path order', () => {
    const entries = Array.from({ length: 250 }, (_, i) => file(`f${String(i).padStart(3, '0')}.md`)).reverse();
    const taken = importFiles(DIR, entries);
    expect(taken).toHaveLength(IMPORT_MAX_FILES);
    expect(taken[0]!.path).toBe(`${DIR}/f000.md`);
  });
});

describe('pageTypeOf', () => {
  test.each([
    ['people.md', 'people'],
    ['Customer-Profile.md', 'people'],
    ['contacts.md', 'people'],
    ['decisions.md', 'decisions'],
    ['work.md', 'workstreams'],
    ['Q4-launch.md', 'workstreams'],
    ['roadmap.md', 'workstreams'],
    ['preferences.md', 'playbooks'],
    ['how-to-deploy.md', 'playbooks'],
    ['HowTo.md', 'playbooks'],
    ['style.md', 'playbooks'],
    ['feedback.md', 'note'],
  ] as const)('%s → %s', (name, type) => {
    expect(pageTypeOf(name)).toBe(type);
  });
});

describe('importedPage', () => {
  test('title from the first # heading, dropped from the body; summary is the first non-heading line', () => {
    const page = importedPage(`${DIR}/decisions.md`, '# Northwind launch\r\n\r\n## Status\r\nShips on 2026-11-02 after review.\r\n- Priya owns it\r\n')!;
    expect(page).toMatchObject({ type: 'decisions', title: 'Northwind launch', summary: 'Ships on 2026-11-02 after review.', fileName: 'decisions.md' });
    expect(page.body).toBe('## Status\nShips on 2026-11-02 after review.\n- Priya owns it\n\n⟦1⟧');
  });

  test('no heading: the title is the file name without extension and the body is whole', () => {
    const page = importedPage(`${DIR}/topics/acme-contacts.md`, 'Priya — buyer at Acme\n')!;
    expect(page).toMatchObject({ type: 'people', title: 'acme-contacts', summary: 'Priya — buyer at Acme' });
    expect(page.body).toBe('Priya — buyer at Acme\n\n⟦1⟧');
  });

  test('a heading after text names the page but stays in the body', () => {
    const page = importedPage(`${DIR}/x.md`, 'intro line\n# Later title\n')!;
    expect(page.title).toBe('Later title');
    expect(page.body).toBe('intro line\n# Later title\n\n⟦1⟧');
  });

  test('a blank file and a file holding a secret are skipped', () => {
    expect(importedPage(`${DIR}/x.md`, ' \n\n')).toBeNull();
    expect(importedPage(`${DIR}/x.md`, '# Keys\naws AKIAABCDEFGHIJKLMNOP\n')).toBeNull();
  });

  test('summary is cut to 200 characters on one line', () => {
    const page = importedPage(`${DIR}/x.md`, `${'word '.repeat(80)}\n`)!;
    expect(page.summary.length).toBe(MEMORY_LIMITS.summary_chars);
  });
});

describe('cutBody', () => {
  const path = `${DIR}/big.md`;

  test('a body that fits the cap is kept whole', () => {
    expect(cutBody('short', path)).toBe('short\n\n⟦1⟧');
  });

  test('over the cap: cut at the last line break within 8,000 bytes, with the Drive note', () => {
    const line = `${'é'.repeat(49)}x\n`; // 100 bytes per line
    const body = cutBody(line.repeat(100), path);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MEMORY_LIMITS.body_bytes);
    expect(body.endsWith(`\n\n(Imported in part; the full file is in Drive: ${path}) ⟦1⟧`)).toBe(true);
    const kept = body.slice(0, body.indexOf('\n\n(Imported'));
    expect(kept.split('\n')).toHaveLength(80);
    expect(kept.endsWith('x')).toBe(true);
  });

  test('one long line is cut on a character boundary', () => {
    const body = cutBody('é'.repeat(6000), path);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MEMORY_LIMITS.body_bytes);
    expect(body).not.toContain('�');
    expect(body.startsWith('é'.repeat(4000))).toBe(true);
  });
});
