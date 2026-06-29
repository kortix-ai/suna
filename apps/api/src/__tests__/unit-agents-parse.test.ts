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
  test('every channel action is grantable', () => {
    const { specs, errors } = parse(`
[[agents]]
name = "a"
kortix_cli = ["channel.send", "channel.read"]
`);
    expect(errors).toEqual([]);
    expect(specs[0].kortixCli).toEqual(['channel.send', 'channel.read']);
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
