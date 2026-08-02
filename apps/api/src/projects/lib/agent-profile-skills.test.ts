import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { parseGitHubSkillUrl } from './agent-profile-skill-sources';
import {
  AgentSkillImportError,
  readAgentSkillArchive,
  validateAgentSkillFiles,
} from './agent-profile-skills';

const skill = (name: string, body = 'Follow this workflow.') => `---
name: ${name}
description: ${name} workflow
---

${body}
`;

async function archive(files: Array<{ path: string; content: string; unixPermissions?: number }>) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, {
      unixPermissions: file.unixPermissions,
      createFolders: true,
    });
  }
  return new Uint8Array(
    await zip.generateAsync({
      type: 'uint8array',
      platform: 'UNIX',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    }),
  );
}

function mutateCentralDirectoryEntry(
  bytes: Uint8Array,
  path: string,
  offset: number,
  mutate: (view: DataView, offset: number) => void,
): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let index = 0; index <= copy.byteLength - 4; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(index + 28, true);
    const name = new TextDecoder().decode(copy.subarray(index + 46, index + 46 + nameLength));
    if (name !== path) continue;
    mutate(view, index + offset);
    return copy;
  }
  throw new Error(`ZIP central directory entry ${path} was not found.`);
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
        await archive([{ path: '../escape/SKILL.md', content: skill('escape') }]),
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

  test('rejects file-count and cumulative expansion bombs while reading the archive', async () => {
    await expect(
      readAgentSkillArchive(
        await archive([
          { path: 'bounded/SKILL.md', content: skill('bounded') },
          ...Array.from({ length: 100 }, (_, index) => ({
            path: `bounded/references/${index}.md`,
            content: 'bounded',
          })),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_file_count' });

    const directoryBomb = new JSZip();
    for (let index = 0; index < 201; index += 1) directoryBomb.folder(`directory-${index}`);
    await expect(
      readAgentSkillArchive(
        new Uint8Array(await directoryBomb.generateAsync({ type: 'uint8array' })),
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_file_count' });

    await expect(
      readAgentSkillArchive(
        await archive([
          { path: 'bounded/SKILL.md', content: skill('bounded') },
          ...Array.from({ length: 20 }, (_, index) => ({
            path: `bounded/references/${index}.md`,
            content: 'x'.repeat(1024 * 1024),
          })),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'skill_archive_too_large' });
  });

  test('bounds decompression when ZIP metadata understates expanded size', async () => {
    const bytes = await archive([
      { path: 'bounded/SKILL.md', content: skill('bounded', 'x'.repeat(3 * 1024 * 1024)) },
    ]);
    const understated = mutateCentralDirectoryEntry(
      bytes,
      'bounded/SKILL.md',
      24,
      (view, offset) => {
        view.setUint32(offset, 1, true);
      },
    );

    await expect(readAgentSkillArchive(understated)).rejects.toMatchObject({
      code: 'skill_archive_file_too_large',
    });
  });

  test('rejects an archive with a mismatched entry checksum', async () => {
    const bytes = await archive([{ path: 'bounded/SKILL.md', content: skill('bounded') }]);
    const corrupted = mutateCentralDirectoryEntry(bytes, 'bounded/SKILL.md', 16, (view, offset) => {
      view.setUint32(offset, view.getUint32(offset, true) ^ 1, true);
    });

    await expect(readAgentSkillArchive(corrupted)).rejects.toMatchObject({
      code: 'skill_archive_invalid',
    });
  });

  test('accepts only explicit GitHub skill folder or SKILL.md URLs', () => {
    expect(parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/incident-triage')).toEqual(
      { owner: 'acme', repo: 'skills', ref: 'main', path: 'incident-triage' },
    );
    expect(
      parseGitHubSkillUrl(
        'https://raw.githubusercontent.com/acme/skills/v2/incident-triage/SKILL.md',
      ),
    ).toEqual({ owner: 'acme', repo: 'skills', ref: 'v2', path: 'incident-triage' });
    expect(() => parseGitHubSkillUrl('https://example.com/skill/SKILL.md')).toThrow('github.com');
  });
});
