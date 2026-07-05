/**
 * MANDATORY DECLARED AGENTS (flagged) — docs/specs/2026-07-05-agent-first-
 * config-unification.md §2.1/§3 Phase 2.
 *
 * `projectRequiresDeclaredAgents` decides whether a project is "subject" to
 * enforcement (platform-wide flag OR the project's own metadata stamp).
 * `resolveGovernedAgentGrant` is the pure resolution rule: for a non-subject
 * project it must be byte-for-byte identical to `grantFromLoadedAgents`
 * (today's back-compat behavior, untouched); for a subject project, an
 * undeclared agent — or a `default` sentinel with no resolvable declared
 * default_agent — is REJECTED with an explicit error rather than silently
 * granted the permissive null grant or silently default-denied-to-running.
 */
import { describe, expect, test } from 'bun:test';
import { extractAgents, projectRequiresDeclaredAgents, resolveGovernedAgentGrant } from '../projects/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';

function loadAgents(body: string) {
  return extractAgents(parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`));
}

describe('projectRequiresDeclaredAgents — subjectness', () => {
  test('platform flag off + no metadata stamp → not subject', () => {
    expect(projectRequiresDeclaredAgents({}, false)).toBe(false);
    expect(projectRequiresDeclaredAgents(null, false)).toBe(false);
    expect(projectRequiresDeclaredAgents(undefined, false)).toBe(false);
  });

  test('platform flag on → subject regardless of metadata', () => {
    expect(projectRequiresDeclaredAgents({}, true)).toBe(true);
    expect(projectRequiresDeclaredAgents(null, true)).toBe(true);
  });

  test('platform flag off but project.metadata.require_declared_agents === true → subject', () => {
    expect(projectRequiresDeclaredAgents({ require_declared_agents: true }, false)).toBe(true);
  });

  test('a truthy-but-not-literal-true value does NOT flip subjectness (strict ===)', () => {
    expect(projectRequiresDeclaredAgents({ require_declared_agents: 'true' }, false)).toBe(false);
    expect(projectRequiresDeclaredAgents({ require_declared_agents: 1 }, false)).toBe(false);
  });
});

describe('resolveGovernedAgentGrant — non-subject preserves today\'s exact behavior', () => {
  test('no [[agents]] section → ok, null grant (unrestricted, back-compat)', () => {
    const result = resolveGovernedAgentGrant('default', loadAgents(''), {
      subject: false,
      projectDefaultAgent: null,
    });
    expect(result).toEqual({ ok: true, grant: null });
  });

  test('governed project, unlisted concrete agent → ok, default-deny grant (unchanged v1 rule)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
kortix_cli = ["project.deploy"]
`);
    const result = resolveGovernedAgentGrant('rogue-agent', loaded, {
      subject: false,
      projectDefaultAgent: null,
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'rogue-agent', connectors: [], kortixCli: [], env: [] },
    });
  });

  test('`default` sentinel under governance, non-subject → ok, null (non-binding, unchanged v1 rule)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "veyris"
connectors = "all"
kortix_cli = "all"
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: false,
      projectDefaultAgent: null,
    });
    expect(result).toEqual({ ok: true, grant: null });
  });
});

describe('resolveGovernedAgentGrant — subject project rejects undeclared agents', () => {
  const loaded = loadAgents(`
[[agents]]
name = "support"
connectors = ["github"]
kortix_cli = ["project.cr.open"]

[[agents]]
name = "disabled-one"
enabled = false
`);

  test('declared, enabled agent → ok, its grant', () => {
    const result = resolveGovernedAgentGrant('support', loaded, {
      subject: true,
      projectDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: ['project.cr.open'], env: 'all' },
    });
  });

  test('undeclared concrete agent → rejected with an explicit error (not null, not default-deny)', () => {
    const result = resolveGovernedAgentGrant('never-declared', loaded, {
      subject: true,
      projectDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AGENT_NOT_DECLARED');
      expect(result.error).toMatch(/not declared/i);
    }
  });

  test('a declared-but-disabled agent is rejected, same as undeclared', () => {
    const result = resolveGovernedAgentGrant('disabled-one', loaded, {
      subject: true,
      projectDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
  });

  test('project with zero [[agents]] declared at all → rejected (no adopt-to-govern escape hatch)', () => {
    const result = resolveGovernedAgentGrant('anything', loadAgents(''), {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('resolveGovernedAgentGrant — subject project: `default` sentinel must resolve to a declared default_agent', () => {
  const loaded = loadAgents(`
[[agents]]
name = "support"
connectors = ["github"]
`);

  test('sentinel + a declared, enabled default_agent → ok, that agent\'s grant (not null)', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: 'all' },
    });
  });

  test('sentinel + no default_agent configured → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });

  test('sentinel + a default_agent naming an UNDECLARED agent → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: 'ghost-agent',
    });
    expect(result.ok).toBe(false);
  });
});

// kortix_version 2 — the runtime-wiring fix: extractAgents now reads a v2
// `agents:` map (not just v1's `[[agents]]` array), and the manifest's own
// top-level `default_agent` (captured on `LoadedAgents.defaultAgent`) backs
// `opts.projectDefaultAgent` when the DB-side project.metadata mirror isn't
// separately set — which is the common case for a v2 project, since nothing
// syncs the manifest's `default_agent` into project metadata today.
describe('resolveGovernedAgentGrant — subject project, kortix_version 2 manifest', () => {
  function loadV2(agentsBody: string, opts: { defaultAgent?: string } = {}) {
    const text = [
      'kortix_version: 2',
      `default_agent: ${opts.defaultAgent ?? 'support'}`,
      'project:',
      '  name: t',
      'agents:',
      agentsBody,
    ].join('\n');
    return extractAgents(parseManifestString(text, 'yaml', 'kortix.yaml'));
  }

  test('a concrete declared v2 agent is FOUND, not rejected / default-denied', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
    kortix_cli: [project.cr.open]
`);
    const result = resolveGovernedAgentGrant('support', loaded, {
      subject: true,
      projectDefaultAgent: null,
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: ['project.cr.open'], env: [] },
    });
  });

  test('sentinel resolves via the MANIFEST\'s default_agent when project.metadata has none', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: null, // no DB-side mirror set — the common case for v2
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: [] },
    });
  });

  test('an explicit DB projectDefaultAgent still wins over the manifest\'s default_agent', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
  billing:
    secrets: [STRIPE_KEY]
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      projectDefaultAgent: 'billing',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'billing', connectors: [], kortixCli: [], env: ['STRIPE_KEY'] },
    });
  });

  test('an undeclared v2 agent is rejected, not default-denied', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
`);
    const result = resolveGovernedAgentGrant('never-declared', loaded, {
      subject: true,
      projectDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });
});
