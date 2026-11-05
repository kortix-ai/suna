import { describe, expect, test } from 'bun:test';
import { isManifestSyntaxError, ManifestSyntaxError, manifestCandidatePaths, parseManifestText, serializeManifestObject } from './format';
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
      agents: { a: { prompt: 'x', tools: '*', enabled: false } },
    });
  });

  test('empty yaml doc normalizes to {}', () => {
    expect(parseManifestText('')).toEqual({});
    expect(parseManifestText('# just a comment\n')).toEqual({});
  });
});

describe('parseManifestText on text that is not YAML', () => {
  test('a duplicate key throws ManifestSyntaxError with its line and column', () => {
    const text = 'apps:\n  site:\n    always_on: true\n  site:\n    always_on: false\n';
    let thrown: unknown;
    try {
      parseManifestText(text);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManifestSyntaxError);
    expect(isManifestSyntaxError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'manifest_invalid', line: 4, column: 3 });
    expect((thrown as Error).message).toContain('Map keys must be unique');
  });

  test('a bare * throws with the quoted fix: YAML reads it as an alias', () => {
    let thrown: unknown;
    try {
      parseManifestText('agents:\n  a:\n    prompt: x\n    tools: *\n');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'manifest_invalid', line: 4, column: 12 });
    expect((thrown as Error).message).toBe('Alias cannot be an empty string at line 4, column 12: YAML reads a bare `*` as an alias. Quote it: `tools: "*"`');
    expect(() => parseManifestText('agents:\n  a:\n    skills: [*]\n')).toThrow('Quote it: `skills: ["*"]`');
    // The hint quotes the source line: no terminal control character, at most 120 characters (Strix, PR #11853).
    let escaped: unknown;
    try {
      parseManifestText(`agents:\n  a:\n    tools: * # \u001b]0;pwned\u0007\u001b[2J${'x'.repeat(300)}\n`);
    } catch (err) {
      escaped = err;
    }
    const hint = (escaped as Error).message.split('Quote it: ')[1]!;
    expect(hint).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(hint.length).toBeLessThanOrEqual(124);
    expect(hint.startsWith('`tools: "*" #')).toBe(true);
  });

  test('isManifestSyntaxError is false for any other error', () => {
    expect(isManifestSyntaxError(new Error('git fetch failed'))).toBe(false);
    expect(isManifestSyntaxError(null)).toBe(false);
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
