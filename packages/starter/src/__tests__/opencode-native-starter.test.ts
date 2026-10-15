import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KORTIX_SKILL_NAMES, parseManifestText, validateManifest } from '@kortix/manifest-schema';

import {
  DEFAULT_STARTER_TEMPLATE_ID,
  KORTIX_MANAGED_SKILL_NAMES,
  listGeneralKnowledgeWorkerSkills,
  STARTER_TEMPLATE_IDS,
  getStarterCatalogSourceMap,
  getStarterFiles,
} from '../index';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const BASE_ROOT = join(REPO_ROOT, 'packages', 'starter', 'templates', 'base');

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

type Agents = Record<string, Record<string, unknown>>;

function parsed(template?: string): Record<string, unknown> & { agents: Agents } {
  return parseManifestText(manifestFor(template), 'yaml') as Record<string, unknown> & { agents: Agents };
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

describe('the starter is kortix.yaml v3', () => {
  test('scaffolds a kortix_version 3 manifest with the v3 schema line', () => {
    const manifest = manifestFor();

    expect(manifest.split('\n')[0]).toBe(
      '# yaml-language-server: $schema=https://kortix.com/schema/kortix.v3.schema.json',
    );
    expect(parsed().kortix_version).toBe(3);
  });

  test('every accepted id scaffolds a schema-valid manifest with zero issues', () => {
    for (const id of STARTER_TEMPLATE_IDS) {
      const result = validateManifest(manifestFor(id), 'yaml');

      expect(result.issues).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  test('ships no harness folder and no harness key', () => {
    for (const id of [...STARTER_TEMPLATE_IDS, 'bogus', undefined]) {
      const paths = filesFor(id).map((file) => file.path);

      expect(paths.filter((path) => path.startsWith('harnesses/') || path.startsWith('.kortix/'))).toEqual([]);
      for (const path of NATIVE_HARNESS_CONFIG_PATHS) expect(paths).not.toContain(path);
    }
    const manifest = parsed();
    for (const key of ['opencode', 'pi', 'harnesses', 'permission']) expect(manifest[key]).toBeUndefined();
  });

  test('declares the three starter agents, each with its prompt file', () => {
    const files = new Map(filesFor().map((file) => [file.path, file.content]));
    const { agents, default_agent } = parsed();

    expect(default_agent).toBe('kortix');
    expect(Object.keys(agents)).toEqual(['kortix', 'harness-reflector', 'session-reviewer']);
    for (const [name, block] of Object.entries(agents)) {
      expect(block.prompt_file).toBe(`agents/${name}.md`);
      const prompt = files.get(`agents/${name}.md`) ?? '';
      expect(prompt.length).toBeGreaterThan(0);
      // A v3 prompt file is the prompt alone: behavior lives in kortix.yaml.
      expect(prompt.startsWith('---')).toBe(false);
      expect(prompt).not.toContain('\\`');
      expect(prompt).not.toContain('harnesses/');
    }
    expect(agents.kortix!.mode).toBe('primary');
    expect(agents['harness-reflector']!.mode).toBe('primary');
    expect(agents['session-reviewer']!.mode).toBe('subagent');
  });

  test('grants keep today\'s behavior: kortix gets everything, the reflector pair no connectors or secrets', () => {
    const { agents } = parsed();

    for (const key of ['skills', 'subagents', 'commands', 'extensions', 'connectors', 'secrets', 'kortix_permissions']) {
      expect(agents.kortix![key]).toBe('all');
    }
    expect(agents['harness-reflector']).toMatchObject({
      skills: 'all',
      subagents: ['session-reviewer'],
      extensions: ['pty'],
      kortix_permissions: 'all',
    });
    expect(agents['session-reviewer']).toMatchObject({ skills: 'all', extensions: ['pty'], kortix_permissions: 'all' });
    for (const name of ['harness-reflector', 'session-reviewer']) {
      expect(agents[name]!.connectors).toBeUndefined();
      expect(agents[name]!.secrets).toBeUndefined();
    }
    // Omitted permission is `allow` in v3: the agents keep today's full access.
    for (const block of Object.values(agents)) expect(block.permission).toBeUndefined();
  });

  test('registers exactly the skill folders each template ships', () => {
    expect(parsed('minimal').skills).toEqual({});
    expect(parsed().skills).toEqual(
      Object.fromEntries(listGeneralKnowledgeWorkerSkills().map((name) => [name, `skills/${name}`])),
    );
    const paths = new Set(filesFor().map((file) => file.path));
    for (const folder of Object.values(parsed().skills as Record<string, string>)) {
      expect(paths.has(`${folder}/SKILL.md`)).toBe(true);
    }
  });

  test('the Kortix skills the validator registers are the managed skills the platform injects', () => {
    expect([...KORTIX_SKILL_NAMES].sort()).toEqual([...KORTIX_MANAGED_SKILL_NAMES].sort());
  });

  test('registers the pty plugin as an extension whose module ships in the starter', () => {
    const paths = new Set(filesFor().map((file) => file.path));
    const { extensions } = parsed();

    expect(extensions).toEqual({ pty: { opencode: 'extensions/pty/pty.ts' } });
    expect(paths.has('extensions/pty/pty.ts')).toBe(true);
    expect(paths.has('extensions/pty/lib/tool.ts')).toBe(true);
    expect(readFileSync(join(BASE_ROOT, 'extensions', 'pty', 'pty.ts'), 'utf8')).toContain("from './lib/tool'");
  });

  test('keeps the pty extension dependency-light: zod only, no plugin SDK', () => {
    const packageJson = JSON.parse(readFileSync(join(BASE_ROOT, 'extensions', 'pty', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lock = readFileSync(join(BASE_ROOT, 'extensions', 'pty', 'bun.lock'), 'utf8');

    expect(packageJson.dependencies).toEqual({ zod: '4.1.8' });
    expect(lock).not.toContain('"@opencode-ai/plugin"');
    expect(lock).not.toContain('"effect"');
  });

  test('registers no tools: the runtime hosts every Kortix tool', () => {
    expect(parsed().tools).toBeUndefined();
    expect(filesFor().map((file) => file.path).filter((path) => path.startsWith('tools/'))).toEqual([]);
  });

  test('the scaffolded README describes v3 and names no other harness', () => {
    const readme = filesFor().find((file) => file.path === 'README.md')?.content ?? '';

    expect(readme).toContain('kortix_version 3');
    expect(readme).toContain('OpenCode');
    expect(readme).not.toContain('harnesses/');
    expect(readme).not.toContain('Claude Code');
    expect(readme).not.toContain('Codex');
  });

  test('keeps the general-knowledge skill kit', () => {
    const paths = filesFor().map((file) => file.path);

    expect(paths).toContain('skills/pdf/SKILL.md');
    expect(paths).toContain('agents/kortix.md');
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
  test('lays down the same v3 floor', () => {
    expect(parsed('minimal').kortix_version).toBe(3);
    expect(Object.keys(parsed('minimal').agents)).toEqual(['kortix', 'harness-reflector', 'session-reviewer']);
  });

  test('carries no general-knowledge domain skill', () => {
    const paths = filesFor('minimal').map((file) => file.path);

    expect(paths).not.toContain('skills/pdf/SKILL.md');
  });
});
