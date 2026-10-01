import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyFlagBlocks, getManagedSkillFiles, getStarterFiles } from './index';

const BANNED = ['kortix send', 'Asked you', 'MESSAGE from session', 'ASK from'];

describe('applyFlagBlocks', () => {
  const doc = 'a\n<!-- flag:x -->\nX\n<!-- /flag:x -->\nb\n';
  test('flag off drops the block and markers', () => {
    expect(applyFlagBlocks(doc)).toBe('a\nb\n');
  });
  test('flag on keeps the body and drops only the markers', () => {
    expect(applyFlagBlocks(doc, ['x'])).toBe('a\nX\nb\n');
  });
  test('unknown flag is off', () => {
    expect(applyFlagBlocks(doc, ['y'])).toBe('a\nb\n');
  });
  test('multiple blocks resolve independently', () => {
    const t = '<!-- flag:x -->\n1\n<!-- /flag:x -->\nm\n<!-- flag:y -->\n2\n<!-- /flag:y -->';
    expect(applyFlagBlocks(t, ['y'])).toBe('m\n2');
  });
  test('block at EOF without trailing newline', () => {
    expect(applyFlagBlocks('a\n<!-- flag:x -->\nX\n<!-- /flag:x -->')).toBe('a');
  });
  test('CRLF marker lines are recognised', () => {
    expect(applyFlagBlocks('a\r\n<!-- flag:x -->\r\nX\r\n<!-- /flag:x -->\r\nb', [])).toBe('a\r\nb');
  });
  test('a removed block between blank lines leaves one blank line', () => {
    expect(applyFlagBlocks('a\n\n<!-- flag:x -->\nX\n<!-- /flag:x -->\n\nb')).toBe('a\n\nb');
  });
  test('table rows stay a valid table either way', () => {
    const t = '| h |\n|---|\n| 1 |\n<!-- flag:x -->\n| 2 |\n<!-- /flag:x -->\n| 3 |';
    expect(applyFlagBlocks(t)).toBe('| h |\n|---|\n| 1 |\n| 3 |');
    expect(applyFlagBlocks(t, ['x'])).toBe('| h |\n|---|\n| 1 |\n| 2 |\n| 3 |');
  });
});

describe('managed skill templates', () => {
  const all = (flags: string[]) => [
    ...getManagedSkillFiles({ flags }),
    ...getStarterFiles({ projectName: 'P', template: 'general-knowledge-worker', flags }),
  ];

  test('flags off: no human-messaging wording in any skill or agent file', () => {
    for (const f of all([])) {
      for (const term of BANNED) expect([f.path, f.content.includes(term)]).toEqual([f.path, false]);
      expect(f.content).not.toContain('flag:human_messaging');
    }
  });

  test('flags on: the guidance appears and no marker lines remain', () => {
    const files = all(['human_messaging']);
    const sys = files.find((f) => f.path === 'skills/kortix-system/SKILL.md')!;
    expect(sys.content).toContain('kortix send');
    expect(sys.content).toContain('[ASK from session');
    for (const f of files) expect(f.content).not.toContain('flag:human_messaging');
  });

  test('every flag used in a template is a known overlay flag', () => {
    const used = new Set<string>();
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else for (const m of readFileSync(p, 'utf8').matchAll(/<!-- flag:([\w-]+) -->/g)) used.add(m[1]!);
      }
    };
    walk(join(import.meta.dir, '..', 'templates'));
    expect([...used].sort()).toEqual(['human_messaging']);
  });
});
