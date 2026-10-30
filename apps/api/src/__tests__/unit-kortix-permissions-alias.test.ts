/**
 * `kortix_permissions` is the manifest key for an agent's project permissions.
 * A retired action spelling keeps its exact capability; `kortix_cli` (the key's
 * retired alias) is a validation error: a running project turns that agent off
 * instead of guessing which key wins.
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, grantFromLoadedAgents } from '../projects/agents';
import { parseManifestString, runtimeManifest } from '../projects/triggers';

const manifest = (block: string) => parseManifestString(`default_agent: w\nagents:\n  w:\n${block}`, 'kortix.yaml');

describe('kortix_permissions', () => {
  // project.customize.* was split into one leaf per topic. A manifest that
  // still names the old leaf keeps its exact capability: the enforced grant
  // carries every leaf it covered, and nothing else.
  test('a retired project.customize.write expands to the topic leaves it covered', () => {
    const loaded = extractAgents(manifest('    kortix_permissions: [project.read, project.customize.write]\n'));
    expect(loaded.errors).toEqual([]);
    expect([...(grantFromLoadedAgents('w', loaded)?.permissions as string[])].sort()).toEqual([
      'project.agent.write',
      'project.model.read',
      'project.model.write',
      'project.read',
      'project.sandbox.write',
      'project.settings.write',
    ]);
  });

  test('a retired project.customize.read expands to project.model.read', () => {
    const loaded = extractAgents(manifest('    kortix_permissions: [project.customize.read]\n'));
    expect(grantFromLoadedAgents('w', loaded)?.permissions).toEqual(['project.model.read']);
  });

  test('an ungrantable action drops out; the agent keeps the rest of its grant', () => {
    const loaded = extractAgents(manifest('    kortix_permissions: [billing.read, project.read]\n'));
    expect(loaded.errors).toEqual([]);
    expect(grantFromLoadedAgents('w', loaded)?.permissions).toEqual(['project.read']);
  });

  test('the retired `kortix_cli` key turns the agent off at runtime and grants nothing', () => {
    const applied = runtimeManifest(manifest('    kortix_cli: all\n'));
    expect(applied.issues.map((issue) => issue.path)).toContain('agents.w.kortix_cli');
    const loaded = extractAgents(applied);
    expect(loaded.specs.find((spec) => spec.name === 'w')?.enabled).toBe(false);
    expect(grantFromLoadedAgents('w', loaded)).toEqual({ agent: 'w', permissions: [], connectors: [], env: [] });
  });
});
