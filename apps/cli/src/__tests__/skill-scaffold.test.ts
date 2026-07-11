import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySkillScaffold, renderSkillMd, validateSkillName } from '../skill-scaffold';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-skill-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateSkillName', () => {
  test('accepts agentskills.io-valid names', () => {
    expect(validateSkillName('release-notes')).toBeUndefined();
    expect(validateSkillName('pdf')).toBeUndefined();
    expect(validateSkillName('invoice-parse-2')).toBeUndefined();
  });
  test('rejects invalid names', () => {
    expect(validateSkillName('My_Skill')).toBeDefined();
    expect(validateSkillName('-draft')).toBeDefined();
    expect(validateSkillName('pdf--merge')).toBeDefined();
    expect(validateSkillName('trailing-')).toBeDefined();
    expect(validateSkillName('UPPER')).toBeDefined();
  });
});

describe('renderSkillMd', () => {
  test('starts with frontmatter at byte 1 and includes name + description', () => {
    const md = renderSkillMd('invoice-parse', 'Parse invoices into JSON');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: invoice-parse');
    expect(md).toContain('description: "Parse invoices into JSON"');
    expect(md).not.toContain('license:');
  });
  test('adds a license line when provided', () => {
    expect(renderSkillMd('x', 'y', 'MIT')).toContain('license: "MIT"');
  });
});

describe('applySkillScaffold', () => {
  test('writes a spec-valid SKILL.md at the canonical path', () => {
    const r = applySkillScaffold({
      repoRoot: dir,
      name: 'invoice-parse',
      description: 'Parse invoices',
    });
    expect(r.path).toBe('.kortix/opencode/skills/invoice-parse/SKILL.md');
    const content = readFileSync(join(dir, r.path), 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('name: invoice-parse');
  });

  test('throws on an invalid name', () => {
    expect(() =>
      applySkillScaffold({ repoRoot: dir, name: 'Bad Name', description: 'd' }),
    ).toThrow();
  });

  test('refuses to overwrite unless force is set', () => {
    applySkillScaffold({ repoRoot: dir, name: 'x', description: 'd' });
    expect(() => applySkillScaffold({ repoRoot: dir, name: 'x', description: 'd2' })).toThrow();
    const r = applySkillScaffold({ repoRoot: dir, name: 'x', description: 'd2', force: true });
    expect(readFileSync(join(dir, r.path), 'utf8')).toContain('description: "d2"');
  });
});
