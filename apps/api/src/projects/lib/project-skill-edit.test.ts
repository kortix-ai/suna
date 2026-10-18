import { parse as parseYaml } from 'yaml';
import { resolveManifestImports } from '@kortix/manifest-schema';
import { expect, test } from 'bun:test';
import { parseManifestString } from '../manifest-io';
import { projectSkillManifestEdit, renderSkillMarkdown } from './project-skill-edit';

function manifest(version = 3) {
  return parseManifestString(`kortix_version: ${version}\ndefault_agent: worker\nskills:\n  deploy: skills/deploy\n  other: skills/other\nagents:\n  worker:\n    skills: [deploy, other]\n    secrets: [TOKEN]\n  unrestricted:\n    skills: all\n`, 'yaml', 'kortix.yaml', 'root-revision', ['kortix.yaml', 'kortix.toml']);
}

test('v3 create registers the skill and carries the root revision without granting it', () => {
  const source = manifest();
  const edit = projectSkillManifestEdit(source, 'new-skill', 'create');
  const raw = parseManifestString(edit.files[0]?.content ?? '', 'yaml').raw;
  expect(raw.skills).toEqual({ deploy: 'skills/deploy', other: 'skills/other', 'new-skill': 'skills/new-skill' });
  expect(raw.agents).toEqual(source.raw.agents);
  expect(edit.expectedFileRevision).toEqual({ path: 'kortix.yaml', sha: 'root-revision', candidatePaths: ['kortix.yaml', 'kortix.toml'] });
});

test('delete unregisters only matching folder entries and their explicit agent references', () => {
  const source = manifest();
  source.raw.skills = { deploy: 'skills/deploy', alias: 'skills/deploy', other: 'skills/other', unrelated: 'features/skills/deploy' };
  const edit = projectSkillManifestEdit(source, 'deploy', 'delete');
  const raw = parseManifestString(edit.files[0]?.content ?? '', 'yaml').raw;
  expect(raw.skills).toEqual({ other: 'skills/other', unrelated: 'features/skills/deploy' });
  expect(raw.agents).toEqual({ worker: { skills: ['other'], secrets: ['TOKEN'] }, unrestricted: { skills: 'all' } });
});

test('v1/v2 do not change their manifests', () => {
  for (const version of [1, 2]) {
    const source = manifest(version);
    const before = structuredClone(source.raw);
    expect(projectSkillManifestEdit(source, 'deploy', 'delete').files).toEqual([]);
    expect(source.raw).toEqual(before);
  }
});

test('rejects invalid and reserved v3 slugs and registry collisions', () => {
  for (const slug of ['kortix-test', '../escape', 'Upper', '', 'x'.repeat(129)]) {
    expect(() => projectSkillManifestEdit(manifest(), slug, 'create')).toThrow();
  }
  expect(() => projectSkillManifestEdit(manifest(), 'deploy', 'create')).toThrow('already exists');
  const source = manifest();
  source.raw.skills = { alias: 'skills/new-skill' };
  expect(() => projectSkillManifestEdit(source, 'new-skill', 'create')).toThrow('already exists');
});


test('import-aware delete edits the owning file and pins all imported revisions', async () => {
  const root = parseManifestString('kortix_version: 3\nimports: [feature.yaml]\ndefault_agent: worker\n', 'yaml', 'kortix.yaml', 'root-sha');
  const imported = 'skills: {deploy: skills/deploy, other: skills/other}\nagents: {worker: {skills: [deploy, other], secrets: [TOKEN]}}\n';
  const resolved = await resolveManifestImports({ path: 'kortix.yaml', raw: root.raw }, {
    async list() { return [{ path: 'feature.yaml', revision: 'import-sha' }]; },
    async read() { return imported; },
  });
  const edit = projectSkillManifestEdit({ ...root, raw: resolved.raw, imports: resolved }, 'deploy', 'delete');
  expect(edit.files.map((file) => file.path)).toEqual(['feature.yaml']);
  const raw = parseManifestString(edit.files[0]?.content ?? '', 'yaml').raw;
  expect(raw.skills).toEqual({ other: 'skills/other' });
  expect(raw.agents).toEqual({ worker: { skills: ['other'], secrets: ['TOKEN'] } });
  expect(edit.alsoExpect).toEqual([{ path: 'feature.yaml', sha: 'import-sha' }]);
});


test('form frontmatter uses the registered grant identity, not the display title', () => {
  const slug = 'release-notes';
  const markdown = renderSkillMarkdown({ name: 'Release Notes', description: 'Draft the weekly "release notes": go' }, slug);
  const header = parseYaml(markdown.split('---\n')[1] ?? '');
  const edit = projectSkillManifestEdit(manifest(), slug, 'create');
  const registry = parseManifestString(edit.files[0]?.content ?? '', 'yaml').raw.skills;
  expect(registry).toHaveProperty(header.name, `skills/${slug}`);
  expect(header.name).toBe(slug);
  expect(header.description).toBe('Draft the weekly "release notes": go');
  expect(markdown).toContain('# Release Notes');
});
