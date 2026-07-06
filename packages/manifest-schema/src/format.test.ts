import { describe, expect, test } from 'bun:test';
import {
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
} from './format';
import { validateManifest } from './index';

describe('manifestCandidatePaths', () => {
  test('default → yaml, yml, toml in priority order', () => {
    expect(manifestCandidatePaths(undefined)).toEqual([
      { path: 'kortix.yaml', format: 'yaml' },
      { path: 'kortix.yml', format: 'yaml' },
      { path: 'kortix.toml', format: 'toml' },
    ]);
    expect(manifestCandidatePaths('kortix.toml')).toEqual(manifestCandidatePaths(undefined));
    expect(manifestCandidatePaths('')).toEqual(manifestCandidatePaths(undefined));
  });

  test('a custom path resolves its yaml/toml siblings (dir preserved)', () => {
    expect(manifestCandidatePaths('config/kortix.toml')).toEqual([
      { path: 'config/kortix.yaml', format: 'yaml' },
      { path: 'config/kortix.yml', format: 'yaml' },
      { path: 'config/kortix.toml', format: 'toml' },
    ]);
  });

  test('an explicit .yaml path still prefers yaml first', () => {
    expect(manifestCandidatePaths('kortix.yaml')[0]).toEqual({
      path: 'kortix.yaml',
      format: 'yaml',
    });
  });
});

describe('manifestFormatForPath', () => {
  test('detects yaml from .yaml/.yml, toml otherwise', () => {
    expect(manifestFormatForPath('kortix.yaml')).toBe('yaml');
    expect(manifestFormatForPath('kortix.yml')).toBe('yaml');
    expect(manifestFormatForPath('kortix.toml')).toBe('toml');
    expect(manifestFormatForPath('anything')).toBe('toml');
  });
});

describe('parse/serialize round-trip', () => {
  const obj = {
    kortix_version: 1,
    project: { name: 'demo' },
    triggers: [{ slug: 'nightly', type: 'cron', cron: '0 9 * * *', prompt: 'line one\nline two' }],
    agents: [{ name: 'pr-bot', connectors: ['github'], kortix_cli: ['project.gitops.push'] }],
  };

  for (const format of ['toml', 'yaml'] as const) {
    test(`${format}: object → text → object is stable`, () => {
      const text = serializeManifestObject(obj, format);
      expect(typeof text).toBe('string');
      const back = parseManifestText(text, format);
      expect(back).toEqual(obj);
      // kortix_version emitted first.
      expect(text.trimStart().startsWith('kortix_version')).toBe(true);
    });
  }

  test('empty yaml doc normalizes to {} (validator then reports missing version)', () => {
    expect(parseManifestText('', 'yaml')).toEqual({});
    expect(parseManifestText('# just a comment\n', 'yaml')).toEqual({});
  });
});

describe('validateManifest dual-format', () => {
  const yaml = `kortix_version: 1
project:
  name: demo
triggers:
  - slug: nightly
    type: cron
    cron: "0 9 * * *"
    prompt: do the thing
`;
  const toml = `kortix_version = 1
[project]
name = "demo"
[[triggers]]
slug = "nightly"
type = "cron"
cron = "0 9 * * *"
prompt = "do the thing"
`;

  test('a valid yaml manifest validates like its toml twin', () => {
    const y = validateManifest(yaml, 'yaml');
    const t = validateManifest(toml, 'toml');
    expect(y.valid).toBe(true);
    expect(t.valid).toBe(true);
    expect(y.parsed).toEqual(t.parsed as Record<string, unknown>);
  });

  test('malformed yaml yields a clean error issue, not a throw', () => {
    const res = validateManifest('kortix_version: 1\n  bad: : :\n', 'yaml');
    expect(res.valid).toBe(false);
    expect(res.parsed).toBeNull();
    expect(res.issues[0]?.severity).toBe('error');
  });

  test('a string with no format arg still parses as toml (backward compatible)', () => {
    expect(validateManifest(toml).valid).toBe(true);
  });
});
