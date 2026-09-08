import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '@kortix/manifest-schema';

import {
  DEFAULT_STARTER_TEMPLATE_ID,
  STARTER_TEMPLATE_IDS,
  getStarterCatalogSourceMap,
  getStarterFiles,
} from '../index';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const OPENCODE_ROOT = join(
  REPO_ROOT,
  'packages',
  'starter',
  'templates',
  'base',
  '.kortix',
  'opencode',
);

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

describe('one starter', () => {
  test('general-knowledge-worker is the default', () => {
    expect(DEFAULT_STARTER_TEMPLATE_ID).toBe('general-knowledge-worker');
  });

  test('an absent or unrecognized id scaffolds the default starter verbatim', () => {
    expect(filesFor(undefined)).toEqual(filesFor('general-knowledge-worker'));
    expect(filesFor('bogus')).toEqual(filesFor('general-knowledge-worker'));
  });

  test('every accepted id scaffolds the same OpenCode-native manifest', () => {
    for (const id of STARTER_TEMPLATE_IDS) {
      expect(manifestFor(id)).toBe(manifestFor('general-knowledge-worker'));
    }
  });
});

describe('the starter is OpenCode-native', () => {
  test('scaffolds a kortix_version 2 manifest', () => {
    expect(manifestFor()).toContain('kortix_version: 2');
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
    expect(manifest).toContain('config_dir: .kortix/opencode');
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

    expect(paths).toContain('.kortix/opencode/skills/pdf/SKILL.md');
    expect(paths).toContain('.kortix/opencode/agents/kortix.md');
  });

  test('keeps the fast starter tool ABI independent of the full plugin SDK', () => {
    const packageJson = JSON.parse(readFileSync(join(OPENCODE_ROOT, 'package.json'), 'utf8')) as {
      kortixToolAbi?: number;
      dependencies?: Record<string, string>;
    };
    const lock = readFileSync(join(OPENCODE_ROOT, 'bun.lock'), 'utf8');

    expect(packageJson.kortixToolAbi).toBe(1);
    expect(packageJson.dependencies?.zod).toBe('4.1.8');
    expect(packageJson.dependencies?.['@opencode-ai/plugin']).toBeUndefined();
    expect(lock).not.toContain('"@opencode-ai/plugin"');
    expect(lock).not.toContain('"effect"');
    expect(readFileSync(join(OPENCODE_ROOT, '..', '..', '.gitignore'), 'utf8')).toContain(
      '.kortix/opencode/package-lock.json',
    );

    for (const file of [
      'image_search.ts',
      'memory.ts',
      'scrape_webpage.ts',
      'show.ts',
      'web_search.ts',
    ]) {
      expect(readFileSync(join(OPENCODE_ROOT, 'tools', file), 'utf8')).toContain(
        'from "./lib/tool"',
      );
    }
    expect(readFileSync(join(OPENCODE_ROOT, 'plugins', 'pty.ts'), 'utf8')).toContain(
      "from '../tools/lib/tool'",
    );
  });

  test('keeps optional tools independent of provider SDKs', () => {
    const packageJson = JSON.parse(readFileSync(join(OPENCODE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lock = readFileSync(join(OPENCODE_ROOT, 'bun.lock'), 'utf8');

    expect(packageJson.dependencies).toEqual({ zod: '4.1.8' });
    for (const dependency of ['@mendable/firecrawl-js', '@tavily/core', 'replicate']) {
      expect(lock).not.toContain(`\"${dependency}\"`);
    }

    for (const file of ['image_search.ts', 'scrape_webpage.ts', 'web_search.ts']) {
      const source = readFileSync(join(OPENCODE_ROOT, 'tools', file), 'utf8');
      expect(source).not.toMatch(
        /import\(["'](?:@mendable\/firecrawl-js|@tavily\/core|replicate)["']\)/,
      );
    }
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
    ]);
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

    expect(paths).not.toContain('.kortix/opencode/skills/pdf/SKILL.md');
  });
});
