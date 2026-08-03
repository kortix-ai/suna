import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SKILL_IMPORT_MAX_BYTES,
  formatSkillImportFileSize,
  isAcceptedSkillImportFile,
  skillImportFileError,
} from './skill-import-file';

describe('skill import file validation', () => {
  test('accepts markdown and archive skill uploads up to 10 MB', () => {
    expect(isAcceptedSkillImportFile(new File(['x'], 'SKILL.md'))).toBe(true);
    expect(isAcceptedSkillImportFile(new File(['x'], 'incident.md'))).toBe(true);
    expect(isAcceptedSkillImportFile(new File(['x'], 'incident.skill'))).toBe(true);
    expect(isAcceptedSkillImportFile(new File(['x'], 'incident.zip'))).toBe(true);
    expect(skillImportFileError(new File(['x'], 'incident.txt'))).toBe(
      'Choose a SKILL.md, .md, .skill, or ZIP file.',
    );
    expect(
      skillImportFileError(new File(['x'.repeat(SKILL_IMPORT_MAX_BYTES + 1)], 'incident.zip')),
    ).toBe('Skill uploads must be 10 MB or smaller.');
    expect(formatSkillImportFileSize(1_572_864)).toBe('1.5 MB');
  });
});

describe('SkillsView upload entry point', () => {
  test('uses the direct import modal for skill creation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./skills-view.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('SkillImportModal');
    expect(source).toContain('onCreate={() => setImportOpen(true)}');
    expect(source).not.toContain('newConfigPrompt');
  });

  test('explains that uploads target the Kortix project repo', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./skill-import-modal.tsx', import.meta.url)),
      'utf8',
    );
    const normalized = source.replace(/\s+/g, ' ');

    expect(source).toContain('Kortix project repo');
    expect(normalized).toContain('It does not install a local Codex or Conductor skill');
    expect(source).toContain('result.target?.repo_url');
  });

  test('selects a file before the explicit upload action starts the mutation', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./skill-import-modal.tsx', import.meta.url)),
      'utf8',
    );
    const normalized = source.replace(/\s+/g, ' ');

    expect(source).toContain('const [selectedFile, setSelectedFile]');
    expect(source).toContain('setSelectedFile(file)');
    expect(source).toContain('mutation.mutate(selectedFile)');
    expect(source).not.toContain('mutation.mutate(file)');
    expect(normalized).toContain('disabled={!selectedFile || mutation.isPending}');
    expect(source).toContain('formatSkillImportFileSize(selectedFile.size)');
  });
});
