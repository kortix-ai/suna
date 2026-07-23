import { describe, expect, mock, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';

// compile-agent-config.ts's I/O half imports the real ../git module. Mock it
// BEFORE the dynamic import below so the pure-function tests (which don't
// touch git at all) and the I/O tests (which control it per-test) both load
// safely, mirroring the mock-then-dynamic-import pattern used throughout
// apps/api/src/projects/maintenance.test.ts and friends. mock.module() is a
// process-wide registry (see disk-quota-guard.test.ts), so this MUST spread
// the real module — an incomplete stub here leaks into every other file in
// the same bun test run that imports './git' / '../git' and needs an export
// this file doesn't stub.
let manifestFile: { path: string; content: string } | null = null;
let mdFileContent: Record<string, string> = {};
let readRepoFileCalls: string[] = [];

const realGit = await import('../git');
mock.module('../git', () => ({
  ...realGit,
  readManifestFromRepo: async () => manifestFile,
  readRepoFile: async (_project: unknown, path: string) => {
    readRepoFileCalls.push(path);
    if (!(path in mdFileContent)) throw new Error(`no such file: ${path}`);
    return mdFileContent[path];
  },
}));

const {
  BEHAVIOR_FRONTMATTER_KEYS,
  CompileAgentConfigError,
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  agentMarkdownPath,
  compileAgentConfig,
  resolveCompiledAgentConfigForSession,
} = await import('./compile-agent-config');
type OpencodeConfig = Awaited<ReturnType<typeof compileAgentConfig>> & object;

// Governance-only v2 manifest — the 2026-07-05 redirect's shape. Behavior
// lives in each agent's own `.kortix/opencode/agents/<name>.md`.
const GOVERNANCE_FIXTURE = `
kortix_version: 2
default_agent: support

agents:
  support:
    connectors: [github, slack]
    secrets: [STRIPE_KEY, GH_TOKEN]
    kortix_cli: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
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

function supportMd(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

// The behavior-frontmatter key set used to be hand-copied three ways (the
// compiler's BEHAVIOR_FRONTMATTER_KEYS, the agent-config editor route's
// KNOWN_BEHAVIOR_KEYS, and its wire schema's field list) and drifted subtly
// out of sync. All three now live here, with KNOWN_BEHAVIOR_KEYS and
// OpencodeAgentConfigSchema DERIVED from BEHAVIOR_FRONTMATTER_KEYS instead of
// re-declared — these tests are the guard that catches the moment any of
// them stops matching (the schema can't be derived key-for-key since each
// field has a different type, so this coordination check is what keeps it
// honest instead).
describe('KNOWN_BEHAVIOR_KEYS / OpencodeAgentConfigSchema coordination', () => {
  test('KNOWN_BEHAVIOR_KEYS is exactly BEHAVIOR_FRONTMATTER_KEYS minus `disable`', () => {
    expect(new Set(KNOWN_BEHAVIOR_KEYS)).toEqual(
      new Set(BEHAVIOR_FRONTMATTER_KEYS.filter((key) => key !== 'disable')),
    );
    expect(KNOWN_BEHAVIOR_KEYS).not.toContain('disable');
    expect(BEHAVIOR_FRONTMATTER_KEYS).toContain('disable');
  });

  test("OpencodeAgentConfigSchema's fields are exactly KNOWN_BEHAVIOR_KEYS plus `prompt`", () => {
    const schemaKeys = Object.keys(OpencodeAgentConfigSchema.shape);
    expect(new Set(schemaKeys.filter((key) => key !== 'prompt'))).toEqual(
      new Set(KNOWN_BEHAVIOR_KEYS),
    );
    expect(schemaKeys).toContain('prompt');
  });
});

describe('agentMarkdownPath', () => {
  test('defaults to .kortix/opencode/agents/<name>.md', () => {
    expect(agentMarkdownPath({}, 'support')).toBe('.kortix/opencode/agents/support.md');
  });

  test('honors a custom top-level [opencode] config_dir', () => {
    expect(agentMarkdownPath({ opencode: { config_dir: 'custom/dir' } }, 'support')).toBe(
      'custom/dir/agents/support.md',
    );
  });
});

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

describe('compileAgentConfig — behavior comes from the agent .md, not the manifest', () => {
  const manifest = parseYaml(GOVERNANCE_FIXTURE);
  const agentMdFiles = {
    '.kortix/opencode/agents/support.md': supportMd(
      [
        'description: "Handles customer support triage"',
        'model: anthropic/claude-sonnet-5',
        'mode: primary',
        'temperature: 0.2',
        'steps: 200',
        'color: "#7C5CFF"',
        'hidden: false',
        'permission:',
        '  edit: ask',
        '  bash: { "git push": deny, "*": allow }',
        '  webfetch: allow',
      ].join('\n'),
      'You triage customer support tickets with empathy and precision.',
    ),
    '.kortix/opencode/agents/pr-bot.md': supportMd(
      ['mode: subagent'].join('\n'),
      'You review and land pull requests, following the house style guide.',
    ),
  };

  test('compiles the full agent map with 1:1 OpenCode AgentConfig field parity from the .md frontmatter', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as OpencodeConfig;
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
      mode: 'subagent',
      prompt: 'You review and land pull requests, following the house style guide.',
    });
  });

  test('never copies governance fields (connectors/secrets/kortix_cli/workspace) — no runtime representation', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as OpencodeConfig;
    for (const agentConfig of Object.values(compiled.agent)) {
      expect(agentConfig).not.toHaveProperty('connectors');
      expect(agentConfig).not.toHaveProperty('secrets');
      expect(agentConfig).not.toHaveProperty('kortix_cli');
      expect(agentConfig).not.toHaveProperty('workspace');
    }
  });

  test("top-level model passthrough is the default_agent's compiled model", () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as OpencodeConfig;
    expect(compiled.model).toBe('anthropic/claude-sonnet-5');
    expect(compiled.small_model).toBeUndefined();
  });

  test('omits top-level model when the default agent declares none', () => {
    const noModelManifest = parseYaml(`
kortix_version: 2
default_agent: pr-bot
agents:
  pr-bot:
    kortix_cli: []
`);
    const compiled = compileAgentConfig(noModelManifest, 'opencode', {
      '.kortix/opencode/agents/pr-bot.md': supportMd('mode: subagent', 'Reviews PRs'),
    }) as OpencodeConfig;
    expect(compiled.model).toBeUndefined();
  });
});

describe('compileAgentConfig — a stock OpenCode agent .md with frontmatter compiles cleanly', () => {
  test('no illegal-frontmatter error — frontmatter is expected, never illegal', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
    secrets: all
`);
    const content = supportMd(
      ['mode: primary', 'model: anthropic/claude-sonnet-5', 'permission: allow'].join('\n'),
      'You are a general-purpose Kortix agent.',
    );
    expect(() =>
      compileAgentConfig(manifest, 'opencode', { '.kortix/opencode/agents/kortix.md': content }),
    ).not.toThrow();
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/kortix.md': content,
    }) as OpencodeConfig;
    expect(compiled.agent.kortix).toEqual({
      mode: 'primary',
      model: 'anthropic/claude-sonnet-5',
      permission: 'allow',
      prompt: 'You are a general-purpose Kortix agent.',
    });
  });
});

