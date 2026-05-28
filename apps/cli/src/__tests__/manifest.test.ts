import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { envSpecFromManifest, lintManifest, loadLocalManifest } from '../manifest';
import { parse as parseToml } from 'smol-toml';

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

  test('warns when kortix_version is missing', () => {
    const issues = lintToml(`[project]\nname = "x"\n`);
    expect(issues.errors).toEqual([]);
    expect(issues.warnings.some((w) => w.includes('kortix_version'))).toBe(true);
  });

  test('errors on non-numeric kortix_version', () => {
    const issues = lintToml(`kortix_version = "one"\n`);
    expect(issues.errors.some((e) => e.includes('kortix_version'))).toBe(true);
  });

  test('errors when [env] required is not an array', () => {
    const issues = lintToml(`kortix_version = 1\n[env]\nrequired = "NOPE"\n`);
    expect(issues.errors.some((e) => e.includes('required must be an array'))).toBe(true);
  });

  test('errors on an invalid env var name', () => {
    const issues = lintToml(`kortix_version = 1\n[env]\nrequired = ["1bad"]\n`);
    expect(issues.errors.some((e) => e.includes('not a valid env var name'))).toBe(true);
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
    expect(issues.errors.some((e) => e.includes('missing a slug'))).toBe(true);
    expect(issues.errors.some((e) => e.includes('type must be'))).toBe(true);
    expect(issues.errors.some((e) => e.includes('prompt is required'))).toBe(true);
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
});
