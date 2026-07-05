import { describe, expect, mock, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';

// compile-agent-config.ts's I/O half imports the real ../git module, which
// shells out to git + pulls in config/db — none of that runs in a bun:test
// process. Mock it BEFORE the dynamic import below so the pure-function tests
// (which don't touch git at all) and the I/O tests (which control it per-test)
// both load safely, mirroring the mock-then-dynamic-import pattern used
// throughout apps/api/src/projects/maintenance.test.ts and friends.
let manifestFile: { path: string; content: string } | null = null;
let promptFileContent: Record<string, string> = {};
let readRepoFileCalls: string[] = [];

mock.module('../git', () => ({
  readManifestFromRepo: async () => manifestFile,
  readRepoFile: async (_project: unknown, path: string) => {
    readRepoFileCalls.push(path);
    if (!(path in promptFileContent)) throw new Error(`no such file: ${path}`);
    return promptFileContent[path];
  },
}));

const { CompileAgentConfigError, compileAgentConfig, resolveCompiledAgentConfigForSession } =
  await import('./compile-agent-config');
type OpencodeConfig = Awaited<ReturnType<typeof compileAgentConfig>> & object;

// The spec's §2.2 example manifest verbatim — see
// docs/specs/2026-07-05-agent-first-config-unification.md.
const SPEC_2_2_FIXTURE = `
kortix_version: 2
default_agent: support

agents:
  support:
    description: "Handles customer support triage"
    mode: primary
    model: anthropic/claude-sonnet-5
    temperature: 0.2
    steps: 200
    color: "#7C5CFF"
    hidden: false
    prompt: agents/support.md
    permission:
      edit: ask
      bash: { "git push": deny, "*": allow }
      webfetch: allow
    connectors: [github, slack]
    secrets: [STRIPE_KEY, GH_TOKEN]
    kortix_cli: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
    mode: subagent
    description: "Reviews and lands PRs"
    prompt: agents/pr-bot.md
    connectors: [github]
    kortix_cli: [project.cr.open, project.cr.merge, project.review.submit]
`;

const V1_FIXTURE_TOML = `
kortix_version = 1

[project]
name = "acme"

[[agents]]
name = "kortix"
connectors = "all"
`;

function parseYaml(raw: string): Record<string, unknown> {
  return parseManifestText(raw, 'yaml');
}

describe('compileAgentConfig — v1 is a compiler no-op', () => {
  test('returns null for a kortix_version 1 manifest', () => {
    const manifest = parseManifestText(V1_FIXTURE_TOML, 'toml');
    expect(compileAgentConfig(manifest)).toBeNull();
  });

  test('returns null when kortix_version is missing entirely', () => {
    expect(compileAgentConfig({ project: { name: 'x' } })).toBeNull();
  });

  test('v1 no-op wins over an unsupported runtime — never throws for a v1 manifest', () => {
    const manifest = parseManifestText(V1_FIXTURE_TOML, 'toml');
    expect(compileAgentConfig(manifest, 'codex' as never)).toBeNull();
  });
});

describe('compileAgentConfig — spec §2.2 example manifest', () => {
  const manifest = parseYaml(SPEC_2_2_FIXTURE);
  const promptFiles = {
    'agents/support.md': 'You triage customer support tickets with empathy and precision.',
    'agents/pr-bot.md': 'You review and land pull requests, following the house style guide.',
  };

  test('compiles the full agent map with 1:1 OpenCode AgentConfig field parity', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', promptFiles) as OpencodeConfig;
    expect(compiled).not.toBeNull();
    expect(compiled.agent.support).toEqual({
      description: 'Handles customer support triage',
      mode: 'primary',
      model: 'anthropic/claude-sonnet-5',
      temperature: 0.2,
      steps: 200,
      color: '#7C5CFF',
      hidden: false,
      prompt: 'You triage customer support tickets with empathy and precision.',
      permission: {
        edit: 'ask',
        bash: { 'git push': 'deny', '*': 'allow' },
        webfetch: 'allow',
      },
    });
    expect(compiled.agent['pr-bot']).toEqual({
      description: 'Reviews and lands PRs',
      mode: 'subagent',
      prompt: 'You review and land pull requests, following the house style guide.',
    });
  });

  test('never copies governance fields (connectors/secrets/kortix_cli/workspace) — no runtime representation', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', promptFiles) as OpencodeConfig;
    for (const agentConfig of Object.values(compiled.agent)) {
      expect(agentConfig).not.toHaveProperty('connectors');
      expect(agentConfig).not.toHaveProperty('secrets');
      expect(agentConfig).not.toHaveProperty('kortix_cli');
      expect(agentConfig).not.toHaveProperty('workspace');
    }
  });

  test("top-level model passthrough is the default_agent's declared model", () => {
    const compiled = compileAgentConfig(manifest, 'opencode', promptFiles) as OpencodeConfig;
    expect(compiled.model).toBe('anthropic/claude-sonnet-5');
    expect(compiled.small_model).toBeUndefined();
  });

  test('omits top-level model when the default agent declares none', () => {
    const noModelManifest = parseYaml(`
kortix_version: 2
default_agent: pr-bot
agents:
  pr-bot:
    mode: subagent
    description: "Reviews PRs"
`);
    const compiled = compileAgentConfig(noModelManifest) as OpencodeConfig;
    expect(compiled.model).toBeUndefined();
  });
});

