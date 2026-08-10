/**
 * MANDATORY DECLARED AGENTS (flagged) — docs/specs/2026-07-05-agent-first-
 * config-unification.md §2.1/§3 Phase 2.
 *
 * `workspaceRequiresDeclaredAgents` decides whether a project is "subject" to
 * enforcement (platform-wide flag OR the project's own metadata stamp).
 * `resolveGovernedAgentGrant` is the pure resolution rule: for a non-subject
 * project it must be byte-for-byte identical to `grantFromLoadedAgents`
 * (today's back-compat behavior, untouched); for a subject project, an
 * undeclared agent — or a `default` sentinel with no resolvable declared
 * default_agent — is REJECTED with an explicit error rather than silently
 * granted the permissive null grant or silently default-denied-to-running.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STARTER_TEMPLATE_ID, getStarterFiles } from '@kortix/starter';
import { extractAgents, workspaceRequiresDeclaredAgents, resolveGovernedAgentGrant } from '../workspaces/agents';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../workspaces/triggers';

/**
 * The manifest's own `default_agent`, asserted present. Every starter assertion
 * below is written against this instead of a hardcoded agent name, so the guard
 * survives a change of which starter (or which schema version) ships by default.
 */
function declaredDefaultAgent(loaded: ReturnType<typeof extractAgents>): string {
  const name = loaded.defaultAgent;
  expect(typeof name).toBe('string');
  return name as string;
}

function loadAgents(body: string) {
  return extractAgents(parseManifestString(`kortix_version = ${KNOWN_SCHEMA_VERSION}\n[project]\nname="t"\n${body}`));
}

describe('workspaceRequiresDeclaredAgents — subjectness', () => {
  test('platform flag off + no metadata stamp → not subject', () => {
    expect(workspaceRequiresDeclaredAgents({}, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents(null, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents(undefined, false)).toBe(false);
  });

  test('platform flag on → subject regardless of metadata', () => {
    expect(workspaceRequiresDeclaredAgents({}, true)).toBe(true);
    expect(workspaceRequiresDeclaredAgents(null, true)).toBe(true);
  });

  test('platform flag off but project.metadata.require_declared_agents === true → subject', () => {
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: true }, false)).toBe(true);
  });

  test('a truthy-but-not-literal-true value does NOT flip subjectness (strict ===)', () => {
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: 'true' }, false)).toBe(false);
    expect(workspaceRequiresDeclaredAgents({ require_declared_agents: 1 }, false)).toBe(false);
  });
});

describe('resolveGovernedAgentGrant — non-subject preserves today\'s exact behavior', () => {
  test('no [[agents]] section → ok, null grant (unrestricted, back-compat)', () => {
    const result = resolveGovernedAgentGrant('default', loadAgents(''), {
      subject: false,
      workspaceDefaultAgent: null,
    });
    expect(result).toEqual({ ok: true, grant: null });
  });

  test('governed project, unlisted concrete agent → ok, default-deny grant (unchanged v1 rule)', () => {
    const loaded = loadAgents(`
[[agents]]
name = "release-bot"
kortix_cli = ["project.trigger.create"]
`);
    const result = resolveGovernedAgentGrant('rogue-agent', loaded, {
      subject: false,
      workspaceDefaultAgent: null,
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
      workspaceDefaultAgent: null,
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
      workspaceDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: ['project.cr.open'], env: 'all' },
    });
  });

  test('undeclared concrete agent → rejected with an explicit error (not null, not default-deny)', () => {
    const result = resolveGovernedAgentGrant('never-declared', loaded, {
      subject: true,
      workspaceDefaultAgent: 'support',
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
      workspaceDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
  });

  test('project with zero [[agents]] declared at all → rejected (no adopt-to-govern escape hatch)', () => {
    const result = resolveGovernedAgentGrant('anything', loadAgents(''), {
      subject: true,
      workspaceDefaultAgent: null,
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
      workspaceDefaultAgent: 'support',
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: 'all' },
    });
  });

  test('sentinel + no default_agent configured → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });

  test('sentinel + a default_agent naming an UNDECLARED agent → rejected', () => {
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: 'ghost-agent',
    });
    expect(result.ok).toBe(false);
  });
});

