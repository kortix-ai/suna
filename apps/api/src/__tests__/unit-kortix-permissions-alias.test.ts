/**
 * `kortix_permissions` is the canonical manifest key for an agent's project
 * permissions; `kortix_cli` is its deprecated alias (spec 2026-09-22
 * agents-as-principals §3). The parser resolves either key to the same
 * `AgentGrant.permissions`. Both keys with different values is a parse error
 * (the agent then fails closed, same as any unparseable entry).
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, grantFromLoadedAgents } from '../projects/agents';
import { parseManifestString } from '../projects/triggers';

const v2 = (block: string) =>
  parseManifestString(`kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n${block}`, 'yaml', 'kortix.yaml');
const v1 = (block: string) =>
  parseManifestString(`kortix_version = 1\n[[agents]]\nname = "w"\n${block}`, 'toml', 'kortix.toml');

describe('kortix_permissions / kortix_cli parse to the same grant', () => {
  test('v2: kortix_permissions and kortix_cli resolve identically', () => {
    const canonical = grantFromLoadedAgents('w', extractAgents(v2('    kortix_permissions: [project.read]\n')));
    const legacy = grantFromLoadedAgents('w', extractAgents(v2('    kortix_cli: [project.read]\n')));
    expect(canonical?.permissions).toEqual(['project.read']);
    expect(legacy).toEqual(canonical);
  });

  test('v1: kortix_permissions and kortix_cli resolve identically', () => {
    const canonical = grantFromLoadedAgents('w', extractAgents(v1('kortix_permissions = "all"\n')));
    const legacy = grantFromLoadedAgents('w', extractAgents(v1('kortix_cli = "all"\n')));
    expect(canonical?.permissions).toBe('all');
    expect(legacy).toEqual(canonical);
  });

  test('v2: both keys identical parse cleanly', () => {
    const loaded = extractAgents(v2('    kortix_permissions: [project.read]\n    kortix_cli: [project.read]\n'));
    expect(loaded.errors).toEqual([]);
    expect(grantFromLoadedAgents('w', loaded)?.permissions).toEqual(['project.read']);
  });

  test('v2: both keys with different values is a parse error', () => {
    const loaded = extractAgents(v2('    kortix_permissions: [project.read]\n    kortix_cli: [project.write]\n'));
    expect(loaded.errors.map((e) => e.name)).toContain('w');
    expect(loaded.specs.map((s) => s.name)).not.toContain('w');
  });

  test('v1: both keys with different values is a parse error', () => {
    const loaded = extractAgents(v1('kortix_permissions = ["project.read"]\nkortix_cli = "all"\n'));
    expect(loaded.errors.map((e) => e.name)).toContain('w');
  });

  test('the ungrantable-action message names kortix_permissions', () => {
    const loaded = extractAgents(v2('    kortix_permissions: [billing.read]\n'));
    expect(loaded.errors[0]?.error).toContain('kortix_permissions');
  });
});