describe('compileAgentConfig — every AgentBlockV2 field maps 1:1', () => {
  const manifest = parseYaml(`
kortix_version: 2
default_agent: full
agents:
  full:
    description: "Full field coverage"
    mode: all
    model: anthropic/claude-opus-4.8
    variant: thinking
    temperature: 0.7
    top_p: 0.9
    disable: true
    hidden: true
    options:
      foo: bar
    color: "#123456"
    steps: 42
    permission: allow
`);

  test('maps every optional field through unchanged', () => {
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.full).toEqual({
      description: 'Full field coverage',
      mode: 'all',
      model: 'anthropic/claude-opus-4.8',
      variant: 'thinking',
      temperature: 0.7,
      top_p: 0.9,
      disable: true,
      hidden: true,
      options: { foo: 'bar' },
      color: '#123456',
      steps: 42,
      permission: 'allow',
    });
  });

  test('an agent block with no fields set compiles to an empty config object', () => {
    const bare = parseYaml(`
kortix_version: 2
default_agent: bare
agents:
  bare: {}
`);
    const compiled = compileAgentConfig(bare) as OpencodeConfig;
    expect(compiled.agent.bare).toEqual({});
  });
});

describe('compileAgentConfig — prompt resolution', () => {
  test('resolves prompt to the file body when content is supplied', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    prompt: agents/a.md
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      'agents/a.md': 'Just the body, no frontmatter.',
    }) as OpencodeConfig;
    expect(compiled.agent.a.prompt).toBe('Just the body, no frontmatter.');
  });

  test('strips a legal frontmatter block (no manifest-owned keys) and keeps the body', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    prompt: agents/a.md
`);
    const content = ['---', 'title: Support Agent', '---', '', 'Body text follows.'].join('\n');
    const compiled = compileAgentConfig(manifest, 'opencode', {
      'agents/a.md': content,
    }) as OpencodeConfig;
    expect(compiled.agent.a.prompt).toBe('Body text follows.');
  });

  test('falls back to an OpenCode {file:...} reference when content is not supplied', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    prompt: agents/a.md
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a.prompt).toBe('{file:agents/a.md}');
  });

  test('an agent with no prompt field compiles with no prompt key', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    mode: primary
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a).not.toHaveProperty('prompt');
  });
});

describe('compileAgentConfig — frontmatter-illegal rule', () => {
  const manifest = parseYaml(`
kortix_version: 2
default_agent: support
agents:
  support:
    mode: primary
    prompt: agents/support.md
`);

  test('throws a clear CompileAgentConfigError when the .md still carries a manifest-owned key', () => {
    const content = ['---', 'model: anthropic/claude-sonnet-5', 'mode: primary', '---', '', 'Body.'].join(
      '\n',
    );
    expect(() =>
      compileAgentConfig(manifest, 'opencode', { 'agents/support.md': content }),
    ).toThrow(CompileAgentConfigError);
    try {
      compileAgentConfig(manifest, 'opencode', { 'agents/support.md': content });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(CompileAgentConfigError);
      const message = (err as InstanceType<typeof CompileAgentConfigError>).message;
      expect(message).toContain('support');
      expect(message).toContain('agents/support.md');
      expect(message).toContain('"model"');
      expect(message).toContain('"mode"');
    }
  });

  test('a body-only .md (no frontmatter at all) is fine', () => {
    expect(() =>
      compileAgentConfig(manifest, 'opencode', {
        'agents/support.md': 'Just a plain system prompt, no frontmatter block.',
      }),
    ).not.toThrow();
  });

  test('frontmatter with only non-manifest-owned keys is fine', () => {
    const content = ['---', 'title: Support Agent Notes', '---', '', 'Body.'].join('\n');
    expect(() =>
      compileAgentConfig(manifest, 'opencode', { 'agents/support.md': content }),
    ).not.toThrow();
  });
});

describe('compileAgentConfig — unsupported runtime (v2 manifest)', () => {
  test('throws for a runtime other than opencode', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a: {}
`);
    expect(() => compileAgentConfig(manifest, 'claude' as never)).toThrow(CompileAgentConfigError);
  });
});

