import { describe, expect, test } from 'bun:test';

import { extractYamlFragment, splitFragmentPath, toArray } from './utils';

describe('toArray — guards .filter/.map call sites against undefined / non-array config fields', () => {
  // Regression for the Better Stack cluster in chunk 22256:
  //   - `Cannot read properties of undefined (reading 'map')`  (config.skills.map)
  //   - `(intermediate value)(intermediate value)(intermediate value).filter is not a function`
  //     (a `(x ?? []).filter` where the prod build downlevels `??` to a ternary
  //     and `x` is a defined non-array object)
  // `ProjectConfigSummary.{agents,skills,commands}` are typed as required
  // arrays, but the API returns them as `undefined` (or a non-array) for
  // repo-less / capability-gated / config-build-failure states. Calling
  // `.filter` / `.map` directly throws into prod Sentry; `toArray` must absorb
  // every one of those shapes without throwing.

  test('undefined -> [] (the "reading \'map\'" case)', () => {
    expect(toArray(undefined)).toEqual([]);
  });

  test('null -> []', () => {
    expect(toArray(null)).toEqual([]);
  });

  test('non-array object -> [] (the "filter is not a function" case)', () => {
    // A defined-but-non-array value: `value ?? []` returns the object itself,
    // so `.filter` would throw. `Array.isArray` is the only correct guard.
    expect(toArray({})).toEqual([]);
    expect(toArray({ agents: [] })).toEqual([]);
    expect(toArray('not-an-array')).toEqual([]);
    expect(toArray(42)).toEqual([]);
  });

  test('a real array passes through unchanged', () => {
    const agents = [{ name: 'default', path: 'a', description: null }];
    expect(toArray(agents)).toBe(agents);
    expect(toArray([])).toEqual([]);
  });

  test('does not throw when chaining .filter / .map on every bad shape', () => {
    for (const bad of [undefined, null, {}, { agents: [] }, 'x', 0, false]) {
      expect(() => toArray(bad).filter(Boolean)).not.toThrow();
      expect(() => toArray(bad).map((x) => x)).not.toThrow();
    }
  });
});

describe('splitFragmentPath', () => {
  test('splits a manifest fragment path into file + dotted fragment', () => {
    expect(splitFragmentPath('kortix.yaml#agents.claude')).toEqual({
      file: 'kortix.yaml',
      fragment: 'agents.claude',
    });
    expect(splitFragmentPath('kortix.toml#agents.build')).toEqual({
      file: 'kortix.toml',
      fragment: 'agents.build',
    });
  });

  test('a plain file path is not a fragment path', () => {
    expect(splitFragmentPath('.kortix/skills/review/SKILL.md')).toBeNull();
    expect(splitFragmentPath('kortix.yaml')).toBeNull();
    expect(splitFragmentPath('#agents.claude')).toBeNull();
    expect(splitFragmentPath('kortix.yaml#')).toBeNull();
  });
});

describe('extractYamlFragment', () => {
  const MANIFEST = [
    'kortix_version: 3',
    '',
    'agents:',
    '  claude:',
    '    runtime: claude',
    '    secrets: all',
    '',
    '    connectors: none',
    '  build:',
    '    runtime: opencode',
    '',
    'runtimes:',
    '  claude:',
    '    harness: claude',
    '',
  ].join('\n');

  test('slices the named nested block, keeping its header line and children', () => {
    expect(extractYamlFragment(MANIFEST, 'agents.claude')).toBe(
      ['  claude:', '    runtime: claude', '    secrets: all', '', '    connectors: none'].join(
        '\n',
      ),
    );
  });

  test('a later sibling block ends at the next top-level key', () => {
    expect(extractYamlFragment(MANIFEST, 'agents.build')).toBe(
      ['  build:', '    runtime: opencode'].join('\n'),
    );
  });

  test('a top-level fragment slices the whole section', () => {
    expect(extractYamlFragment(MANIFEST, 'runtimes')).toBe(
      ['runtimes:', '  claude:', '    harness: claude'].join('\n'),
    );
  });

  test('unknown fragments return null instead of guessing', () => {
    expect(extractYamlFragment(MANIFEST, 'agents.ghost')).toBeNull();
    expect(extractYamlFragment(MANIFEST, 'nope.claude')).toBeNull();
    expect(extractYamlFragment('', 'agents.claude')).toBeNull();
  });
});
