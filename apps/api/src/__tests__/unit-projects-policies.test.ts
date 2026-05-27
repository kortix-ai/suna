/**
 * Top-level [[policies]] + [policy] parser for kortix.toml. Mirrors the
 * connectors parser shape — collects bad entries into `errors` instead of
 * throwing — and validates the engine vocabulary (action, default_mode).
 */
import { describe, expect, test } from 'bun:test';
import {
  extractProjectPolicies,
  projectPoliciesToTomlEntries,
  projectPolicySettingsToToml,
  type ProjectPolicySpec,
} from '../projects/policies';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function parseFrom(body: string) {
  const m = parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`);
  return extractProjectPolicies(m);
}

describe('extractProjectPolicies — happy paths', () => {
  test('empty manifest → empty list + allow_all default + no errors', () => {
    const r = parseFrom('');
    expect(r.policies).toEqual([]);
    expect(r.settings.defaultMode).toBe('allow_all');
    expect(r.errors).toEqual([]);
  });

  test('parses top-level [[policies]] in declared order', () => {
    const r = parseFrom(`
[[policies]]
match = "*.delete*"
action = "block"

[[policies]]
match = "stripe.*"
action = "require_approval"

[[policies]]
match = "*"
action = "always_run"
`);
    expect(r.policies).toEqual([
      { match: '*.delete*', action: 'block' },
      { match: 'stripe.*', action: 'require_approval' },
      { match: '*', action: 'always_run' },
    ]);
    expect(r.errors).toEqual([]);
  });

  test('[policy].default_mode = "risk" overrides allow_all default', () => {
    const r = parseFrom(`
[policy]
default_mode = "risk"
`);
    expect(r.settings.defaultMode).toBe('risk');
    expect(r.errors).toEqual([]);
  });

  test('[policy].default_mode = "allow_all" parses explicitly', () => {
    const r = parseFrom(`
[policy]
default_mode = "allow_all"
`);
    expect(r.settings.defaultMode).toBe('allow_all');
  });
});

describe('extractProjectPolicies — error cases', () => {
  test('policies = [single-table] is rejected (must be [[policies]])', () => {
    const r = parseFrom(`
[policies]
match = "*"
action = "block"
`);
    // smol-toml parses `[policies]` as an object, not array — parser rejects.
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/`policies` must be an array of tables/);
  });

  test('entry missing match', () => {
    const r = parseFrom(`
[[policies]]
action = "block"
`);
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/missing `match`/);
  });

  test('entry with invalid action', () => {
    const r = parseFrom(`
[[policies]]
match = "*"
action = "skip"
`);
    expect(r.policies).toEqual([]);
    expect(r.errors[0]?.error).toMatch(/action.*must be one of/);
  });

  test('default_mode with invalid value', () => {
    const r = parseFrom(`
[policy]
default_mode = "yolo"
`);
    expect(r.settings.defaultMode).toBe('allow_all'); // unchanged default
    expect(r.errors[0]?.error).toMatch(/default_mode must be one of/);
  });

  test('partial failures still collect good entries', () => {
    const r = parseFrom(`
[[policies]]
match = "good"
action = "block"

[[policies]]
match = ""
action = "block"

[[policies]]
match = "*"
action = "always_run"
`);
    expect(r.policies).toEqual([
      { match: 'good', action: 'block' },
      { match: '*', action: 'always_run' },
    ]);
    expect(r.errors).toHaveLength(1);
  });
});

describe('round-trip serializers', () => {
  test('projectPoliciesToTomlEntries preserves match + action', () => {
    const policies: ProjectPolicySpec[] = [
      { match: '*.delete*', action: 'block' },
      { match: '*', action: 'always_run' },
    ];
    expect(projectPoliciesToTomlEntries(policies)).toEqual([
      { match: '*.delete*', action: 'block' },
      { match: '*', action: 'always_run' },
    ]);
  });

  test('projectPolicySettingsToToml omits the default to keep the file clean', () => {
    expect(projectPolicySettingsToToml({ defaultMode: 'allow_all' })).toBeNull();
    expect(projectPolicySettingsToToml({ defaultMode: 'risk' })).toEqual({ default_mode: 'risk' });
  });
});