// kortix_version 2 — the runtime-wiring fix: extractAgents now reads a v2
// `agents:` map (not just v1's `[[agents]]` array), and the manifest's own
// top-level `default_agent` (captured on `LoadedAgents.defaultAgent`) backs
// `opts.workspaceDefaultAgent` when the DB-side project.metadata mirror isn't
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
      workspaceDefaultAgent: null,
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
      workspaceDefaultAgent: null, // no DB-side mirror set — the common case for v2
    });
    expect(result).toEqual({
      ok: true,
      grant: { agent: 'support', connectors: ['github'], kortixCli: [], env: [] },
    });
  });

  test('an explicit DB workspaceDefaultAgent still wins over the manifest\'s default_agent', () => {
    const loaded = loadV2(`
  support:
    connectors: [github]
  billing:
    secrets: [STRIPE_KEY]
`);
    const result = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: 'billing',
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
      workspaceDefaultAgent: 'support',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGENT_NOT_DECLARED');
  });
});

// P0 REGRESSION GUARD: POST /projects/provision (r1.ts) stamps
// `metadata.require_declared_agents = true` on every new project — so a fresh
// project is ALWAYS subject to this gate from birth, with no DB-side
// `metadata.default_agent` mirror set (sessions.ts's `workspaceDefaultAgent` is
// `undefined`/null the very first time). The starter it seeds
// (@kortix/starter, packages/starter/templates/base) MUST therefore ship a
// v2 manifest with a `default_agent` that resolves — otherwise
// EVERY brand-new project's first session (agent 'default', the UI's
// no-explicit-agent path) is rejected with AGENT_NOT_DECLARED before a sandbox
// is ever provisioned. This exercises the REAL shipped starter (not a
// synthetic fixture) through the exact resolution rule sessions.ts calls.
describe('resolveGovernedAgentGrant — the actual shipped starter satisfies its own require_declared_agents stamp', () => {
  const starterFiles = getStarterFiles({
    projectName: 'Acme Co',
    template: DEFAULT_STARTER_TEMPLATE_ID,
  });
  const manifestFile = starterFiles.find((f) => f.path === 'kortix.yaml');

  test('the starter ships a v2 kortix.yaml, not a v1 kortix.toml', () => {
    expect(manifestFile).toBeDefined();
    expect(starterFiles.some((f) => f.path === 'kortix.toml')).toBe(false);
  });

  test('a first session with no explicit agent ("default") RESOLVES — ok:true, not AGENT_NOT_DECLARED', () => {
    const manifest = parseManifestString(manifestFile!.content, 'yaml', 'kortix.yaml');
    expect(manifest.schemaVersion).toBe(2);
    const loaded = extractAgents(manifest);
    expect(loaded.errors).toEqual([]);
    // The manifest must name a default agent, and must declare it.
    const declaredDefault = declaredDefaultAgent(loaded);
    expect(loaded.specs.map((spec) => spec.name)).toContain(declaredDefault);

    // Mirrors r1.ts /projects/provision exactly: subject=true (the metadata
    // stamp), and no project.metadata.default_agent mirror set yet.
    const governed = resolveGovernedAgentGrant('default', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });

    expect(governed.ok).toBe(true);
    if (!governed.ok) return;
    // The default agent is the one a new user drives from the UI with no
    // configuration, so it must carry the full grant — a narrowed default is a
    // silently crippled first session.
    expect(governed.grant).toEqual({
      agent: 'kortix',
      connectors: 'all',
      kortixCli: 'all',
      env: 'all',
    });
  });

  test('the starter\'s declared "kortix" agent also resolves when named explicitly', () => {
    const manifest = parseManifestString(manifestFile!.content, 'yaml', 'kortix.yaml');
    const loaded = extractAgents(manifest);
    const governed = resolveGovernedAgentGrant('kortix', loaded, {
      subject: true,
      workspaceDefaultAgent: null,
    });
    expect(governed.ok).toBe(true);
  });

});
