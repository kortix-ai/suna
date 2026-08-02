import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  AgentSkillImportError,
  readAgentSkillArchive,
  validateAgentSkillFiles,
} from './agent-profile-skills';
import { parseGitHubSkillUrl } from './agent-profile-skill-sources';

const skill = (name: string, body = 'Follow this workflow.') => `---
name: ${name}
description: ${name} workflow
---

${body}
`;

async function archive(
  files: Array<{ path: string; content: string; unixPermissions?: number }>,
) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, {
      unixPermissions: file.unixPermissions,
      createFolders: true,
    });
  }
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' }));
}

describe('agent profile skill import validation', () => {
  test('normalizes a valid archive into deterministic project skill files', async () => {
    const result = await readAgentSkillArchive(
      await archive([
        { path: 'incident-triage/SKILL.md', content: skill('incident-triage') },
        { path: 'incident-triage/references/severity.md', content: '# Severity' },
      ]),
    );

    expect(result).toEqual([
      {
        slug: 'incident-triage',
        name: 'incident-triage',
        description: 'incident-triage workflow',
        files: [
          {
            path: '.kortix/opencode/skills/incident-triage/SKILL.md',
            content: skill('incident-triage'),
          },
          {
            path: '.kortix/opencode/skills/incident-triage/references/severity.md',
            content: '# Severity',
          },
        ],
      },
    ]);
  });

  test('rejects traversal entries, symlinks, invalid frontmatter, and duplicate slugs', async () => {
    await expect(
      readAgentSkillArchive(
        await archive([
          { path: '../escape/SKILL.md', content: skill('escape') },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_traversal' });

    await expect(
      readAgentSkillArchive(
        await archive([
          { path: 'safe/SKILL.md', content: skill('safe') },
          { path: 'safe/link', content: 'target', unixPermissions: 0o120777 },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_symlink' });

    expect(() =>
      validateAgentSkillFiles([{ path: 'broken/SKILL.md', content: 'No frontmatter' }]),
    ).toThrow(AgentSkillImportError);

    expect(() =>
      validateAgentSkillFiles([
        { path: 'one/SKILL.md', content: skill('same-skill') },
        { path: 'two/SKILL.md', content: skill('same-skill') },
      ]),
    ).toThrow('duplicate skill slug');
  });

  test('rejects oversized expanded archives before staging', () => {
    expect(() =>
      validateAgentSkillFiles([
        { path: 'large/SKILL.md', content: skill('large', 'x'.repeat(2 * 1024 * 1024 + 1)) },
      ]),
    ).toThrow('exceeds the 2 MB per-file limit');
  });

  test('accepts only explicit GitHub skill folder or SKILL.md URLs', () => {
    expect(
      parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/incident-triage'),
    ).toEqual({ owner: 'acme', repo: 'skills', ref: 'main', path: 'incident-triage' });
    expect(
      parseGitHubSkillUrl(
        'https://raw.githubusercontent.com/acme/skills/v2/incident-triage/SKILL.md',
      ),
    ).toEqual({ owner: 'acme', repo: 'skills', ref: 'v2', path: 'incident-triage' });
    expect(() => parseGitHubSkillUrl('https://example.com/skill/SKILL.md')).toThrow(
      'github.com',
    );
  });
});
