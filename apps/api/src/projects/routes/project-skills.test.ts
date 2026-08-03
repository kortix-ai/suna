import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./project-skills.ts', import.meta.url), 'utf8');

describe('project skill import route orchestration', () => {
  test('commits every normalized file in one atomic Git write', () => {
    expect(source.match(/await commitMultipleFilesToBranch\(/g)).toHaveLength(1);
    expect(source).toContain('files: normalized.skills.flatMap((skill) => skill.files)');
  });

  test('returns metadata summaries instead of serialized file contents', () => {
    expect(source).toContain('skills: summarizeProjectSkillImport(normalized.skills)');
    expect(source).not.toContain('skills: normalized.skills,');
  });

  test('deletes the import branch when change-request creation or import fails', () => {
    expect(source.match(/await deleteRemoteSessionBranch\(/g)).toHaveLength(2);
    expect(source).toContain('if (!result.ok)');
    expect(source).toContain("code: 'skill_import_failed'");
  });
});
