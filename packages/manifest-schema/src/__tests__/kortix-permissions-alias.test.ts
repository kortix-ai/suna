/**
 * `kortix_permissions` is the canonical name of an agent's project-permission
 * grant (spec 2026-09-22 agents-as-principals §3). `kortix_cli` is the
 * pre-rename spelling: still accepted, but flagged with a deprecation warning.
 * Both keys on one agent must agree — different values is an error.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import {
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  GRANTABLE_KORTIX_PERMISSIONS,
  LEGACY_TOLERATED_KORTIX_PERMISSIONS,
  validateManifest,
} from '../index';
import { KORTIX_JSON_SCHEMA } from '../json-schema';

function summarize(input: string, format: 'toml' | 'yaml') {
  const result = validateManifest(input, format);
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  return { valid: result.valid, errors, warnings };
}

const v2 = (block: string) => `kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n${block}`;
const v1 = (block: string) => `kortix_version = 1\n[[agents]]\nname = "w"\n${block}`;

describe('kortix_permissions — canonical key', () => {
  test('v2: kortix_permissions validates with no warnings', () => {
    const r = summarize(v2('    kortix_permissions: [project.read]\n'), 'yaml');
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('v1: kortix_permissions validates with no warnings', () => {
    const r = summarize(v1('kortix_permissions = ["project.read"]\n'), 'toml');
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('v2: kortix_permissions checks entries against the grantable catalog', () => {
    const r = summarize(v2('    kortix_permissions: [billing.read]\n'), 'yaml');
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain('agents.w.kortix_permissions[0]');
  });
});

describe('kortix_cli — deprecated alias', () => {
  test('v2: kortix_cli alone is valid with a deprecation warning', () => {
    const r = summarize(v2('    kortix_cli: [project.read]\n'), 'yaml');
    expect(r.valid).toBe(true);
    const w = r.warnings.find((i) => i.path === 'agents.w.kortix_cli');
    expect(w?.message).toContain('kortix_permissions');
  });

  test('v1: kortix_cli alone is valid with a deprecation warning', () => {
    const r = summarize(v1('kortix_cli = ["project.read"]\n'), 'toml');
    expect(r.valid).toBe(true);
    expect(r.warnings.map((i) => i.path)).toContain('agents[0].kortix_cli');
  });

  test('v2: both keys with identical values is a warning, not an error', () => {
    const r = summarize(
      v2('    kortix_permissions: [project.read, project.write]\n    kortix_cli: [project.write, project.read]\n'),
      'yaml',
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((i) => i.path)).toContain('agents.w.kortix_cli');
  });

  test('v2: both keys with different values is an error', () => {
    const r = summarize(
      v2('    kortix_permissions: [project.read]\n    kortix_cli: [project.write]\n'),
      'yaml',
    );
    expect(r.valid).toBe(false);
    expect(r.errors.map((i) => i.path)).toContain('agents.w.kortix_cli');
  });

  test('v1: both keys with different values is an error', () => {
    const r = summarize(v1('kortix_permissions = "all"\nkortix_cli = "none"\n'), 'toml');
    expect(r.valid).toBe(false);
    expect(r.errors.map((i) => i.path)).toContain('agents[0].kortix_cli');
  });

  test('v1: both keys "all" (case-insensitive) agree', () => {
    const r = summarize(v1('kortix_permissions = "all"\nkortix_cli = "ALL"\n'), 'toml');
    expect(r.valid).toBe(true);
  });
});

describe('published JSON Schema accepts the canonical key', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>);

  test('v2 kortix_permissions', () => {
    expect(validate(parseYaml(v2('    kortix_permissions: [project.read]\n')))).toBe(true);
  });
  test('v1 kortix_permissions', () => {
    expect(validate(parseToml(v1('kortix_permissions = ["project.read"]\n')))).toBe(true);
  });
  test('v2 kortix_permissions rejects a non-grantable action', () => {
    expect(validate(parseYaml(v2('    kortix_permissions: [billing.read]\n')))).toBe(false);
  });
});

describe('renamed constants', () => {
  test('GRANTABLE_KORTIX_PERMISSIONS is the project.* catalog', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.read');
    expect(GRANTABLE_KORTIX_PERMISSIONS.every((a) => a.startsWith('project.'))).toBe(true);
  });
  test('alias tables are exported under the new names', () => {
    expect(DEPRECATED_KORTIX_PERMISSION_ALIASES['project.cr.open']).toBe('project.gitops.push');
    expect(LEGACY_TOLERATED_KORTIX_PERMISSIONS).toContain('project.schedule.read');
  });
});