// ─── resolveCompiledAgentConfigForSession (I/O half) ───────────────────────

const PROJECT = {
  projectId: 'proj-1',
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.toml',
  gitAuthToken: null,
};

describe('resolveCompiledAgentConfigForSession', () => {
  test('returns null when no manifest is found', async () => {
    manifestFile = null;
    expect(await resolveCompiledAgentConfigForSession(PROJECT)).toBeNull();
  });

  test('returns null for a v1 manifest — v1 projects are unaffected', async () => {
    manifestFile = { path: 'kortix.toml', content: V1_FIXTURE_TOML };
    expect(await resolveCompiledAgentConfigForSession(PROJECT)).toBeNull();
  });

  test('reads each declared prompt file and returns the compiled JSON for a v2 manifest', async () => {
    manifestFile = { path: 'kortix.yaml', content: SPEC_2_2_FIXTURE };
    promptFileContent = {
      'agents/support.md': 'Support body.',
      'agents/pr-bot.md': 'PR bot body.',
    };
    readRepoFileCalls = [];
    const result = await resolveCompiledAgentConfigForSession(PROJECT);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as OpencodeConfig;
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.agent['pr-bot'].prompt).toBe('PR bot body.');
    expect(parsed.model).toBe('anthropic/claude-sonnet-5');
    expect(new Set(readRepoFileCalls)).toEqual(new Set(['agents/support.md', 'agents/pr-bot.md']));
  });

  test('falls back to a {file:...} reference (never throws) when a declared prompt file is unreadable', async () => {
    manifestFile = { path: 'kortix.yaml', content: SPEC_2_2_FIXTURE };
    promptFileContent = { 'agents/support.md': 'Support body.' }; // pr-bot.md missing
    const result = await resolveCompiledAgentConfigForSession(PROJECT);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as OpencodeConfig;
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.agent['pr-bot'].prompt).toBe('{file:agents/pr-bot.md}');
  });

  test('never throws — an illegal frontmatter compile error resolves to null instead', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: `
kortix_version: 2
default_agent: support
agents:
  support:
    mode: primary
    prompt: agents/support.md
`,
    };
    promptFileContent = {
      'agents/support.md': ['---', 'mode: primary', '---', '', 'Body.'].join('\n'),
    };
    expect(await resolveCompiledAgentConfigForSession(PROJECT)).toBeNull();
  });
});
