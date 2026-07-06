import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { envSpecFromManifest, lintManifest, loadLocalManifest } from '../manifest';

function lintToml(toml: string) {
  return lintManifest(parseToml(toml) as Record<string, unknown>);
}

describe('envSpecFromManifest', () => {
  test('normalizes, uppercases, dedupes, and drops bad names', () => {
    const spec = envSpecFromManifest({
      env: {
        required: ['anthropic_api_key', 'ANTHROPIC_API_KEY', ' openai_api_key ', '1bad', 42],
        optional: ['foo'],
      },
    });
    expect(spec.required).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(spec.optional).toEqual(['FOO']);
  });

  test('missing [env] yields empty spec', () => {
    expect(envSpecFromManifest({})).toEqual({ required: [], optional: [] });
  });
});

describe('lintManifest', () => {
  test('a clean starter-shaped manifest has no errors', () => {
    const issues = lintToml(`
      kortix_version = 1
      [project]
      name = "x"
      [env]
      required = []
      optional = ["ANTHROPIC_API_KEY"]
    `);
    expect(issues.errors).toEqual([]);
  });

  test('errors when kortix_version is missing', () => {
    const issues = lintToml(`[project]\nname = "x"\n`);
    expect(issues.errors.some((e) => e.includes('kortix_version'))).toBe(true);
  });

  test('errors on non-numeric kortix_version', () => {
    const issues = lintToml(`kortix_version = "one"\n`);
    expect(issues.errors.some((e) => e.includes('kortix_version'))).toBe(true);
  });

  test('errors when [env] required is not an array', () => {
    const issues = lintToml(`kortix_version = 1\n[env]\nrequired = "NOPE"\n`);
    expect(issues.errors.some((e) => /env\.required.*array/i.test(e))).toBe(true);
  });

  test('errors on an invalid env var name', () => {
    const issues = lintToml(`kortix_version = 1\n[env]\nrequired = ["1bad"]\n`);
    expect(issues.errors.some((e) => /not a valid env-var name/i.test(e))).toBe(true);
  });

  test('accepts a valid cron trigger', () => {
    const issues = lintToml(`
      kortix_version = 1
      [[triggers]]
      slug = "nightly"
      type = "cron"
      cron = "0 0 3 * * *"
      prompt = "do the thing"
    `);
    expect(issues.errors).toEqual([]);
  });

  test('flags a missing slug, bad type, empty prompt, and missing cron', () => {
    const issues = lintToml(`
      kortix_version = 1
      [[triggers]]
      type = "weekly"
      prompt = ""
    `);
    expect(issues.errors.some((e) => /slug is required/i.test(e))).toBe(true);
    expect(issues.errors.some((e) => /type must be one of/i.test(e))).toBe(true);
    expect(issues.errors.some((e) => /prompt is required/i.test(e))).toBe(true);
  });

  test('flags duplicate trigger slugs', () => {
    const issues = lintToml(`
      kortix_version = 1
      [[triggers]]
      slug = "dup"
      type = "cron"
      cron = "* * * * * *"
      prompt = "a"
      [[triggers]]
      slug = "dup"
      type = "cron"
      cron = "* * * * * *"
      prompt = "b"
    `);
    expect(issues.errors.some((e) => e.includes('duplicate slug'))).toBe(true);
  });

  test('webhook trigger requires a secret_env', () => {
    const issues = lintToml(`
      kortix_version = 1
      [[triggers]]
      slug = "hook"
      type = "webhook"
      prompt = "x"
    `);
    expect(issues.errors.some((e) => e.includes('secret_env'))).toBe(true);
  });
});

describe('loadLocalManifest', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-manifest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when there is no kortix.toml', () => {
    expect(loadLocalManifest(dir)).toBeNull();
  });

  test('parses a manifest and extracts the env spec', () => {
    writeFileSync(
      join(dir, 'kortix.toml'),
      `kortix_version = 1\n[env]\nrequired = ["FOO"]\noptional = ["bar"]\n`,
    );
    const m = loadLocalManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.env.required).toEqual(['FOO']);
    expect(m!.env.optional).toEqual(['BAR']);
  });

  test('throws on a TOML syntax error', () => {
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = = 1\n`);
    expect(() => loadLocalManifest(dir)).toThrow();
  });

  test('reads a kortix.yaml and reports its format', () => {
    writeFileSync(
      join(dir, 'kortix.yaml'),
      `kortix_version: 1\nenv:\n  required: [FOO]\n  optional: [bar]\n`,
    );
    const m = loadLocalManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.format).toBe('yaml');
    expect(m!.path.endsWith('kortix.yaml')).toBe(true);
    expect(m!.env.required).toEqual(['FOO']);
    expect(m!.env.optional).toEqual(['BAR']);
  });

  test('prefers kortix.yaml when both files exist', () => {
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n[project]\nname = "from-toml"\n`);
    writeFileSync(join(dir, 'kortix.yaml'), `kortix_version: 1\nproject:\n  name: from-yaml\n`);
    const m = loadLocalManifest(dir);
    expect(m!.format).toBe('yaml');
    expect((m!.data.project as { name: string }).name).toBe('from-yaml');
  });
});

