import { describe, expect, mock, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';

// compile-agent-config.ts's I/O half imports the real ../git module, which
// shells out to git + pulls in config/db — none of that runs in a bun:test
// process. Mock it BEFORE the dynamic import below so the pure-function tests
// (which don't touch git at all) and the I/O tests (which control it per-test)
// both load safely, mirroring the mock-then-dynamic-import pattern used
// throughout apps/api/src/projects/maintenance.test.ts and friends.
let manifestFile: { path: string; content: string } | null = null;
let mdFileContent: Record<string, string> = {};
let readRepoFileCalls: string[] = [];
// Which git ref each read asked for. The compiler used to read the project's
// DEFAULT branch even for a session on another ref, so a feature-branch session
// ran main's agents; recording the ref is what makes that visible.
let refsRead: string[] = [];
// Paths the mocked git should fail on with a NON-not-found error, so the
// transient-failure branch is reachable through the same seam as the fixtures.
let transientFailurePaths = new Set<string>();

// `mock.module` REPLACES the module — it does not merge. `../git` is a barrel,
// so anything omitted here stops existing for every module loaded afterwards in
// the same bun process, including ones this file never touches. That is not
// hypothetical: `session-reload.ts` importing `resolveCommitSha` from the barrel
// made `session-reload.test.ts` die with "Export named 'resolveCommitSha' not
// found" — but only when the two files ran together, and the error surfaced as
// an unhandled error between tests rather than against either of them.
//
// So the stubs below are deliberately broader than this file needs: they keep
// the barrel's shape intact for whoever loads next. Add to them rather than
// letting a sibling suite break.
mock.module('../git', () => ({
  readManifestFromRepo: async (_project: unknown, _candidates: unknown, ref: string) => {
    refsRead.push(ref);
    return manifestFile;
  },
  readRepoFile: async (_project: unknown, path: string, ref: string) => {
    readRepoFileCalls.push(path);
    refsRead.push(ref);
    if (transientFailurePaths.has(path)) throw new Error('fatal: unable to access remote');
    if (!(path in mdFileContent)) throw new Error(`no such file: ${path}`);
    return mdFileContent[path];
  },
  // A missing file is the expected client condition the compiler tolerates; a
  // git/transport failure is not. The fixtures above throw `no such file: …`
  // for a declared agent with no .md, so the predicate recognises exactly that
  // and treats anything else as a real failure — which is the distinction the
  // compiler now depends on.
  isRepoFileNotFoundError: (err: unknown) =>
    /no such file/.test(String((err as Error)?.message ?? '')),
  // Unused here; present so the barrel keeps its shape for other modules.
  resolveCommitSha: async () => '0'.repeat(40),
  invalidateProjectMirror: () => {},
}));

const {
  BEHAVIOR_FRONTMATTER_KEYS,
  CompileAgentConfigError,
  KNOWN_BEHAVIOR_KEYS,
  OpencodeAgentConfigSchema,
  agentMarkdownPath,
  compileAgentConfig,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
  withSubprojectInstructions,
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

describe('resolveCompiledAgentConfigForSession — the ref it compiles from', () => {
  test("compiles from the SESSION's ref, not the project default", async () => {
    // The bug this covers: a session started on a feature branch compiled main's
    // manifest and main's agent .md files, so editing an agent, pushing the
    // branch and starting a session on it changed nothing. It read as "config
    // never reloads" when in truth the branch was never read.
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {
      '.kortix/opencode/agents/support.md': 'Support body.',
      '.kortix/opencode/agents/pr-bot.md': 'PR bot body.',
    };
    refsRead = [];

    await resolveCompiledAgentConfigForSession(PROJECT, 'feature/new-agent');

    expect(new Set(refsRead)).toEqual(new Set(['feature/new-agent']));
    expect(refsRead).not.toContain('main');
  });

  test('falls back to the default branch when the session names no ref', async () => {
    // Every caller before this took the default branch; omitting the argument
    // must stay byte-identical to that.
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'x', '.kortix/opencode/agents/pr-bot.md': 'y' };
    refsRead = [];

    await resolveCompiledAgentConfigForSession(PROJECT);

    expect(new Set(refsRead)).toEqual(new Set(['main']));
  });

  test('a blank ref is treated as absent, not as a ref named ""', async () => {
    // `base_ref` is a plain text column; an empty string would otherwise ask git
    // for a ref that cannot exist and drop the whole agent config to null.
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'x', '.kortix/opencode/agents/pr-bot.md': 'y' };
    refsRead = [];

    await resolveCompiledAgentConfigForSession(PROJECT, '   ');

    expect(new Set(refsRead)).toEqual(new Set(['main']));
  });
});

/**
 * A transient git failure must not quietly produce a lobotomised agent.
 *
 * Every read error used to be swallowed with a warning, so a blip reading one
 * agent's `.md` compiled that agent with NO prompt, model, or permissions — and
 * the reload that triggered it reported success with a fresh etag saying the
 * session was current. The agent kept answering, just without its instructions.
 *
 * A MISSING file is different: the manifest may legitimately declare an agent
 * that carries no behavior file, and that case must keep working.
 */
