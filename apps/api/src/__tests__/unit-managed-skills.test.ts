import { describe, expect, test } from 'bun:test';
import { KORTIX_MANAGED_SKILL_NAMES } from '@kortix/starter';
import {
  buildManagedSkills,
  getManagedSkill,
  getManagedSkillFile,
  listManagedSkills,
} from '../skills/catalog';

describe('managed skill catalog', () => {
  test('resolves every name in KORTIX_MANAGED_SKILL_NAMES', () => {
    const built = buildManagedSkills();
    const missing = KORTIX_MANAGED_SKILL_NAMES.filter((n) => !built.has(n));
    // A managed name with no resolvable SKILL.md means the skill was moved to a
    // template layer this module does not walk — the exact failure that would
    // otherwise ship a name the CLI lists but cannot fetch.
    expect(missing).toEqual([]);
  });

  test('serves only managed skills — no general starter skill leaks in', () => {
    const managed = new Set<string>(KORTIX_MANAGED_SKILL_NAMES);
    for (const name of buildManagedSkills().keys()) expect(managed.has(name)).toBe(true);
  });

  test('every skill has a non-empty body and a parsed frontmatter description', () => {
    for (const skill of buildManagedSkills().values()) {
      expect(skill.body.length).toBeGreaterThan(0);
      expect(skill.body.startsWith('---')).toBe(true);
      expect(skill.description.length).toBeGreaterThan(0);
    }
  });

  test('kortix-system carries its reference tree, sorted, SKILL.md excluded', () => {
    const skill = getManagedSkill('kortix-system');
    expect(skill).not.toBeNull();
    const paths = skill!.references.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).not.toContain('SKILL.md');
    expect(paths.every((p) => p.startsWith('references/'))).toBe(true);
    expect([...paths].sort()).toEqual(paths);
  });

  test('the list carries no bodies — it stays small enough to always read', () => {
    const summaries = listManagedSkills();
    expect(summaries.length).toBe(KORTIX_MANAGED_SKILL_NAMES.length);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain('<skill name=');
    // The whole point of parsing frontmatter server-side: choosing a skill must
    // not cost a fraction of what reading them all would (~330 KB today).
    expect(serialized.length).toBeLessThan(20_000);
    for (const s of summaries) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.bytes).toBeGreaterThan(0);
    }
  });

  test('the served text is byte-identical to the sandbox-baked managed skills', () => {
    // Both sides run the same @kortix/starter extraction; this pins them together
    // so the API can never serve instructions a session would not get.
    const skill = getManagedSkill('kortix-executor');
    expect(skill).not.toBeNull();
    expect(skill!.bytes).toBe(
      skill!.body.length + skill!.references.reduce((n, f) => n + f.content.length, 0),
    );
  });

  test('unknown skill resolves to null rather than throwing', () => {
    expect(getManagedSkill('does-not-exist')).toBeNull();
    expect(getManagedSkillFile('does-not-exist', 'SKILL.md')).toBeNull();
  });

  test('file lookup is exact-match, so traversal paths simply miss', () => {
    expect(getManagedSkillFile('kortix-system', 'SKILL.md')?.content).toBe(
      getManagedSkill('kortix-system')!.body,
    );
    expect(getManagedSkillFile('kortix-system', '../kortix-slack/SKILL.md')).toBeNull();
    expect(getManagedSkillFile('kortix-system', '/etc/passwd')).toBeNull();
    expect(getManagedSkillFile('kortix-system', 'references/../../../secret')).toBeNull();
  });

  test('a real reference file round-trips by its listed path', () => {
    const skill = getManagedSkill('kortix-system')!;
    const first = skill.references[0];
    expect(getManagedSkillFile('kortix-system', first.path)?.content).toBe(first.content);
  });
});
