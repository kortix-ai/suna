/**
 * `kortix_permissions` is the name of an agent's project-permission grant
 * (spec 2026-09-22 agents-as-principals §3). `kortix_cli` is the retired
 * spelling: an error.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';
import {
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  GRANTABLE_KORTIX_PERMISSIONS,
  LEGACY_TOLERATED_KORTIX_PERMISSIONS,
  validateManifest,
} from '../index';
import { KORTIX_JSON_SCHEMA } from '../json-schema';

function summarize(input: string) {
  const result = validateManifest(input);
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  return { valid: result.valid, errors, warnings };
}

const doc = (block: string) => `default_agent: w\nagents:\n  w:\n    prompt: Help.\n    tools: all\n${block}`;

describe('kortix_permissions — canonical key', () => {
  test('kortix_permissions validates with no warnings', () => {
    const r = summarize(doc('    kortix_permissions: [project.read]\n'));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('kortix_permissions checks entries against the grantable catalog', () => {
    const r = summarize(doc('    kortix_permissions: [billing.read]\n'));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain('agents.w.kortix_permissions[0]');
  });
});

describe('kortix_cli — retired key', () => {
  test('kortix_cli is an error that names kortix_permissions', () => {
    const r = summarize(doc('    kortix_cli: [project.read]\n'));
    expect(r.valid).toBe(false);
    expect(r.errors.find((i) => i.path === 'agents.w.kortix_cli')?.message).toContain('kortix_permissions');
  });
});

describe('published JSON Schema accepts the canonical key', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>);

  test('kortix_permissions', () => {
    expect(validate(parseYaml(doc('    kortix_permissions: [project.read]\n')))).toBe(true);
  });
  test('kortix_permissions rejects a non-grantable action', () => {
    expect(validate(parseYaml(doc('    kortix_permissions: [billing.read]\n')))).toBe(false);
  });
});

describe('renamed constants', () => {
  test('GRANTABLE_KORTIX_PERMISSIONS is the project.* catalog', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.read');
    expect(GRANTABLE_KORTIX_PERMISSIONS.every((a) => a.startsWith('project.'))).toBe(true);
  });
  test('alias tables are exported under the new names', () => {
    expect(DEPRECATED_KORTIX_PERMISSION_ALIASES['project.cr.open']).toEqual(['project.gitops.push']);
    // One-to-many: the retired umbrella leaf expands to one leaf per topic.
    expect(DEPRECATED_KORTIX_PERMISSION_ALIASES['project.customize.write']).toEqual([
      'project.settings.write',
      'project.sandbox.write',
      'project.model.read',
      'project.model.write',
      'project.agent.write',
    ]);
    expect(LEGACY_TOLERATED_KORTIX_PERMISSIONS).toContain('project.schedule.read');
  });
});
