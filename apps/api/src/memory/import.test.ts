import { describe, expect, test } from 'bun:test';
import { MEMORY_LIMITS } from '@kortix/api-contract';
import type { FolderGrant } from '../drives/folders';
import { cutBody, decodeFile, everyMemberReads, IMPORT_MAX_FILES, type ImportedPage, importedPage, importFiles, pageTypeOf } from './import';

const DIR = '/Company/Channels/launch/Memory';
const file = (rel: string) => ({ path: `${DIR}/${rel}`, type: 'file' });
const page = (path: string, raw: string) => importedPage(path, raw) as ImportedPage;

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
    const p = page(`${DIR}/decisions.md`, '# Northwind launch\r\n\r\n## Status\r\nShips on 2026-11-02 after review.\r\n- Priya owns it\r\n')!;
    expect(p).toMatchObject({ type: 'decisions', title: 'Northwind launch', summary: 'Ships on 2026-11-02 after review.', fileName: 'decisions.md' });
    expect(p.body).toBe('## Status\nShips on 2026-11-02 after review.\n- Priya owns it\n\n⟦1⟧');
  });

  test('no heading: the title is the file name without extension and the body is whole', () => {
    const p = page(`${DIR}/topics/acme-contacts.md`, 'Priya — buyer at Acme\n')!;
    expect(p).toMatchObject({ type: 'people', title: 'acme-contacts', summary: 'Priya — buyer at Acme' });
    expect(p.body).toBe('Priya — buyer at Acme\n\n⟦1⟧');
  });

  test('a heading after text names the page but stays in the body', () => {
    const p = page(`${DIR}/x.md`, 'intro line\n# Later title\n')!;
    expect(p.title).toBe('Later title');
    expect(p.body).toBe('intro line\n# Later title\n\n⟦1⟧');
  });

  test('a blank file and a file holding a secret are skipped', () => {
    expect(importedPage(`${DIR}/x.md`, ' \n\n')).toEqual({ skip: 'blank' });
    expect(importedPage(`${DIR}/x.md`, '# Keys\naws AKIAABCDEFGHIJKLMNOP\n')).toEqual({ skip: 'secret' });
  });

  test('a # comment inside a code fence is no title, and a #hashtag line can be the summary', () => {
    const p = page(`${DIR}/deploy.md`, '```sh\n# not a title\n```\n#launch is on track\n')!;
    expect(p.title).toBe('deploy');
    expect(p.summary).toBe('#launch is on track');
  });

  test('summary is cut to 200 characters on one line', () => {
    const p = page(`${DIR}/x.md`, `${'word '.repeat(80)}\n`)!;
    expect(p.summary.length).toBe(MEMORY_LIMITS.summary_chars);
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

  test('a cut inside a code fence closes the fence before the note', () => {
    const body = cutBody(`intro\n\`\`\`\n${'code line\n'.repeat(1000)}\`\`\`\n`, path);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MEMORY_LIMITS.body_bytes);
    expect(body).toContain('code line\n```\n\n(Imported in part');
  });

  test('one long line is cut on a character boundary', () => {
    const body = cutBody('é'.repeat(6000), path);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MEMORY_LIMITS.body_bytes);
    expect(body).not.toContain('�');
    expect(body.startsWith('é'.repeat(4000))).toBe(true);
  });
});

describe('decodeFile', () => {
  const utf16 = (text: string, bigEndian = false) => {
    const bytes = [bigEndian ? 0xfe : 0xff, bigEndian ? 0xff : 0xfe];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      bytes.push(...(bigEndian ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8]));
    }
    return new Uint8Array(bytes);
  };

  test('UTF-16 with a byte order mark decodes to plain text that a page stores', () => {
    const text = decodeFile(utf16('# Acme plan\nPriya — owner\n'));
    expect(text).toBe('# Acme plan\nPriya — owner\n');
    expect(decodeFile(utf16('# Acme plan\n', true))).toBe('# Acme plan\n');
    expect((page(`${DIR}/plan.md`, text)).title).toBe('Acme plan');
  });

  test('NUL characters are dropped; UTF-8 passes through', () => {
    const noBom = new Uint8Array([0x41, 0x00, 0x63, 0x00, 0x6d, 0x00, 0x65, 0x00]);
    expect(decodeFile(noBom)).toBe('Acme');
    expect(decodeFile(new TextEncoder().encode('Ünïcode ⟦1⟧'))).toBe('Ünïcode ⟦1⟧');
  });
});

describe('everyMemberReads', () => {
  const grant = (path: string, principalType: FolderGrant['principalType'], principalId = 'x'): FolderGrant => ({
    path,
    level: 'read',
    principalType,
    principalId,
  });
  const MEMORY = '/Company/Channels/launch/Memory';

  test('the default project grant on /Company lets every member read the Memory folder', () => {
    expect(everyMemberReads(`${MEMORY}/decisions.md`, [grant('/Company', 'project')])).toBe(true);
  });

  test('without the /Company project grant, only the folders shared with the project import', () => {
    const grants = [grant(MEMORY, 'user', 'u1'), grant(`${MEMORY}/topics`, 'project')];
    expect(everyMemberReads(`${MEMORY}/private-plan.md`, grants)).toBe(false);
    expect(everyMemberReads(`${MEMORY}/topics/acme.md`, grants)).toBe(true);
    expect(everyMemberReads('/Company/Memory/x.md', [grant('/Company/Memory', 'group', 'g1')])).toBe(false);
  });
});
