import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestText, validateManifest } from '@kortix/manifest-schema';

import {
  DEFAULT_STARTER_TEMPLATE_ID,
  STARTER_TEMPLATE_IDS,
  getStarterCatalogSourceMap,
  getStarterFiles,
  listGeneralKnowledgeWorkerSkills,
} from '../index';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

const NATIVE_HARNESS_CONFIG_PATHS = [
  '.claude/CLAUDE.md',
  '.codex/AGENTS.md',
  '.pi/README.md',
] as const;

function filesFor(template?: string) {
  return getStarterFiles({
    projectName: 'Harness Lab',
    repoFullName: 'kortix/harness-lab',
    template: template as never,
  });
}

function manifestFor(template?: string): string {
  return filesFor(template).find((file) => file.path === 'kortix.yaml')?.content ?? '';
}

/** The manifest with its `skills:` registry block removed: the one part that differs per template. */
function withoutSkillRegistry(manifest: string): string {
  return manifest.replace(/^skills:(?: \{\})?\n(?: {2}.+\n)*/m, '');
}

describe('one starter', () => {
  test('general-knowledge-worker is the default', () => {
    expect(DEFAULT_STARTER_TEMPLATE_ID).toBe('general-knowledge-worker');
  });

  test('an absent or unrecognized id scaffolds the default starter verbatim', () => {
    expect(filesFor(undefined)).toEqual(filesFor('general-knowledge-worker'));
    expect(filesFor('bogus')).toEqual(filesFor('general-knowledge-worker'));
  });

  test('every accepted id scaffolds the same manifest apart from its skill registry', () => {
    for (const id of STARTER_TEMPLATE_IDS) {
      expect(withoutSkillRegistry(manifestFor(id))).toBe(withoutSkillRegistry(manifestFor('general-knowledge-worker')));
    }
  });
});

describe('the starter manifest is the one kortix.yaml format', () => {
  test('starts with the schema line and sets no kortix_version', () => {
    for (const id of STARTER_TEMPLATE_IDS) {
      const manifest = manifestFor(id);

      expect(manifest.split('\n')[0]).toBe('# yaml-language-server: $schema=https://kortix.com/schema/kortix.schema.json');
      expect(manifest).not.toContain('kortix_version');
    }
  });

  test('every accepted id scaffolds a schema-valid manifest with zero issues', () => {
    for (const id of STARTER_TEMPLATE_IDS) {
      const result = validateManifest(manifestFor(id));

      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  test('declares no runtime selector and no harness config block', () => {
    const manifest = manifestFor();

    expect(manifest).not.toContain('runtimes:');
    expect(manifest).not.toContain('runtime:');
    expect(manifest).not.toContain('opencode:');
    expect(manifest).not.toContain('config_dir:');
    for (const harness of ['claude', 'codex', 'pi']) {
      expect(manifest).not.toContain(`harness: ${harness}`);
    }
  });

  test('its default agent is the one worker agent', () => {
    expect(manifestFor()).toContain('default_agent: worker');
  });

  test('registers exactly the skill folders each template ships', () => {
    const skillsOf = (id?: string) => (parseManifestText(manifestFor(id)) as { skills: Record<string, string> }).skills;

    expect(skillsOf('minimal')).toEqual({});
    expect(skillsOf()).toEqual(
      Object.fromEntries(listGeneralKnowledgeWorkerSkills().map((name) => [name, `skills/${name}`])),
    );
    const paths = new Set(filesFor().map((file) => file.path));
    for (const folder of Object.values(skillsOf())) expect(paths.has(`${folder}/SKILL.md`)).toBe(true);
  });

  test('the manifest advertises no other starter to switch to', () => {
    const manifest = manifestFor();

    expect(manifest).not.toContain('multi-harness');
    expect(manifest).not.toContain('EXPERIMENTAL');
  });

  test('no accepted id ships a harness folder or native config for another harness', () => {
    for (const id of [...STARTER_TEMPLATE_IDS, 'bogus', undefined]) {
      const paths = filesFor(id).map((file) => file.path);
      expect(paths.filter((path) => path.startsWith('harnesses/') || path.startsWith('.kortix/'))).toEqual([]);
      for (const path of NATIVE_HARNESS_CONFIG_PATHS) expect(paths).not.toContain(path);
    }
  });

  test('the scaffolded README names no harness', () => {
    const readme = filesFor().find((file) => file.path === 'README.md')?.content ?? '';

    expect(readme).not.toContain('OpenCode');
    expect(readme).not.toContain('Claude Code');
    expect(readme).not.toContain('Codex');
    expect(readme).not.toContain('multi-harness');
  });

  test('keeps the general-knowledge skill kit', () => {
    const paths = filesFor().map((file) => file.path);

    expect(paths).toContain('skills/pdf/SKILL.md');
    expect(paths).toContain('agents/worker.md');
  });

  test('ships no maintenance agents: one worker agent, My Kortix runs it', () => {
    const paths = filesFor().map((file) => file.path);
    expect(paths.filter((path) => path.startsWith('agents/'))).toEqual(['agents/worker.md']);
    const manifest = manifestFor();
    expect(manifest).not.toContain('harness-reflector');
    expect(manifest).not.toContain('session-reviewer');
    expect(manifest).toContain('tools: all');
  });
});

describe('starter catalog source map', () => {
  test('every entry points at a template file that exists on disk', () => {
    const missing = [...getStarterCatalogSourceMap().values()].filter(
      (source) => !existsSync(join(REPO_ROOT, source)),
    );

    expect(missing).toEqual([]);
  });

  test('names no multi-harness template root', () => {
    const roots = new Set(
      [...getStarterCatalogSourceMap().values()].map((source) => source.split('/')[3]),
    );

    expect([...roots].sort()).toEqual([
      'base',
      'general-knowledge-worker',
      'managed',
      'marketplace',
    ]);
  });
});

describe('internal minimal build', () => {
  test('carries no general-knowledge domain skill', () => {
    const paths = filesFor('minimal').map((file) => file.path);

    expect(paths).not.toContain('skills/pdf/SKILL.md');
  });
});
