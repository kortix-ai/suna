/**
 * Parser-level tests for `[[agents]]` in kortix.toml — the per-agent scoping
 * overlay (name + connectors + kortix_cli). Covers happy paths, the kortix_cli
 * enum validation (grantable project actions pass; account-scoped + unknown
 * rejected), the grant-set forms ("all"/"none"/[]/"*"), the round-trip, and the
 * rejection paths.
 */
import { describe, expect, test } from 'bun:test';
import {
  agentSpecToTomlEntry,
  applyAgentScope,
  extractAgents,
  GRANTABLE_KORTIX_CLI,
  type AgentSpec,
} from '../projects/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';
import { GRANTABLE_KORTIX_CLI_ACTIONS } from '@kortix/manifest-schema';

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
  test('API GRANTABLE_KORTIX_CLI === manifest-schema GRANTABLE_KORTIX_CLI_ACTIONS', () => {
    expect([...GRANTABLE_KORTIX_CLI_ACTIONS].sort()).toEqual([...GRANTABLE_KORTIX_CLI].sort());
  });
});

describe('[[agents]] — happy paths', () => {
  test('name only → default-deny (no connectors, no kortix_cli)', () => {
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
      kortixCli: [],
      file: null,
    });
  });

  test('connectors list + kortix_cli list of grantable project actions', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "release-bot"
connectors = ["github", "stripe-readonly"]
kortix_cli = ["project.deploy", "project.cr.open"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toEqual(['github', 'stripe-readonly']);
    expect(specs[0].kortixCli).toEqual(['project.deploy', 'project.cr.open']);
  });

  test('"all" grants everything; default kortix agent shape', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "kortix"
connectors = "all"
kortix_cli = "all"
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].kortixCli).toBe('all');
  });

  test('"*" inside a list collapses to "all"', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "kortix"
kortix_cli = ["*"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].kortixCli).toBe('all');
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

  test('duplicate kortix_cli entries are de-duplicated', () => {
    const { specs } = parse(`
[[agents]]
name = "a"
kortix_cli = ["project.read", "project.read", "project.deploy"]
`);
    expect(specs[0].kortixCli).toEqual(['project.read', 'project.deploy']);
  });
});

describe('[[agents]] — kortix_cli enum enforcement', () => {
  test('every project connector action is grantable', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["project.connector.write", "project.connector.read"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].kortixCli).toEqual(['project.connector.write', 'project.connector.read']);
  });

  test('channel.* actions are no longer grantable (removed dead catalog leaves)', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["channel.send"]
`);
    expect(specs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('unknown action');
  });

  test('account-scoped action is rejected with a clear message', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["member.invite"]
`);
    expect(specs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('account-scoped');
  });

  test('project.create (account-scoped) is rejected', () => {
    const { errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["project.create"]
`);
    expect(errors[0].error).toContain('account-scoped');
  });

  test('unknown action is rejected as unknown', () => {
    const { errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["project.frobnicate"]
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('unknown action');
  });

  test('the new CR actions are grantable', () => {
    expect(GRANTABLE_KORTIX_CLI.has('project.cr.open')).toBe(true);
    expect(GRANTABLE_KORTIX_CLI.has('project.cr.merge')).toBe(true);
  });

  test('account actions are NOT in the grantable set', () => {
    expect(GRANTABLE_KORTIX_CLI.has('member.invite')).toBe(false);
    expect(GRANTABLE_KORTIX_CLI.has('billing.write')).toBe(false);
    expect(GRANTABLE_KORTIX_CLI.has('project.create')).toBe(false);
  });
});

describe('[[agents]] — round-trip', () => {
  test('spec → TOML entry → re-parse is stable', () => {
    const spec: AgentSpec = {
      name: 'release-bot',
      path: 'kortix.toml#agents.release-bot',
      enabled: true,
      connectors: ['github'],
      kortixCli: ['project.deploy'],
      env: 'all',
      file: null,
      model: 'anthropic/claude-sonnet-4-6',
    };
    const entry = agentSpecToTomlEntry(spec);
    const { specs, errors } = parse(`
[[agents]]
name = "${entry.name}"
connectors = ${JSON.stringify(entry.connectors)}
kortix_cli = ${JSON.stringify(entry.kortix_cli)}
model = "${entry.model}"
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ name: 'release-bot', connectors: ['github'], kortixCli: ['project.deploy'], model: 'anthropic/claude-sonnet-4-6' });
  });

  test('minimal spec emits only name', () => {
    const entry = agentSpecToTomlEntry({
      name: 'kortix', path: '', enabled: true, connectors: [], kortixCli: [], env: 'all', file: null, model: null,
    });
    expect(entry).toEqual({ name: 'kortix' });
  });

  test('env defaults to "all" when omitted; an explicit list narrows + round-trips', () => {
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
    // only the narrowed one emits an `env` key
    expect(agentSpecToTomlEntry(noEnv!).env).toBeUndefined();
    expect(agentSpecToTomlEntry(scoped!).env).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
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
    expect(errors[0].error).toContain('"all" or "none"');
  });
});

describe('applyAgentScope — the dashboard scope editor write step', () => {
  const base = () => [
    { name: 'release-bot', model: 'anthropic/claude', kortix_cli: ['project.cr.open'] },
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
    expect(entry.kortix_cli).toEqual(['project.cr.open']);
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

  test('a toml manifest still says kortix.toml (default, unchanged)', () => {
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
      kortixCli: [],
      env: [], // v2 default is 'none', unlike v1's 'all' — this is the actual dimension flip
      file: null,
    });
  });

  test('connectors/kortix_cli/secrets lists resolve via resolveGrantSet; `secrets` maps onto AgentSpec.env', () => {
    const { specs, errors } = parseV2(`
  support:
    connectors: [github, slack]
    kortix_cli: [project.deploy, project.cr.open]
    secrets: [STRIPE_KEY, GH_TOKEN]
`);
    expect(errors).toEqual([]);
    expect(specs[0].connectors).toEqual(['github', 'slack']);
    expect(specs[0].kortixCli).toEqual(['project.deploy', 'project.cr.open']);
    expect(specs[0].env).toEqual(['STRIPE_KEY', 'GH_TOKEN']);
  });

  test('"all" / "none" string forms resolve the same as v1', () => {
    const { specs } = parseV2(`
  support:
    connectors: all
    kortix_cli: none
    secrets: all
`);
    expect(specs[0].connectors).toBe('all');
    expect(specs[0].kortixCli).toEqual([]);
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

  test('an ungrantable kortix_cli action is rejected the same way as v1', () => {
    const { specs, errors } = parseV2(`
  support:
    kortix_cli: [member.invite]
`);
    expect(specs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('account-scoped');
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