describe('compileAgentConfig — governance-only agent block with no .md yet', () => {
  test('an agent with no `.md` content supplied compiles to governance overlay only', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: fresh
agents:
  fresh:
    connectors: none
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.fresh).toEqual({});
  });

  test('a body-only .md (no frontmatter at all) compiles with just the prompt', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a: {}
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': 'Just the body, no frontmatter.',
    }) as OpencodeConfig;
    expect(compiled.agent.a).toEqual({ prompt: 'Just the body, no frontmatter.' });
  });
});

describe('compileAgentConfig — `enabled: false` governance overlay', () => {
  test('forces `disable: true` regardless of the .md', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    enabled: false
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': supportMd('disable: false', 'Body.'),
    }) as OpencodeConfig;
    expect(compiled.agent.a.disable).toBe(true);
  });

  test('a hand-authored `disable: true` in the .md passes through when `enabled` is omitted', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a: {}
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': supportMd('disable: true', 'Body.'),
    }) as OpencodeConfig;
    expect(compiled.agent.a.disable).toBe(true);
  });
});

describe('compileAgentConfig — malformed .md frontmatter throws', () => {
  test('an invalid mode value throws a clear CompileAgentConfigError', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: support
agents:
  support: {}
`);
    const content = supportMd('mode: bogus', 'Body.');
    expect(() =>
      compileAgentConfig(manifest, 'opencode', {
        '.kortix/opencode/agents/support.md': content,
      }),
    ).toThrow(CompileAgentConfigError);
    try {
      compileAgentConfig(manifest, 'opencode', { '.kortix/opencode/agents/support.md': content });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(CompileAgentConfigError);
      const message = (err as InstanceType<typeof CompileAgentConfigError>).message;
      expect(message).toContain('support');
      expect(message).toContain('.kortix/opencode/agents/support.md');
      expect(message).toContain('mode');
    }
  });

  test('a malformed permission tree throws', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: support
agents:
  support: {}
`);
    const content = supportMd('permission: sometimes', 'Body.');
    expect(() =>
      compileAgentConfig(manifest, 'opencode', {
        '.kortix/opencode/agents/support.md': content,
      }),
    ).toThrow(CompileAgentConfigError);
  });
});