describe('resolveCompiledAgentConfigForSession — read failures', () => {
  const project = {
    projectId: 'proj-1',
    repoUrl: 'https://example.test/r.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: null,
  };

  test('a MISSING .md still compiles — that agent simply has no behavior', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {
      '.kortix/opencode/agents/support.md': supportMd('mode: primary', 'Support prompt.'),
      // pr-bot.md deliberately absent
    };

    const compiled = await resolveCompiledAgentConfigForSession(project);

    expect(compiled).not.toBeNull();
    expect(JSON.parse(compiled as string).agent['pr-bot']).toBeDefined();
    expect(JSON.parse(compiled as string).agent.support.prompt).toBe('Support prompt.');
  });

  test('a TRANSIENT git failure yields null, not an agent stripped of its prompt', async () => {
    // null means "no compiled config": the session keeps what it is running and
    // `stale` reads null ("could not tell") rather than a confident, wrong
    // "up to date". Far better than swapping in an agent with no instructions.
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {};
    transientFailurePaths = new Set(['.kortix/opencode/agents/support.md']);
    try {
      expect(await resolveCompiledAgentConfigForSession(project)).toBeNull();
    } finally {
      transientFailurePaths = new Set();
    }
  });
});

describe('resolveSelectedAgentConfigForSession', () => {
  test('reads and emits only the selected agent', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {
      '.kortix/opencode/agents/support.md': supportMd(
        'model: anthropic/claude-sonnet-4-5',
        'Support body.',
      ),
      '.kortix/opencode/agents/pr-bot.md': 'PR bot body.',
    };
    readRepoFileCalls = [];

    const result = await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main');
    const parsed = JSON.parse(result) as OpencodeConfig;

    expect(Object.keys(parsed.agent)).toEqual(['support']);
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
    expect(readRepoFileCalls).toEqual(['.kortix/opencode/agents/support.md']);
  });

  test('fails closed when the selected agent configuration cannot be read', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {};
    transientFailurePaths = new Set(['.kortix/opencode/agents/support.md']);

    try {
      await expect(
        resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main'),
      ).rejects.toThrow('fatal: unable to access remote');
    } finally {
      transientFailurePaths = new Set();
    }
  });

  test('fails closed when the selected agent is not declared', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };

    await expect(
      resolveSelectedAgentConfigForSession(PROJECT, 'missing', 'main'),
    ).rejects.toThrow('not declared');
  });
});

// ─── subproject `context[]` → top-level `instructions` (spec §7) ────────────

const SUBPROJECT_FIXTURE = `
kortix_version: 2
default_agent: support

agents:
  support:
    workspace: runtime

subprojects:
  marketing:
    name: Marketing
    instructions: |
      Always write in British English.
    context:
      - docs/brand.md
      - .kortix/subprojects/marketing/
      - docs/brand.md
  bare:
    name: Bare
`;

describe('withSubprojectInstructions', () => {
  const compiled = { agent: { support: { prompt: 'Support body.' } } };

  test('maps files through and a trailing-slash directory to a markdown glob', () => {
    const out = withSubprojectInstructions(
      compiled,
      parseYaml(SUBPROJECT_FIXTURE),
      'marketing',
    );
    expect(out.instructions).toEqual([
      'docs/brand.md',
      '.kortix/subprojects/marketing/**/*.md',
    ]);
  });

  test('never rewrites the agent prompt — instructions are additive', () => {
    const out = withSubprojectInstructions(
      compiled,
      parseYaml(SUBPROJECT_FIXTURE),
      'marketing',
    );
    expect(out.agent.support.prompt).toBe('Support body.');
    expect(compiled).not.toHaveProperty('instructions');
  });

  test('emits no key for no slug, an undeclared slug, or a subproject with no context', () => {
    const manifest = parseYaml(SUBPROJECT_FIXTURE);
    expect(withSubprojectInstructions(compiled, manifest, null)).not.toHaveProperty(
      'instructions',
    );
    expect(withSubprojectInstructions(compiled, manifest, 'nope')).not.toHaveProperty(
      'instructions',
    );
    expect(withSubprojectInstructions(compiled, manifest, 'bare')).not.toHaveProperty(
      'instructions',
    );
  });

  test('appends to instructions the config already declares, without duplicating', () => {
    const out = withSubprojectInstructions(
      { ...compiled, instructions: ['docs/brand.md'] },
      parseYaml(SUBPROJECT_FIXTURE),
      'marketing',
    );
    expect(out.instructions).toEqual([
      'docs/brand.md',
      '.kortix/subprojects/marketing/**/*.md',
    ]);
  });
});

describe('subproject instructions through the I/O resolvers', () => {
  test('resolveCompiledAgentConfigForSession emits them when the session names a subproject', async () => {
    manifestFile = { path: 'kortix.yaml', content: SUBPROJECT_FIXTURE };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'Support body.' };

    const withSub = JSON.parse(
      (await resolveCompiledAgentConfigForSession(PROJECT, 'main', {
        subproject: 'marketing',
      }))!,
    );
    expect(withSub.instructions).toEqual([
      'docs/brand.md',
      '.kortix/subprojects/marketing/**/*.md',
    ]);
    expect(withSub.agent.support.prompt).toBe('Support body.');

    const without = JSON.parse((await resolveCompiledAgentConfigForSession(PROJECT, 'main'))!);
    expect(without).not.toHaveProperty('instructions');
    expect(
      JSON.parse(
        (await resolveCompiledAgentConfigForSession(PROJECT, 'main', { subproject: 'gone' }))!,
      ),
    ).not.toHaveProperty('instructions');
  });

  test('resolveSelectedAgentConfigForSession emits them for a restricted session too', async () => {
    manifestFile = { path: 'kortix.yaml', content: SUBPROJECT_FIXTURE };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'Support body.' };

    const compiled = JSON.parse(
      await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main', {
        subproject: 'marketing',
      }),
    );
    expect(compiled.instructions).toEqual([
      'docs/brand.md',
      '.kortix/subprojects/marketing/**/*.md',
    ]);
    expect(compiled.agent.support.prompt).toBe('Support body.');
    expect(
      JSON.parse(await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')),
    ).not.toHaveProperty('instructions');
  });
});
