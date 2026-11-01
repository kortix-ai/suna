/**
 * `kortix_permissions` is the manifest key for an agent's project permissions.
 * A retired action spelling keeps its exact capability; `kortix_cli` (the key's
 * old name) is the deprecation `agent-kortix-cli`: it reads as
 * `kortix_permissions`, and the agent keeps its grant.
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

  test('the old `kortix_cli` key reads as `kortix_permissions`: the agent stays on with its grant', () => {
    const applied = runtimeManifest(manifest('    tools: all\n    kortix_cli: [project.read]\n'));
    // The reader already holds the latest shape; the warning is in the file's health, not here.
    expect(applied.raw.agents).toEqual({ w: { tools: 'all', kortix_permissions: ['project.read'] } });
    expect(applied.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const loaded = extractAgents(applied);
    expect(loaded.specs.find((spec) => spec.name === 'w')?.enabled).not.toBe(false);
    expect(grantFromLoadedAgents('w', loaded)?.permissions).toEqual(['project.read']);
  });
});
