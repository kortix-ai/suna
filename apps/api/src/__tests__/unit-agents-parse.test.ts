/**
 * Parser-level tests for the per-agent scoping overlay (name + connectors +
 * kortix_permissions): the legacy v1 `[[agents]]` TOML array (kortix.toml) and the v2
 * `agents:` name-keyed map (kortix.yaml). Covers happy paths, the kortix_permissions
 * enum validation (grantable project actions pass; account-scoped + unknown
 * rejected), the grant-set forms ("all"/"none"/[]/"*"), the round-trip, and the
 * rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyAgentScope,
  extractAgents,
  GRANTABLE_KORTIX_PERMISSIONS,
  sandboxFromLoadedAgents,
} from '../projects/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';
import { GRANTABLE_KORTIX_PERMISSIONS as SCHEMA_GRANTABLE_KORTIX_PERMISSIONS } from '@kortix/manifest-schema';

const MIN_PROJECT = `
[project]
name = "test"
`;

function manifestWith(body: string): string {
  return [`kortix_version = ${KNOWN_SCHEMA_VERSION}`, MIN_PROJECT, body].join('\n');
}

function parse(body: string) {
  return extractAgents(parseManifestString(manifestWith(body)));
}

describe('[[agents]] — grantable enum drift guard', () => {
  // The enum is necessarily duplicated: manifest-schema is a standalone package
  // and can't import apps/api's iam/actions. This test fails loudly if they drift.
  test('API GRANTABLE_KORTIX_PERMISSIONS === manifest-schema GRANTABLE_KORTIX_PERMISSIONS', () => {
    expect([...SCHEMA_GRANTABLE_KORTIX_PERMISSIONS].sort()).toEqual([...GRANTABLE_KORTIX_PERMISSIONS].sort());
  });

  // The exact size pins the catalog down so a silent addition/removal on
  // either side is caught even if it happens to keep the two sides equal to
  // EACH OTHER but wrong in absolute terms (both sides sourced from the same
  // stale copy-paste, say).
  test('50 grantable project actions (all of PROJECT_ACTIONS)', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.size).toBe(50);
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

describe('[[agents]] — the 3 manager-tier project leaves are grantable, not rejected', () => {
  for (const action of ['project.delete', 'project.members.manage', 'project.gateway.keys.manage']) {
    test(`kortix_permissions = ["${action}"] is accepted`, () => {
      const { specs, errors } = parse(`\n[[agents]]\nname = "a"\nkortix_permissions = ["${action}"]\n`);
      expect(errors).toEqual([]);
      expect(specs).toHaveLength(1);
      expect(specs[0].permissions).toEqual([action]);
    });
  }
});

describe('[[agents]] — happy paths', () => {
  test('name only → default-deny (no connectors, no kortix_permissions)', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "release-bot"
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      name: 'release-bot',
      enabled: true,
      connectors: [],
      permissions: [],
      file: null,
    });
  });

  test('connectors list + kortix_permissions list of grantable project actions', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "release-bot"
connectors = ["github", "stripe-readonly"]
kortix_permissions = ["project.trigger.create", "project.cr.open"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toEqual(['github', 'stripe-readonly']);
    expect(specs[0].permissions).toEqual(['project.trigger.create', 'project.cr.open']);
  });

  test('"all" grants everything; default kortix agent shape', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "kortix"
connectors = "all"
kortix_permissions = "all"
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].permissions).toBe('all');
  });

  test('"*" inside a list collapses to "all"', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "kortix"
kortix_permissions = ["*"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toBe('all');
  });

  test('"none" and [] are equivalent (explicit deny)', () => {
    const { specs } = parse(`
[[agents]]
name = "a"
connectors = "none"
[[agents]]
name = "b"
connectors = []
`);
    expect(specs.find((s) => s.name === 'a')!.connectors).toEqual([]);
    expect(specs.find((s) => s.name === 'b')!.connectors).toEqual([]);
  });

  test('file override + enabled=false', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "triage"
enabled = false
file = ".claude/agents/triage.md"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ enabled: false, file: '.claude/agents/triage.md' });
  });

  test('duplicate kortix_permissions entries are de-duplicated', () => {
    const { specs } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["project.read", "project.read", "project.trigger.create"]
`);
    expect(specs[0].permissions).toEqual(['project.read', 'project.trigger.create']);
  });
});

describe('[[agents]] — kortix_permissions enum enforcement', () => {
  test('every project connector action is grantable', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["project.connector.write", "project.connector.read"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.connector.write', 'project.connector.read']);
  });

  // An ungrantable entry drops out on its own. Failing the whole entry gave the
  // agent an EMPTY grant on every dimension, connectors and secrets included.
  test('channel.* actions are no longer grantable (removed dead catalog leaves)', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["channel.send", "project.file.read"]
connectors = "all"
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.file.read']);
    expect(specs[0].connectors).toBe('all');
  });

  test('account-scoped action is dropped, never granted', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["member.invite"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual([]);
  });

  test('project.create (account-scoped) is dropped', () => {
    const { specs } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["project.create"]
`);
    expect(specs[0].permissions).toEqual([]);
  });

  test('unknown action is dropped, the rest of the list stays', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_permissions = ["project.frobnicate", "project.file.read"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].permissions).toEqual(['project.file.read']);
  });

  // `project.cr.open` / `project.cr.merge` are OUT of the live catalog: spec
  // §2.4 collapsed them into the gitops leaves, so keeping them here presented
  // one capability under two names in `--scopes`, in the JSON schema, and in
  // the agent-grant editor. They remain ACCEPTED on input as renamed aliases —
  // see the deprecation tests below — so no existing manifest breaks.
  test('the renamed CR actions are NOT in the grantable catalog', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.cr.open')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.cr.merge')).toBe(false);
  });

  test('a renamed action still PARSES, so an old manifest keeps its grant', () => {
    // The failure this guards: rejecting it puts the spec in `errors`, and an
    // agent whose manifest failed to parse is given an EMPTY grant — stripping
    // every capability it holds over one outdated string.
    const { specs, errors } = parse(
      '\n[[agents]]\nname = "a"\nkortix_permissions = ["project.cr.open", "project.trigger.create"]\n',
    );
    expect(errors).toEqual([]);
    expect(specs[0]!.permissions).toEqual(['project.cr.open', 'project.trigger.create']);
  });

  test('a genuinely unknown action is never granted', () => {
    const { specs } = parse('\n[[agents]]\nname = "a"\nkortix_permissions = ["project.not.a.thing"]\n');
    expect(specs[0].permissions).toEqual([]);
  });

  test('account actions are NOT in the grantable set', () => {
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('member.invite')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('billing.write')).toBe(false);
    expect(GRANTABLE_KORTIX_PERMISSIONS.has('project.create')).toBe(false);
  });
});

describe('[[agents]] — env', () => {

  test('env defaults to "all" when omitted; an explicit list narrows', () => {
    const { specs } = parse(`
[[agents]]
name = "no-env"

[[agents]]
name = "scoped"
env = ["GITHUB_TOKEN", "OPENAI_API_KEY"]
`);
    const noEnv = specs.find((s) => s.name === 'no-env');
    const scoped = specs.find((s) => s.name === 'scoped');
    expect(noEnv?.env).toBe('all'); // omitted → all (back-compat for the new dimension)
    expect(scoped?.env).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });
});

describe('[[agents]] — rejection paths', () => {
  test('missing name', () => {
    const { specs, errors } = parse(`
[[agents]]
connectors = ["github"]
`);
    expect(specs).toHaveLength(0);
    expect(errors[0].error).toContain('missing a name');
  });

  test('invalid name', () => {
    const { errors } = parse(`
[[agents]]
name = "Bad Name"
`);
    expect(errors[0].error).toContain('Invalid agent name');
  });

  test('[agents] (single table) is rejected', () => {
    const { errors } = parse(`
[agents]
name = "x"
`);
    expect(errors[0].error).toContain('must be an array of tables');
  });

  test('duplicate agent names', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "dupe"
[[agents]]
name = "dupe"
`);
    expect(specs).toHaveLength(1);
    expect(errors.some((e) => e.error.includes('Duplicate agent name'))).toBe(true);
  });

  test('connectors as a bad string is rejected', () => {
    const { errors } = parse(`
[[agents]]
name = "a"
connectors = "github"
`);
    expect(errors[0].error).toContain('"all", "*" or "none"');
  });
});

describe('applyAgentScope — the dashboard scope editor write step', () => {
  const base = () => [
    { name: 'release-bot', model: 'anthropic/claude', kortix_permissions: ['project.cr.open'] },
    { name: 'kortix', connectors: 'all' },
  ];

  test('sets a concrete secrets + connectors allowlist on the right agent', () => {
    const r = applyAgentScope(base(), 'release-bot', {
      env: ['DB_URL', 'STRIPE_KEY'],
      connectors: ['github'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = r.agents.find((a) => a.name === 'release-bot')!;
    expect(entry.env).toEqual(['DB_URL', 'STRIPE_KEY']);
    expect(entry.connectors).toEqual(['github']);
    // Untouched fields survive.
    expect(entry.model).toBe('anthropic/claude');
    expect(entry.kortix_permissions).toEqual(['project.cr.open']);
    // The other agent is untouched.
    expect(r.agents.find((a) => a.name === 'kortix')!.connectors).toBe('all');
  });

  test("env='all' omits the key (parser default), a list writes it", () => {
    const withEnv = applyAgentScope(base(), 'release-bot', { env: ['X'] });
    expect((withEnv as any).agents.find((a: any) => a.name === 'release-bot').env).toEqual(['X']);
    // Now reset to 'all' → the key disappears.
    const back = applyAgentScope((withEnv as any).agents, 'release-bot', { env: 'all' });
    expect('env' in (back as any).agents.find((a: any) => a.name === 'release-bot')).toBe(false);
  });

  test("connectors=[] omits the key (none is the default), 'all' writes it", () => {
    const none = applyAgentScope(base(), 'release-bot', { connectors: [] });
    expect('connectors' in (none as any).agents.find((a: any) => a.name === 'release-bot')).toBe(
      false,
    );
    const all = applyAgentScope(base(), 'release-bot', { connectors: 'all' });
    expect((all as any).agents.find((a: any) => a.name === 'release-bot').connectors).toBe('all');
  });

  test('an undeclared agent is an error, not a throw', () => {
    const r = applyAgentScope(base(), 'ghost', { env: ['X'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('ghost');
  });

  test('the result round-trips back through the parser cleanly', () => {
    const r = applyAgentScope(base(), 'release-bot', { env: ['DB_URL'], connectors: ['github'] });
    if (!r.ok) throw new Error('expected ok');
    const parsed = extractAgents({
      schemaVersion: KNOWN_SCHEMA_VERSION,
      raw: { agents: r.agents },
    } as any);
    const spec = parsed.specs.find((s) => s.name === 'release-bot')!;
    expect(spec.env).toEqual(['DB_URL']);
    expect(spec.connectors).toEqual(['github']);
    expect(parsed.errors).toHaveLength(0);
  });

  test('"declared in" error names the manifest\'s own filename, not a hard-coded kortix.toml', () => {
    const r = applyAgentScope(base(), 'ghost', { env: ['X'] }, 'kortix.yaml');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('No agent "ghost" declared in kortix.yaml');
  });
});

// Regression guard: agent spec/error `path` breadcrumbs used to hard-code
// `kortix.toml` regardless of which file the manifest actually came from.
// They now derive the filename from the parsed manifest's own `path` (set by
// `parseManifestString`), so a `kortix.yaml` project's spec/error paths say
// `kortix.yaml`.
describe('[[agents]] — spec/error `path` derives from the manifest\'s own filename', () => {
  function parseYaml(body: string) {
    return extractAgents(
      parseManifestString(
        `kortix_version: ${KNOWN_SCHEMA_VERSION}\nproject:\n  name: test\n${body}`,
        'yaml',
        'kortix.yaml',
      ),
    );
  }

  test('a yaml manifest\'s agent spec path says kortix.yaml', () => {
    const { specs, errors } = parseYaml(`agents:\n  - name: release-bot\n`);
    expect(errors).toEqual([]);
    expect(specs[0]?.path).toBe('kortix.yaml#agents.release-bot');
  });

  test('a yaml manifest\'s `[agents]` (non-array) error path says kortix.yaml', () => {
    const { errors } = parseYaml(`agents:\n  name: x\n`);
    expect(errors[0]?.path).toBe('kortix.yaml');
  });

  test('a legacy v1 toml manifest still says kortix.toml (default, unchanged)', () => {
    const { specs } = parse(`
[[agents]]
name = "release-bot"
`);
    expect(specs[0]?.path).toBe('kortix.toml#agents.release-bot');
  });
});

// kortix_version 2 — `agents:` is a name→block map (spec §2.1/§2.2), not the
// v1 `[[agents]]` array. This is the runtime-wiring half of the fix: the v2
// manifest schema (packages/manifest-schema) already validates this shape at
// write time; these tests cover the READER apps/api's grant pipeline actually
// runs through (extractAgents → grantFromLoadedAgents/resolveGovernedAgentGrant).
describe('kortix_version 2 — `agents:` map', () => {
  function parseV2(agentsBody: string, opts: { defaultAgent?: string } = {}) {
    const text = [
      'kortix_version: 2',
      `default_agent: ${opts.defaultAgent ?? 'support'}`,
      'project:',
      '  name: test',
      'agents:',
      agentsBody,
    ].join('\n');
    return extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
  }

  test('a plain agent block, no grants declared → deny-by-default (opposite of v1\'s env:"all")', () => {
    const { specs, errors } = parseV2(`
  support:
    description: "Handles support"
    opencode:
      mode: primary
`);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      name: 'support',
      enabled: true,
      connectors: [],
      permissions: [],
      env: [], // v2 default is 'none', unlike v1's 'all' — this is the actual dimension flip
      file: null,
    });
  });

  test('connectors/kortix_permissions/secrets lists resolve via resolveGrantSet; `secrets` maps onto AgentSpec.env', () => {
    const { specs, errors } = parseV2(`
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
    const loaded = parseV2(`
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

  test('"all" / "none" string forms resolve the same as v1', () => {
    const { specs } = parseV2(`
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
    const { specs } = parseV2(`
  support:
    enabled: false
  other:
    description: "another agent"
`, { defaultAgent: 'other' });
    expect(specs.find((s) => s.name === 'support')!.enabled).toBe(false);
    expect(specs.find((s) => s.name === 'other')!.enabled).toBe(true);
  });

  // 2026-07-05 redirect (spec §2.2, "one home per concern"): behavior
  // (including the prompt file reference and the declarative model) moved
  // entirely into the agent's own `.md` frontmatter. This governance-only
  // reader never had I/O to go read that file, so `file`/`model` always
  // resolve `null` now — even for a stale/out-of-band manifest that still
  // carries a (now schema-invalid) `opencode`/`model` key. Downstream callers
  // already treat a `null` file as "use the conventional `.md` by name".
  test('a stale/out-of-band `opencode`/`model` on the agent block no longer feeds AgentSpec.file/model', () => {
    const { specs } = parseV2(`
  support:
    model: anthropic/claude-sonnet-5
    opencode:
      prompt: agents/support.md
`);
    expect(specs[0].file).toBeNull();
    expect(specs[0].model).toBeNull();
  });

  test('an ungrantable kortix_permissions action drops out; the other grants stay', () => {
    const { specs, errors } = parseV2(`
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
    const { specs, errors } = parseV2(`
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
    const { errors } = parseV2(`
  "Bad Name":
    description: "x"
`, { defaultAgent: 'support' });
    expect(errors[0]?.error).toContain('Invalid agent name');
  });

  test('`agents` as an array (the v1 shape) under kortix_version 2 is rejected with a map-shape error', () => {
    const text = [
      'kortix_version: 2',
      'default_agent: support',
      'project:',
      '  name: test',
      'agents:',
      '  - name: support',
    ].join('\n');
    const { specs, errors } = extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
    expect(specs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('must be a map of agent name');
  });

  test('the manifest\'s top-level `default_agent` is captured on LoadedAgents (v1 leaves it null)', () => {
    const v2 = parseV2(`
  support:
    description: "x"
`, { defaultAgent: 'support' });
    expect(v2.defaultAgent).toBe('support');

    const v1 = parse(`
[[agents]]
name = "release-bot"
`);
    expect(v1.defaultAgent).toBeFalsy();
  });
});