describe('compileAgentConfig — `skills` governance maps to permission.skill', () => {
  test('"all" compiles to a bare allow', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: all
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({ skill: 'allow' });
  });

  test('"none" compiles to a bare deny', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: none
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({ skill: 'deny' });
  });

  test('an empty list behaves like "none" (safe default)', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: []
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({ skill: 'deny' });
  });

  test('a specific list compiles to a glob map — named skills allow, `*` denies the rest', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: [pdf-export, web-research]
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({
      skill: { 'pdf-export': 'allow', 'web-research': 'allow', '*': 'deny' },
    });
  });

  test('governance `skills` overrides a hand-authored permission.skill rule in the .md', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: all
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': supportMd(
        ['permission:', '  skill: deny', '  edit: ask'].join('\n'),
        'Body.',
      ),
    }) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({ edit: 'ask', skill: 'allow' });
  });

  test('a bare whole-agent permission action from the .md is expanded so `skills` can own just `skill`', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: none
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': supportMd('permission: allow', 'Body.'),
    }) as OpencodeConfig;
    const permission = compiled.agent.a.permission as Record<string, unknown>;
    expect(permission.skill).toBe('deny');
    expect(permission.edit).toBe('allow');
    expect(permission.bash).toBe('allow');
  });

  test('omitting `skills` leaves a hand-authored permission.skill untouched', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a: {}
`);
    const compiled = compileAgentConfig(manifest, 'opencode', {
      '.kortix/opencode/agents/a.md': supportMd(
        ['permission:', '  skill:', '    "trusted-*": allow', '    "*": deny'].join('\n'),
        'Body.',
      ),
    }) as OpencodeConfig;
    expect(compiled.agent.a.permission).toEqual({
      skill: { 'trusted-*': 'allow', '*': 'deny' },
    });
  });

  test('never surfaces as a `skills` key on the compiled agent config (no runtime representation of its own)', () => {
    const manifest = parseYaml(`
kortix_version: 2
default_agent: a
agents:
  a:
    skills: [github-tools]
`);
    const compiled = compileAgentConfig(manifest) as OpencodeConfig;
    expect(compiled.agent.a).not.toHaveProperty('skills');
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
  manifestPath: 'kortix.yaml',
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

  test("reads each declared agent's conventional .md and returns the compiled JSON for a v2 manifest", async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {
      '.kortix/opencode/agents/support.md': 'Support body.',
      '.kortix/opencode/agents/pr-bot.md': 'PR bot body.',
    };
    readRepoFileCalls = [];
    const result = await resolveCompiledAgentConfigForSession(PROJECT);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as OpencodeConfig;
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.agent['pr-bot'].prompt).toBe('PR bot body.');
    expect(
      new Set(readRepoFileCalls.filter((p) => p.startsWith('.kortix/opencode/agents/'))),
    ).toEqual(
      new Set(['.kortix/opencode/agents/support.md', '.kortix/opencode/agents/pr-bot.md']),
    );
  });

  test('degrades gracefully (never throws) when a declared agent has no .md yet', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'Support body.' }; // pr-bot.md missing
    const result = await resolveCompiledAgentConfigForSession(PROJECT);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as OpencodeConfig;
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.agent['pr-bot']).toEqual({});
  });

  test('never throws — a malformed .md frontmatter compile error resolves to null instead', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: `
kortix_version: 2
default_agent: support
agents:
  support: {}
`,
    };
    mdFileContent = {
      '.kortix/opencode/agents/support.md': supportMd('mode: bogus', 'Body.'),
    };
    expect(await resolveCompiledAgentConfigForSession(PROJECT)).toBeNull();
  });
});
