/**
 * Parser-level tests for the per-agent scoping overlay: the `agents:` name →
 * block map of kortix.yaml. Covers the kortix_permissions enum handling
 * (grantable project actions pass; account-scoped + unknown drop out), the
 * grant-set forms ("all"/"none"/[]/"*"), sandbox resolution, and the
 * rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, GRANTABLE_KORTIX_PERMISSIONS, sandboxFromLoadedAgents } from '../projects/agents';
import { parseManifestString } from '../projects/triggers';
import { GRANTABLE_KORTIX_PERMISSIONS as SCHEMA_GRANTABLE_KORTIX_PERMISSIONS } from '@kortix/manifest-schema';

function parseAgents(agentsBody: string, opts: { defaultAgent?: string } = {}) {
  const text = [
    `default_agent: ${opts.defaultAgent ?? 'support'}`,
    'project:',
    '  name: test',
    'agents:',
    agentsBody,
  ].join('\n');
  return extractAgents(parseManifestString(text, 'kortix.yaml'));
}

describe('agents — grantable enum drift guard', () => {
  // The enum is necessarily duplicated: manifest-schema is a standalone package
  // and can't import apps/api's iam/actions. This test fails loudly if they drift.
  test('API GRANTABLE_KORTIX_PERMISSIONS === manifest-schema GRANTABLE_KORTIX_PERMISSIONS', () => {
    expect([...SCHEMA_GRANTABLE_KORTIX_PERMISSIONS].sort()).toEqual([...GRANTABLE_KORTIX_PERMISSIONS].sort());
  });

  // The exact size pins the catalog down so a silent addition/removal on
  // either side is caught even if it happens to keep the two sides equal to
  // EACH OTHER but wrong in absolute terms (both sides sourced from the same
  // stale copy-paste, say).
  test('56 grantable project actions (all of PROJECT_ACTIONS)', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.size).toBe(56);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.artifact.comment')).toBe(true);
  });

  // The git ref leaves are grantable on purpose: a project that WANTS an agent
  // pushing beyond its own branch says so in `kortix_permissions`. The session -> own
  // branch binding itself is not here, and must never be — it is the
  // credential's identity, not a permission (see git-proxy/ref-policy.ts).
  test('the git ref-authority leaves are grantable', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.gitops.ref.any')).toBe(true);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.gitops.ref.delete')).toBe(true);
  });

  // The three manager-tier project leaves are reachable via a project's
  // `manager` role, so they're grantable to an agent too.
  test('the three manager-tier project leaves are included in the grantable set', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.delete')).toBe(true);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.members.manage')).toBe(true);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.gateway.keys.manage')).toBe(true);
  });
});

describe('agents — the 3 manager-tier project leaves are grantable, not rejected', () => {
  for (const action of ['project.delete', 'project.members.manage', 'project.gateway.keys.manage']) {
    test(`kortix_permissions: [${action}] is accepted`, () => {
      const { specs, errors } = parseAgents(`  a:\n    kortix_permissions: [${action}]\n`);
      expect(errors).toEqual([]);
      expect(specs).toHaveLength(1);
      expect(specs[0].permissions).toEqual([action]);
    });
  }
});

describe('agents — kortix_permissions enum enforcement', () => {
  test('every project connector action is grantable', () => {
    const { specs, errors } = parseAgents('  a:\n    kortix_permissions: [project.connector.write, project.connector.read]\n');
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.connector.write', 'project.connector.read']);
  });

  // An ungrantable entry drops out on its own. Failing the whole entry gave the
  // agent an EMPTY grant on every dimension, connectors and secrets included.
  test('channel.* actions are no longer grantable (removed dead catalog leaves)', () => {
    const { specs, errors } = parseAgents('  a:\n    kortix_permissions: [channel.send, project.file.read]\n    connectors: all\n');
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.file.read']);
    expect(specs[0].connectors).toBe('all');
  });

  test('account-scoped actions (member.invite, project.create) are dropped, never granted', () => {
    const { specs, errors } = parseAgents('  a:\n    kortix_permissions: [member.invite, project.create]\n');
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual([]);
  });

  test('unknown action is dropped, the rest of the list stays', () => {
    const { specs, errors } = parseAgents('  a:\n    kortix_permissions: [project.frobnicate, project.file.read]\n');
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.file.read']);
  });

  // `project.cr.open` / `project.cr.merge` are OUT of the live catalog: spec
  // §2.4 collapsed them into the gitops leaves. They remain ACCEPTED on input
  // as renamed aliases, so no existing manifest breaks.
  test('the renamed CR actions are NOT in the grantable catalog', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.cr.open')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.cr.merge')).toBe(false);
  });

  test('a renamed action still PARSES, so an old manifest keeps its grant', () => {
    const { specs, errors } = parseAgents('  a:\n    kortix_permissions: [project.cr.open, project.trigger.create]\n');
    expect(errors).toEqual([]);
    expect(specs[0]!.permissions).toEqual(['project.cr.open', 'project.trigger.create']);
  });

  test('account actions are NOT in the grantable set', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('member.invite')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('billing.write')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.create')).toBe(false);
  });
});

describe('agents — `agents:` map', () => {
  test('a plain agent block, no grants declared → deny-by-default', () => {
    const { specs, errors } = parseAgents(`
  support:
    description: "Handles support"
    mode: primary
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      name: 'support',
      path: 'kortix.yaml#agents.support',
      enabled: true,
      connectors: [],
      permissions: [],
      env: [],
    });
  });

  test('connectors/kortix_permissions/secrets lists resolve via resolveGrantSet; `secrets` maps onto AgentSpec.env', () => {
    const { specs, errors } = parseAgents(`
  support:
    connectors: [github, slack]
    kortix_permissions: [project.trigger.create, project.cr.open]
    secrets: [STRIPE_KEY, GH_TOKEN]
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toEqual(['github', 'slack']);
    expect(specs[0].permissions).toEqual(['project.trigger.create', 'project.cr.open']);
    expect(specs[0].env).toEqual(['STRIPE_KEY', 'GH_TOKEN']);
  });

  test('sandbox is parsed and resolved for concrete and default agent names', () => {
    const loaded = parseAgents(`
  support:
    sandbox: ml
  fallback: {}
`, { defaultAgent: 'support' });
    expect(loaded.errors).toEqual([]);
    expect(loaded.specs.find((spec) => spec.name === 'support')?.sandbox).toBe('ml');
    expect(sandboxFromLoadedAgents('support', loaded)).toBe('ml');
    expect(sandboxFromLoadedAgents('default', loaded)).toBe('ml');
    expect(sandboxFromLoadedAgents('fallback', loaded)).toBeNull();
  });

  test('"all" / "none" string forms', () => {
    const { specs } = parseAgents(`
  support:
    connectors: all
    kortix_permissions: none
    secrets: all
`);
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].permissions).toEqual([]);
    expect(specs[0].env).toBe('all');
  });

  test('`enabled: false` maps to enabled=false; omitted/true stays enabled', () => {
    const { specs } = parseAgents(`
  support:
    enabled: false
  other:
    description: "another agent"
`, { defaultAgent: 'other' });
    expect(specs.find((s) => s.name === 'support')!.enabled).toBe(false);
    expect(specs.find((s) => s.name === 'other')!.enabled).toBe(true);
  });

  test('an ungrantable kortix_permissions action drops out; the other grants stay', () => {
    const { specs, errors } = parseAgents(`
  support:
    kortix_permissions: [member.invite, project.file.read]
    connectors: all
    secrets: all
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.file.read']);
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].env).toBe('all');
  });

  // "*" and "all" are synonyms in every grant field, alone or inside a list.
  // ["*", leaf] used to fail the entry and zero every grant of the agent.
  test.each([
    ['"*"'], ['all'], ['["*"]'], ['["*", project.gitops.merge]'], ['[project.file.read, "*"]'],
  ])('kortix_permissions: %s resolves to all, and so do connectors/secrets/apps', (value) => {
    const { specs, errors } = parseAgents(`
  support:
    kortix_permissions: ${value}
    connectors: ${value.replace('project.gitops.merge', 'github').replace('project.file.read', 'github')}
    secrets: ${value.replace('project.gitops.merge', 'A').replace('project.file.read', 'A')}
    apps: ${value.replace('project.gitops.merge', 'app').replace('project.file.read', 'app')}
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toBe('all');
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].env).toBe('all');
    expect(specs[0].apps).toBe('all');
  });

  test('an invalid agent name (map key) is rejected', () => {
    const { errors } = parseAgents(`
  "Bad Name":
    description: "x"
`, { defaultAgent: 'support' });
    expect(errors[0]?.error).toContain('Invalid agent name');
  });

  test('`agents` as a list is rejected with a map-shape error', () => {
    const text = ['default_agent: support', 'agents:', '  - name: support'].join('\n');
    const { specs, errors } = extractAgents(parseManifestString(text, 'kortix.yaml'));
    expect(specs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('must be a map of agent name');
    expect(errors[0].path).toBe('kortix.yaml');
  });

  test('a `kortix.yml` manifest names its own file in spec paths', () => {
    const { specs } = extractAgents(parseManifestString('agents:\n  a: {}\n', 'kortix.yml'));
    expect(specs[0]?.path).toBe('kortix.yml#agents.a');
  });

  test('the manifest\'s top-level `default_agent` is captured on LoadedAgents', () => {
    const loaded = parseAgents(`
  support:
    description: "x"
`, { defaultAgent: 'support' });
    expect(loaded.defaultAgent).toBe('support');
    expect(extractAgents(parseManifestString('agents:\n  a: {}\n')).defaultAgent).toBeNull();
  });
});
