import { describe, expect, test } from 'bun:test';
import { validateManifest } from '@kortix/manifest-schema';

import { STARTER_TEMPLATE_IDS, getStarterFiles } from '../index';

// The kortix_version 2 starter: what new projects get while the project flag
// `manifest_v3` is off (the default). It must stay byte-for-byte the starter
// that shipped before kortix_version 3.

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

function fileFor(path: string): string {
  return filesFor().find((file) => file.path === path)?.content ?? '';
}

function manifestFor(template?: string): string {
  return filesFor(template).find((file) => file.path === 'kortix.yaml')?.content ?? '';
}

describe('the kortix_version 2 starter (manifest_v3 off)', () => {
  test('scaffolds a kortix_version 2 manifest by default', () => {
    expect(manifestFor()).toContain('kortix_version: 2');
    expect(getStarterFiles({ projectName: 'Harness Lab', repoFullName: 'kortix/harness-lab', manifestVersion: 2 })).toEqual(filesFor());
  });

  test('declares no runtimes block and no non-opencode harness', () => {
    const manifest = manifestFor();

    expect(manifest).not.toContain('runtimes:');
    for (const harness of ['claude', 'codex', 'pi']) {
      expect(manifest).not.toContain(`harness: ${harness}`);
    }
  });

  test('configures OpenCode without a runtime selector', () => {
    const manifest = manifestFor();

    expect(manifest).toContain('opencode:');
    expect(manifest).toContain('config_dir: harnesses/opencode');
    expect(manifest).not.toContain('runtime:');
  });

  test('its default agent is the declared opencode agent', () => {
    expect(manifestFor()).toContain('default_agent: kortix');
  });

  test('the manifest advertises no other starter to switch to', () => {
    const manifest = manifestFor();

    expect(manifest).not.toContain('multi-harness');
    expect(manifest).not.toContain('EXPERIMENTAL');
  });

  test('no accepted id ships native config for another harness', () => {
    for (const id of [...STARTER_TEMPLATE_IDS, 'bogus', undefined]) {
      const paths = filesFor(id).map((file) => file.path);
      for (const path of NATIVE_HARNESS_CONFIG_PATHS) expect(paths).not.toContain(path);
    }
  });

  test('the scaffolded README names no other harness', () => {
    const readme = filesFor().find((file) => file.path === 'README.md')?.content ?? '';

    expect(readme).toContain('OpenCode');
    expect(readme).not.toContain('Claude Code');
    expect(readme).not.toContain('Codex');
    expect(readme).not.toContain('multi-harness');
  });

  test('the manifest is schema-valid with zero errors', () => {
    const result = validateManifest(manifestFor(), 'yaml');

    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test('keeps the general-knowledge skill kit', () => {
    const paths = filesFor().map((file) => file.path);

    expect(paths).toContain('skills/pdf/SKILL.md');
    expect(paths).toContain('agents/kortix.md');
  });

  test('keeps the fast starter tool ABI independent of the full plugin SDK', () => {
    const packageJson = JSON.parse(fileFor('harnesses/opencode/package.json')) as {
      kortixToolAbi?: number;
      dependencies?: Record<string, string>;
    };
    const lock = fileFor('harnesses/opencode/bun.lock');

    expect(packageJson.kortixToolAbi).toBe(1);
    expect(packageJson.dependencies?.zod).toBe('4.1.8');
    expect(packageJson.dependencies?.['@opencode-ai/plugin']).toBeUndefined();
    expect(lock).not.toContain('"@opencode-ai/plugin"');
    expect(lock).not.toContain('"effect"');
    expect(fileFor('.gitignore')).toContain('harnesses/opencode/package-lock.json');
    expect(fileFor('harnesses/opencode/plugins/pty.ts')).toContain("from './lib/tool'");
  });

  test('keeps the pty plugin in the OpenCode config dir and the kortix-cli skill in the repo', () => {
    const paths = filesFor('minimal').map((file) => file.path);

    expect(paths).toContain('harnesses/opencode/opencode.jsonc');
    expect(paths).toContain('harnesses/opencode/plugins/opencode-pty/src/plugin/pty/manager.ts');
    expect(paths).toContain('skills/kortix-cli/SKILL.md');
    expect(paths.filter((path) => path.startsWith('extensions/'))).toEqual([]);
  });

  test('ships no tool copies: the runtime hosts the Kortix tools on every harness', () => {
    const packageJson = JSON.parse(fileFor('harnesses/opencode/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const lock = fileFor('harnesses/opencode/bun.lock');

    expect(packageJson.dependencies).toEqual({ zod: '4.1.8' });
    for (const dependency of ['@mendable/firecrawl-js', '@tavily/core', 'replicate']) {
      expect(lock).not.toContain(`"${dependency}"`);
    }
    expect(filesFor().map((file) => file.path).filter((path) => path.startsWith('harnesses/opencode/tools/'))).toEqual([]);
  });
});

describe('internal minimal build', () => {
  test('lays down the same OpenCode-native v2 floor', () => {
    const manifest = manifestFor('minimal');

    expect(manifest).toContain('kortix_version: 2');
    expect(manifest).not.toContain('harness: claude');
  });

  test('carries no general-knowledge domain skill', () => {
    const paths = filesFor('minimal').map((file) => file.path);

    expect(paths).not.toContain('skills/pdf/SKILL.md');
  });
});
