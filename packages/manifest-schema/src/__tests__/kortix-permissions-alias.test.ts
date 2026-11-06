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
  GRANTABLE_KORTIX_WORKSPACE_PERMISSIONS,
  isGrantableKortixPermission,
  LEGACY_TOLERATED_KORTIX_PERMISSIONS,
  validateManifest,
} from '../index';
import { HUMAN_ONLY, WORKSPACE_ACTION_BY_LEGACY, toWorkspaceAction } from '@kortix/shared/workspace-actions';
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

  test('kortix_permissions checks entries against the action catalog', () => {
    const r = summarize(doc('    kortix_permissions: [billing.not_an_action]\n'));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain('agents.w.kortix_permissions[0]');
  });

  test('a former account action is an ordinary grantable workspace action', () => {
    const r = summarize(doc('    kortix_permissions: [billing.read, member.invite, workspace.members.manage]\n'));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('a HUMAN_ONLY action validates with a warning that it grants nothing', () => {
    const r = summarize(doc('    kortix_permissions: [project.read, token.create, workspace.billing.write]\n'));
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.path)).toEqual(['agents.w.kortix_permissions[1]', 'agents.w.kortix_permissions[2]']);
  });
});

describe('kortix_cli — deprecated key', () => {
  test('kortix_cli still grants, as kortix_permissions, with a deprecation warning that names the fix', () => {
    const result = validateManifest(doc('    kortix_cli: [project.read]\n'));
    expect(result.valid).toBe(true);
    expect(result.issues.find((i) => i.path === 'agents.w.kortix_cli')).toMatchObject({ severity: 'warning', fix: 'agent-kortix-cli' });
    expect((result.parsed?.agents as Record<string, Record<string, unknown>>).w!.kortix_permissions).toEqual(['project.read']);
  });

  test('kortix_cli that disagrees with kortix_permissions stays an error', () => {
    const r = summarize(doc('    kortix_cli: [project.read]\n    kortix_permissions: [project.file.read]\n'));
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
  test('kortix_permissions rejects an unknown action', () => {
    expect(validate(parseYaml(doc('    kortix_permissions: [billing.not_an_action]\n')))).toBe(false);
  });
  test('kortix_permissions accepts an administration action and a HUMAN_ONLY one (a warning in the validator)', () => {
    expect(validate(parseYaml(doc('    kortix_permissions: [member.invite, token.create]\n')))).toBe(true);
  });
});

describe('renamed constants', () => {
  test('GRANTABLE_KORTIX_PERMISSIONS is every workspace action except HUMAN_ONLY', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('project.read');
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('member.invite');
    expect(GRANTABLE_KORTIX_PERMISSIONS).toContain('billing.read');
    for (const action of HUMAN_ONLY) expect(GRANTABLE_KORTIX_PERMISSIONS).not.toContain(action);
    expect(GRANTABLE_KORTIX_PERMISSIONS.length).toBe(Object.keys(WORKSPACE_ACTION_BY_LEGACY).length - HUMAN_ONLY.size);
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

describe('kortix_permissions — workspace names (Workspaces, one scope)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validateSchema = ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>);

  test('a workspace name validates with no warning, beside a legacy one', () => {
    const r = summarize(doc('    kortix_permissions: [workspace.session.start, project.read]\n'));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('an administration workspace name is grantable, like its legacy name', () => {
    const r = summarize(doc('    kortix_permissions: [workspace.billing.read]\n'));
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('every grantable action has exactly one workspace name, in the same order', () => {
    expect(GRANTABLE_KORTIX_WORKSPACE_PERMISSIONS).toHaveLength(GRANTABLE_KORTIX_PERMISSIONS.length);
    GRANTABLE_KORTIX_PERMISSIONS.forEach((legacy, i) => {
      expect(GRANTABLE_KORTIX_WORKSPACE_PERMISSIONS[i]).toBe(toWorkspaceAction(legacy));
      expect(isGrantableKortixPermission(GRANTABLE_KORTIX_WORKSPACE_PERMISSIONS[i]!)).toBe(true);
    });
  });

  test('the published JSON Schema accepts the workspace names', () => {
    expect(validateSchema(parseYaml(doc('    kortix_permissions: [workspace.read, workspace.gitops.push]\n')))).toBe(true);
    expect(validateSchema(parseYaml(doc('    kortix_permissions: [workspace.not_an_action]\n')))).toBe(false);
  });
});
