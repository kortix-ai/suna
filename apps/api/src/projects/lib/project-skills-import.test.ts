import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  assertProjectSkillSlugsAvailable,
  normalizeProjectSkillImport,
  projectSkillImportTarget,
  summarizeProjectSkillImport,
} from './project-skills-import';

const skill = (name: string, body = 'Follow this workflow.') => `---
name: ${name}
description: ${name} workflow
---

${body}
`;

async function archive(
  files: Array<{
    path: string;
    content: string | Uint8Array;
    unixPermissions?: number;
  }>,
) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content, {
      createFolders: true,
      unixPermissions: file.unixPermissions,
    });
  }
  return Buffer.from(
    await zip.generateAsync({
      type: 'uint8array',
      platform: 'UNIX',
      compression: 'DEFLATE',
    }),
  ).toString('base64');
}

describe('project skill import normalization', () => {
  test('reports the project repo target for the import change request', () => {
    const target = projectSkillImportTarget(
      {
        repoUrl: 'https://github.com/dusseau-dev/reliance-financial-e29ce734.git',
        defaultBranch: 'main',
        metadata: {
          git: {
            name: 'reliance-financial-e29ce734',
            managed: true,
          },
        },
      },
      'kortix/skills/import/triage-20260803120000-deadbeef',
    );

    expect(target).toEqual({
      type: 'project_repo',
      repo_url: 'https://github.com/dusseau-dev/reliance-financial-e29ce734.git',
      repo_name: 'reliance-financial-e29ce734',
      managed: true,
      base_branch: 'main',
      branch: 'kortix/skills/import/triage-20260803120000-deadbeef',
      path_prefix: '.kortix/opencode/skills',
    });
  });

  test('normalizes a single markdown skill upload into a project skill file', async () => {
    const result = await normalizeProjectSkillImport({
      fileName: 'SKILL.md',
      dataBase64: Buffer.from(skill('direct-upload'), 'utf8').toString('base64'),
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      slug: 'direct-upload',
      name: 'direct-upload',
      description: 'direct-upload workflow',
    });
    expect(result.skills[0]?.files[0]).toMatchObject({
      path: '.kortix/opencode/skills/direct-upload/SKILL.md',
      mode: '100644',
    });
    const directSkill = result.skills[0];
    const directFile = directSkill?.files[0];
    if (!directFile) throw new Error('Expected direct skill file');
    expect(Buffer.from(directFile.content).toString('utf8')).toBe(skill('direct-upload'));
    expect(result.paths).toEqual(['.kortix/opencode/skills/direct-upload/SKILL.md']);
  });

  test('preserves multi-skill text, binary, and executable files while ignoring platform metadata', async () => {
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const result = await normalizeProjectSkillImport({
      fileName: 'support-skills.zip',
      dataBase64: await archive([
        {
          path: 'bundle/incident-triage/SKILL.md',
          content: skill('incident-triage'),
        },
        {
          path: 'bundle/incident-triage/references/severity.md',
          content: '# Severity',
        },
        {
          path: 'bundle/incident-triage/assets/pixel.png',
          content: image,
        },
        {
          path: 'bundle/incident-triage/scripts/check.sh',
          content: '#!/bin/sh\necho ok\n',
          unixPermissions: 0o100755,
        },
        { path: 'bundle/reply/SKILL.md', content: skill('reply') },
        { path: '__MACOSX/bundle/incident-triage/._SKILL.md', content: image },
        { path: 'bundle/.DS_Store', content: image },
        { path: 'bundle/reply/Thumbs.db', content: image },
      ]),
    });

    expect(result.skills.map((entry) => entry.slug)).toEqual(['incident-triage', 'reply']);
    expect(result.paths).toEqual([
      '.kortix/opencode/skills/incident-triage/SKILL.md',
      '.kortix/opencode/skills/incident-triage/assets/pixel.png',
      '.kortix/opencode/skills/incident-triage/references/severity.md',
      '.kortix/opencode/skills/incident-triage/scripts/check.sh',
      '.kortix/opencode/skills/reply/SKILL.md',
    ]);
    const incident = result.skills[0];
    if (!incident) throw new Error('Expected incident-triage skill');
    const asset = incident.files.find((file) => file.path.endsWith('/assets/pixel.png'));
    const script = incident.files.find((file) => file.path.endsWith('/scripts/check.sh'));
    if (!asset || !script) throw new Error('Expected binary asset and executable script');
    expect(Array.from(asset.content)).toEqual(Array.from(image));
    expect(asset.mode).toBe('100644');
    expect(script.mode).toBe('100755');
    expect(summarizeProjectSkillImport(result.skills)).toEqual([
      {
        slug: 'incident-triage',
        name: 'incident-triage',
        description: 'incident-triage workflow',
        files: [
          {
            path: '.kortix/opencode/skills/incident-triage/SKILL.md',
            size: 91,
          },
          {
            path: '.kortix/opencode/skills/incident-triage/assets/pixel.png',
            size: 6,
          },
          {
            path: '.kortix/opencode/skills/incident-triage/references/severity.md',
            size: 10,
          },
          {
            path: '.kortix/opencode/skills/incident-triage/scripts/check.sh',
            size: 18,
          },
        ],
      },
      {
        slug: 'reply',
        name: 'reply',
        description: 'reply workflow',
        files: [{ path: '.kortix/opencode/skills/reply/SKILL.md', size: 71 }],
      },
    ]);
  });

  test('rejects regular files outside every skill root', async () => {
    await expect(
      normalizeProjectSkillImport({
        fileName: 'unowned.zip',
        dataBase64: await archive([
          { path: 'bundle/triage/SKILL.md', content: skill('triage') },
          { path: 'bundle/README.md', content: '# Bundle' },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_unowned_file' });
  });

  test('preserves empty companion files in a root-level skill archive', async () => {
    const result = await normalizeProjectSkillImport({
      fileName: 'root.skill',
      dataBase64: await archive([
        { path: 'SKILL.md', content: skill('root-skill') },
        { path: 'references/empty.md', content: '' },
      ]),
    });

    expect(result.paths).toEqual([
      '.kortix/opencode/skills/root-skill/SKILL.md',
      '.kortix/opencode/skills/root-skill/references/empty.md',
    ]);
    expect(result.skills[0]?.files[1]?.content.byteLength).toBe(0);
  });

  test('rejects unsupported files, invalid base64, and duplicate project skill slugs', async () => {
    await expect(
      normalizeProjectSkillImport({
        fileName: 'skill.txt',
        dataBase64: Buffer.from(skill('wrong-extension'), 'utf8').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'skill_import_extension' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'SKILL.md',
        dataBase64: '@@@@',
      }),
    ).rejects.toMatchObject({ code: 'skill_import_invalid_base64' });

    const imported = await normalizeProjectSkillImport({
      fileName: 'SKILL.md',
      dataBase64: Buffer.from(skill('existing-skill'), 'utf8').toString('base64'),
    });

    expect(() =>
      assertProjectSkillSlugsAvailable(imported.skills, [
        {
          name: 'Existing skill',
          path: '.kortix/opencode/skills/existing-skill/SKILL.md',
          description: null,
        },
      ]),
    ).toThrow('Project already has a skill with slug "existing-skill".');
  });

  test('rejects malformed skill markdown and unsafe archives', async () => {
    await expect(
      normalizeProjectSkillImport({
        fileName: 'SKILL.md',
        dataBase64: Buffer.from('# Missing frontmatter', 'utf8').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'skill_frontmatter_invalid' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'traversal.zip',
        dataBase64: await archive([{ path: '../SKILL.md', content: skill('traversal') }]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_traversal' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'binary.zip',
        dataBase64: await archive([{ path: 'binary/SKILL.md', content: new Uint8Array([0xff]) }]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_binary_file' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'symlink.zip',
        dataBase64: await archive([
          { path: 'safe/SKILL.md', content: skill('safe') },
          { path: 'safe/link', content: 'target', unixPermissions: 0o120777 },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_symlink' });
  });

  test('rejects oversized files and duplicate slugs inside an archive', async () => {
    await expect(
      normalizeProjectSkillImport({
        fileName: 'SKILL.md',
        dataBase64: Buffer.from(skill('huge', 'x'.repeat(2 * 1024 * 1024)), 'utf8').toString(
          'base64',
        ),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_file_too_large' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'too-big.zip',
        dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_size' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'duplicate.zip',
        dataBase64: await archive([
          { path: 'first/SKILL.md', content: skill('duplicate') },
          { path: 'second/SKILL.md', content: skill('duplicate') },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'skill_slug_duplicate' });
  });

  test('rejects file-count and expanded-size limits after metadata filtering', async () => {
    await expect(
      normalizeProjectSkillImport({
        fileName: 'too-many.zip',
        dataBase64: await archive([
          { path: 'many/SKILL.md', content: skill('many') },
          ...Array.from({ length: 100 }, (_, index) => ({
            path: `many/references/${index}.md`,
            content: String(index),
          })),
          { path: '__MACOSX/._ignored', content: 'ignored' },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_file_count' });

    await expect(
      normalizeProjectSkillImport({
        fileName: 'expanded.zip',
        dataBase64: await archive([
          { path: 'expanded/SKILL.md', content: skill('expanded') },
          ...Array.from({ length: 10 }, (_, index) => ({
            path: `expanded/assets/${index}.txt`,
            content: 'x'.repeat(2 * 1024 * 1024),
          })),
        ]),
      }),
    ).rejects.toMatchObject({ code: 'skill_archive_too_large' });
  });
});
