import { describe, expect, test } from 'bun:test';
import { HARNESSES } from '@kortix/shared';
import { type FileTreeEntry, validateHarnessConfig } from './harness-config-validate';

const VALID_AGENT_MD = '---\nmode: primary\nmodel: anthropic/claude-sonnet-5\n---\n\nYou are the reviewer.';
const MALFORMED_AGENT_MD = '---\n: : : not yaml\n\tbad-indent: [unclosed\n---\nbody';

describe('validateHarnessConfig — all harnesses', () => {
  for (const harness of HARNESSES ? (Object.keys(HARNESSES) as (keyof typeof HARNESSES)[]) : []) {
    test(`${harness}: empty configDir produces exactly one issue`, () => {
      const issues = validateHarnessConfig(harness, HARNESSES[harness].configDir, []);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        harness,
        path: HARNESSES[harness].configDir,
        message: 'config directory is empty or missing',
      });
    });

    test(`${harness}: empty-dir severity matches stability (${HARNESSES[harness].stability})`, () => {
      const issues = validateHarnessConfig(harness, HARNESSES[harness].configDir, []);
      const expected = HARNESSES[harness].stability === 'stable' ? 'error' : 'warning';
      expect(issues[0].severity).toBe(expected);
    });
  }
});

describe('validateHarnessConfig — opencode (.kortix/opencode)', () => {
  const configDir = '.kortix/opencode';

  test('a config dir with only presence entries is valid: []', () => {
    const files: FileTreeEntry[] = [
      { path: `${configDir}/agent` },
      { path: `${configDir}/agent/reviewer.md`, content: VALID_AGENT_MD },
    ];
    expect(validateHarnessConfig('opencode', configDir, files)).toEqual([]);
  });

  test('valid opencode.json + valid agents/*.md is []', () => {
    const files: FileTreeEntry[] = [
      { path: `${configDir}/opencode.json`, content: '{"model": "anthropic/claude-sonnet-5"}' },
      { path: `${configDir}/agents/writer.md`, content: VALID_AGENT_MD },
    ];
    expect(validateHarnessConfig('opencode', configDir, files)).toEqual([]);
  });

  test('malformed agent/*.md frontmatter produces an issue with path + parser error', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/agent/broken.md`, content: MALFORMED_AGENT_MD }];
    const issues = validateHarnessConfig('opencode', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe(`${configDir}/agent/broken.md`);
    expect(issues[0].message).toContain('agent frontmatter failed to parse');
    // opencode is 'stable' — parse failures are errors, not warnings.
    expect(issues[0].severity).toBe('error');
  });

  test('a body-only agent .md (no frontmatter fence) is valid — not a parse failure', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/agent/plain.md`, content: 'Just a system prompt.' }];
    expect(validateHarnessConfig('opencode', configDir, files)).toEqual([]);
  });

  test('malformed opencode.json produces an issue with path + parser error', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/opencode.json`, content: '{ not: valid json' }];
    const issues = validateHarnessConfig('opencode', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe(`${configDir}/opencode.json`);
    expect(issues[0].message).toContain('not valid JSON');
    expect(issues[0].severity).toBe('error');
  });

  test('an unrelated file under configDir is ignored (no false positive)', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/notes.txt`, content: 'anything goes here [[[' }];
    expect(validateHarnessConfig('opencode', configDir, files)).toEqual([]);
  });
});

describe('validateHarnessConfig — claude (.claude)', () => {
  const configDir = '.claude';

  test('a config dir with only CLAUDE.md is valid: []', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/CLAUDE.md`, content: '# Instructions' }];
    expect(validateHarnessConfig('claude', configDir, files)).toEqual([]);
  });

  test('valid settings.json + valid agents/*.md is []', () => {
    const files: FileTreeEntry[] = [
      { path: `${configDir}/settings.json`, content: '{"permissions": {}}' },
      { path: `${configDir}/agents/reviewer.md`, content: VALID_AGENT_MD },
    ];
    expect(validateHarnessConfig('claude', configDir, files)).toEqual([]);
  });

  test('malformed settings.json produces an issue with path + parser error, severity warning (experimental)', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/settings.json`, content: '{ broken' }];
    const issues = validateHarnessConfig('claude', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ harness: 'claude', path: `${configDir}/settings.json`, severity: 'warning' });
    expect(issues[0].message).toContain('not valid JSON');
  });

  test('settings.json that parses but is not an object produces an issue', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/settings.json`, content: '[1, 2, 3]' }];
    const issues = validateHarnessConfig('claude', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('must be a JSON object');
  });

  test('malformed agents/*.md frontmatter (YAML-fence-parses check only) produces an issue', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/agents/broken.md`, content: MALFORMED_AGENT_MD }];
    const issues = validateHarnessConfig('claude', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe(`${configDir}/agents/broken.md`);
    expect(issues[0].severity).toBe('warning');
  });
});

describe('validateHarnessConfig — codex (.codex)', () => {
  const configDir = '.codex';

  test('a config dir with only presence entries is valid: []', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/AGENTS.md`, content: 'notes' }];
    expect(validateHarnessConfig('codex', configDir, files)).toEqual([]);
  });

  test('valid config.toml is []', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/config.toml`, content: 'model = "gpt-5-codex"\n' }];
    expect(validateHarnessConfig('codex', configDir, files)).toEqual([]);
  });

  test('malformed config.toml produces an issue with path + parser error, severity warning (experimental)', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/config.toml`, content: 'this is not = = toml [[[' }];
    const issues = validateHarnessConfig('codex', configDir, files);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ harness: 'codex', path: `${configDir}/config.toml`, severity: 'warning' });
    expect(issues[0].message).toContain('not valid TOML');
  });
});

describe('validateHarnessConfig — pi (.pi)', () => {
  const configDir = '.pi';

  test('presence-only: any non-empty dir is valid regardless of content', () => {
    const files: FileTreeEntry[] = [{ path: `${configDir}/whatever.json`, content: '{ not even valid json' }];
    expect(validateHarnessConfig('pi', configDir, files)).toEqual([]);
  });

  test('empty dir still produces the one presence issue, severity warning (experimental)', () => {
    const issues = validateHarnessConfig('pi', configDir, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });
});

describe('validateHarnessConfig — purity', () => {
  test('never mutates the input files array or its entries', () => {
    const files: FileTreeEntry[] = [{ path: '.codex/config.toml', content: 'broken [[[' }];
    const snapshot = JSON.parse(JSON.stringify(files));
    validateHarnessConfig('codex', '.codex', files);
    expect(files).toEqual(snapshot);
  });

  test('same input always produces the same output (no hidden state)', () => {
    const files: FileTreeEntry[] = [{ path: '.claude/settings.json', content: '{ broken' }];
    const first = validateHarnessConfig('claude', '.claude', files);
    const second = validateHarnessConfig('claude', '.claude', files);
    expect(first).toEqual(second);
  });
});
