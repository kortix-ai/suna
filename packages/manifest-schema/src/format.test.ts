import { describe, expect, test } from 'bun:test';
import { manifestCandidatePaths, parseManifestText, serializeManifestObject } from './format';
import { validateManifest } from './index';

describe('manifestCandidatePaths', () => {
  test('default → yaml, then yml', () => {
    expect(manifestCandidatePaths(undefined)).toEqual(['kortix.yaml', 'kortix.yml']);
    expect(manifestCandidatePaths('')).toEqual(manifestCandidatePaths(undefined));
  });

  test('a custom path resolves its yaml/yml siblings (dir preserved)', () => {
    expect(manifestCandidatePaths('config/kortix.yaml')).toEqual(['config/kortix.yaml', 'config/kortix.yml']);
  });

  test('a configured .toml path maps to its .yaml sibling', () => {
    expect(manifestCandidatePaths('config/kortix.toml')).toEqual(['config/kortix.yaml', 'config/kortix.yml']);
  });
});

describe('parse/serialize round-trip', () => {
  const obj = {
    project: { name: 'demo' },
    triggers: [{ slug: 'nightly', type: 'cron', cron: '0 9 * * *', prompt: 'line one\nline two' }],
    agents: { 'pr-bot': { connectors: ['github'], kortix_permissions: ['project.gitops.push'], tools: 'all' } },
  };

  test('object → text → object is stable', () => {
    const text = serializeManifestObject(obj);
    expect(parseManifestText(text)).toEqual(obj);
  });

  test('a deprecated shape reads as the latest shape', () => {
    expect(parseManifestText('kortix_version: 3\nagents:\n  a:\n    prompt: x\n    disable: true\n')).toEqual({
      agents: { a: { prompt: 'x', tools: 'all', enabled: false } },
    });
  });

  test('empty yaml doc normalizes to {}', () => {
    expect(parseManifestText('')).toEqual({});
    expect(parseManifestText('# just a comment\n')).toEqual({});
  });
});

describe('validateManifest', () => {
  test('a valid yaml manifest validates', () => {
    const res = validateManifest(`project:
  name: demo
triggers:
  - slug: nightly
    type: cron
    cron: "0 9 * * *"
    prompt: do the thing
`);
    expect(res.valid).toBe(true);
    expect(res.issues).toEqual([]);
  });

  test('malformed yaml yields a clean error issue, not a throw', () => {
    const res = validateManifest('project:\n  bad: : :\n');
    expect(res.valid).toBe(false);
    expect(res.parsed).toBeNull();
    expect(res.issues[0]?.severity).toBe('error');
  });
});