describe('manifest-edit — TOML (existing text-surgery behavior, unchanged)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-edit-toml-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('appendArrayBlock adds a [[section]] block', async () => {
    const { appendArrayBlock, arrayEntryExists } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    appendArrayBlock('triggers', { slug: 'nightly', type: 'cron' }, dir);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(true);
  });

  test('removeArrayBlock excises a matching block and leaves others intact', async () => {
    const { appendArrayBlock, removeArrayBlock, arrayEntryExists } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    appendArrayBlock('triggers', { slug: 'nightly', type: 'cron' }, dir);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron' }, dir);
    expect(removeArrayBlock('triggers', 'slug', 'nightly', dir)).toBe(true);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(false);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(true);
  });

  test('removeArrayBlock returns false when no block matches', async () => {
    const { appendArrayBlock, removeArrayBlock } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    appendArrayBlock('triggers', { slug: 'nightly', type: 'cron' }, dir);
    expect(removeArrayBlock('triggers', 'slug', 'nope', dir)).toBe(false);
  });

  test('setScalarInArrayBlock updates a scalar inside the matched block', async () => {
    const { appendArrayBlock, setScalarInArrayBlock, readArrayEntry } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    appendArrayBlock('triggers', { slug: 'nightly', type: 'cron', enabled: true }, dir);
    expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'enabled', false, dir)).toBe(true);
    expect(readArrayEntry('triggers', 'slug', 'nightly', dir)?.enabled).toBe(false);
  });

  test('setTableScalar creates the table when absent, then updates it in place', async () => {
    const { setTableScalar, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    setTableScalar('policy', 'default_mode', 'ask', dir);
    expect(readFileSync(manifestFile(dir), 'utf8')).toContain('[policy]');
    setTableScalar('policy', 'default_mode', 'allow', dir);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('default_mode = "allow"');
    expect(text).not.toContain('default_mode = "ask"');
  });
});

describe('manifest-edit — YAML (Document-AST editing, comment-preserving)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kortix-edit-yaml-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const FIXTURE = [
    'kortix_version: 1',
    'project:',
    '  name: demo',
    '',
    '# Nightly digest trigger',
    'triggers:',
    '  - slug: nightly # keep this comment',
    '    type: cron',
    '    cron: "0 9 * * *"',
    '    prompt: run it',
    '',
  ].join('\n');

  test('appendArrayBlock adds an entry and preserves existing comments', async () => {
    const { appendArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron', cron: '0 0 * * 0', prompt: 'weekly run' }, dir);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(true);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(true);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('removeArrayBlock excises the matching entry and preserves the surviving entry\'s comment', async () => {
    const { appendArrayBlock, removeArrayBlock, arrayEntryExists, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron', cron: '0 0 * * 0', prompt: 'weekly run' }, dir);
    expect(removeArrayBlock('triggers', 'slug', 'weekly', dir)).toBe(true);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(false);
    expect(arrayEntryExists('triggers', 'slug', 'nightly', dir)).toBe(true);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('removeArrayBlock returns false when no entry matches', async () => {
    const { removeArrayBlock } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(removeArrayBlock('triggers', 'slug', 'nope', dir)).toBe(false);
  });

  test('setScalarInArrayBlock updates a scalar in place and preserves comments', async () => {
    const { setScalarInArrayBlock, readArrayEntry, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(setScalarInArrayBlock('triggers', 'slug', 'nightly', 'enabled', false, dir)).toBe(true);
    expect(readArrayEntry('triggers', 'slug', 'nightly', dir)?.enabled).toBe(false);
    const text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('# Nightly digest trigger');
    expect(text).toContain('# keep this comment');
  });

  test('setScalarInArrayBlock returns false when no entry matches', async () => {
    const { setScalarInArrayBlock } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    expect(setScalarInArrayBlock('triggers', 'slug', 'nope', 'enabled', false, dir)).toBe(false);
  });

  test('setTableScalar creates a new table, then updates it in place, preserving comments', async () => {
    const { setTableScalar, manifestFile } = await import('../manifest-edit');
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    setTableScalar('policy', 'default_mode', 'ask', dir);
    let text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('default_mode: ask');
    expect(text).toContain('# Nightly digest trigger');
    setTableScalar('policy', 'default_mode', 'allow', dir);
    text = readFileSync(manifestFile(dir), 'utf8');
    expect(text).toContain('default_mode: allow');
    expect(text).not.toContain('default_mode: ask');
    expect(text).toContain('# keep this comment');
  });

  test('appendArrayBlock auto-creates a nested dotted section (sandbox.templates)', async () => {
    const { appendArrayBlock, arrayEntryExists } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('sandbox.templates', { slug: 'gpu', image: 'kortix/gpu:latest' }, dir);
    expect(arrayEntryExists('sandbox.templates', 'slug', 'gpu', dir)).toBe(true);
  });

  test('prefers kortix.yaml over kortix.toml when both exist (no guard-throw)', async () => {
    const { appendArrayBlock, arrayEntryExists } = await import('../manifest-edit');
    writeFileSync(join(dir, 'kortix.toml'), `kortix_version = 1\n`);
    writeFileSync(join(dir, 'kortix.yaml'), FIXTURE);
    appendArrayBlock('triggers', { slug: 'weekly', type: 'cron' }, dir);
    expect(arrayEntryExists('triggers', 'slug', 'weekly', dir)).toBe(true);
  });
});
