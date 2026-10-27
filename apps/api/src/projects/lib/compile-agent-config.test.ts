import { describe, expect, mock, spyOn, test } from 'bun:test';
import { KORTIX_SKILL_NAMES, parseManifestText } from '@kortix/manifest-schema';

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
  compileSelectedAgentConfig,
  manifestPiCodemode,
  manifestPiPackageLists,
  manifestPiPackages,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} = await import('./compile-agent-config');
type CompiledAgents = Awaited<ReturnType<typeof compileAgentConfig>> & object;

// Governance-only v2 manifest — the 2026-07-05 redirect's shape. Behavior
// lives in each agent's own `.kortix/opencode/agents/<name>.md`.
const GOVERNANCE_FIXTURE = `
kortix_version: 2
default_agent: support

agents:
  support:
    connectors: [github, slack]
    secrets: [STRIPE_KEY, GH_TOKEN]
    kortix_permissions: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
    connectors: [github]
    kortix_permissions: [project.cr.open, project.cr.merge, project.review.submit]
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

describe('agentMarkdownPath (where a new or edited .md is written)', () => {
  test('defaults to agents/<name>.md', () => {
    expect(agentMarkdownPath({}, 'support')).toBe('agents/support.md');
  });

  test('an OpenCode config_dir no longer moves agents', () => {
    expect(agentMarkdownPath({ opencode: { config_dir: 'custom/dir' } }, 'support')).toBe(
      'agents/support.md',
    );
  });

  test('agents.<name>.file wins', () => {
    expect(agentMarkdownPath({ agents: { support: { file: 'team/support.md' } } }, 'support')).toBe(
      'team/support.md',
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
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as CompiledAgents;
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

  test('never copies governance fields (connectors/secrets/kortix_permissions/workspace) — no runtime representation', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as CompiledAgents;
    for (const agentConfig of Object.values(compiled.agent)) {
      expect(agentConfig).not.toHaveProperty('connectors');
      expect(agentConfig).not.toHaveProperty('secrets');
      expect(agentConfig).not.toHaveProperty('kortix_permissions');
      expect(agentConfig).not.toHaveProperty('workspace');
    }
  });

  test("top-level model passthrough is the default_agent's compiled model", () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as CompiledAgents;
    expect(compiled.model).toBe('anthropic/claude-sonnet-5');
    expect(compiled.small_model).toBeUndefined();
  });

  test('omits top-level model when the default agent declares none', () => {
    const noModelManifest = parseYaml(`
kortix_version: 2
default_agent: pr-bot
agents:
  pr-bot:
    kortix_permissions: []
`);
    const compiled = compileAgentConfig(noModelManifest, 'opencode', {
      '.kortix/opencode/agents/pr-bot.md': supportMd('mode: subagent', 'Reviews PRs'),
    }) as CompiledAgents;
    expect(compiled.model).toBeUndefined();
  });

  // W1 B5: pi reads `default_agent` for a session with no agent chosen; OpenCode reads the same key.
  test('names the manifest default_agent, so every runtime runs it when no agent is chosen', () => {
    const compiled = compileAgentConfig(manifest, 'opencode', agentMdFiles) as CompiledAgents;
    expect(compiled.default_agent).toBe('support');
  });

  test('omits default_agent when that agent cannot run as the primary one', () => {
    const subagent = parseYaml(`
kortix_version: 2
default_agent: pr-bot
agents:
  pr-bot:
    kortix_permissions: []
`);
    const disabled = parseYaml(`
kortix_version: 2
default_agent: support
agents:
  support:
    enabled: false
`);
    const md = { '.kortix/opencode/agents/pr-bot.md': supportMd('mode: subagent', 'Reviews PRs') };
    expect((compileAgentConfig(subagent, 'opencode', md) as CompiledAgents).default_agent).toBeUndefined();
    expect((compileAgentConfig(disabled, 'opencode', {}) as CompiledAgents).default_agent).toBeUndefined();
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
    }) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
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
    }) as CompiledAgents;
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
    }) as CompiledAgents;
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
    }) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
    expect(compiled.agent.a.permission).toEqual({
      skill: { 'pdf-export': 'allow', 'web-research': 'allow', '*': 'deny' },
    });
  });

  test('{ exclude } compiles to `*` allow and each named skill deny; an empty exclude is a bare allow', () => {
    const compiled = compileAgentConfig(parseYaml('kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    skills: { exclude: [kortix-goals] }\n')) as CompiledAgents;
    expect(compiled.agent.a.permission).toEqual({ skill: { '*': 'allow', 'kortix-goals': 'deny' } });
    const empty = compileAgentConfig(parseYaml('kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    skills: { exclude: [] }\n')) as CompiledAgents;
    expect(empty.agent.a.permission).toEqual({ skill: 'allow' });
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
    }) as CompiledAgents;
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
    }) as CompiledAgents;
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
    }) as CompiledAgents;
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
    const compiled = compileAgentConfig(manifest) as CompiledAgents;
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

describe('manifestPiPackages — the project pi packages a manifest declares', () => {
  test('the v2 harnesses.pi.packages list, entries kept as written', () => {
    const raw = parseYaml('kortix_version: 2\nruntime: pi\nagents:\n  a: {}\nharnesses:\n  pi:\n    packages:\n      - npm:pi-web-access@0.30.0\n      - source: ./x.ts\n        skills: []\n');
    expect(manifestPiPackages(raw)).toEqual(['npm:pi-web-access@0.30.0', { source: './x.ts', skills: [] }]);
  });

  const MULTI = parseYaml(
    [
      'kortix_version: 2',
      'default_agent: builder',
      'harnesses:',
      '  pi:',
      '    packages: [npm:pi-web-access@0.30.0, npm:shared@1.0.0, ./.kortix/pi/audit.ts]',
      'agents:',
      '  builder: {}',
      '  researcher:',
      '    harnesses:',
      '      pi:',
      '        packages: [npm:@juicesharp/rpiv-todo@2.11.0, { source: npm:shared@2.0.0, skills: [] }]',
      '  reviewer:',
      '    harnesses:',
      '      pi:',
      '        exclude: [pi-web-access, ./.kortix/pi/audit.ts]',
      '  twin: {}',
    ].join('\n'),
  );

  test('an agent gets the top-level list, minus its exclude, plus its own; its entry wins for the same package', () => {
    expect(manifestPiPackages(MULTI, 'researcher')).toEqual([
      'npm:pi-web-access@0.30.0',
      { source: 'npm:shared@2.0.0', skills: [] },
      './.kortix/pi/audit.ts',
      'npm:@juicesharp/rpiv-todo@2.11.0',
    ]);
    expect(manifestPiPackages(MULTI, 'reviewer')).toEqual(['npm:shared@1.0.0']);
    expect(manifestPiPackages(MULTI, 'builder')).toEqual(['npm:pi-web-access@0.30.0', 'npm:shared@1.0.0', './.kortix/pi/audit.ts']);
  });

  test('no agent named means the default agent; an unknown agent gets the top-level list', () => {
    expect(manifestPiPackages(MULTI)).toEqual(manifestPiPackages(MULTI, 'builder'));
    const reviewerDefault = { ...MULTI, default_agent: 'reviewer' };
    expect(manifestPiPackages(reviewerDefault, 'default')).toEqual(['npm:shared@1.0.0']);
    expect(manifestPiPackages(MULTI, 'ghost')).toEqual(manifestPiPackages(MULTI, 'builder'));
  });

  test('one list per distinct effective list: agents with the same list share it', () => {
    const lists = manifestPiPackageLists(MULTI);
    expect(lists).toHaveLength(3);
    expect(lists).toContainEqual(manifestPiPackages(MULTI, 'builder'));
    expect(lists).toContainEqual(manifestPiPackages(MULTI, 'researcher'));
    expect(lists).toContainEqual(['npm:shared@1.0.0']);
  });

  test('empty for a v1 manifest, no harnesses block, or a malformed one', () => {
    expect(manifestPiPackages(parseYaml('harnesses:\n  pi:\n    packages: [npm:a@1.0.0]\n'))).toEqual([]);
    expect(manifestPiPackages(parseYaml('kortix_version: 2\nagents:\n  a: {}\n'))).toEqual([]);
    expect(manifestPiPackages(parseYaml('kortix_version: 2\nharnesses:\n  pi:\n    packages: npm:a@1.0.0\n'))).toEqual([]);
    expect(manifestPiPackages(null)).toEqual([]);
  });
});

describe('manifestPiCodemode — harnesses.pi.codemode for the session agent', () => {
  const RAW = parseYaml(
    'kortix_version: 2\ndefault_agent: builder\nharnesses:\n  pi:\n    codemode: only\nagents:\n  builder: {}\n  quiet:\n    harnesses:\n      pi:\n        codemode: off\n',
  );

  test('an agent value replaces the top-level one; no agent named means the default agent', () => {
    expect(manifestPiCodemode(RAW, 'quiet')).toBe('off');
    expect(manifestPiCodemode(RAW, 'builder')).toBe('only');
    expect(manifestPiCodemode(RAW)).toBe('only');
    expect(manifestPiCodemode(RAW, 'default')).toBe('only');
  });

  test('null when nothing sets it, for a v1 manifest, or for a value outside off, on, only', () => {
    expect(manifestPiCodemode(parseYaml('kortix_version: 2\nagents:\n  a: {}\n'))).toBeNull();
    expect(manifestPiCodemode(parseYaml('harnesses:\n  pi:\n    codemode: off\n'))).toBeNull();
    expect(manifestPiCodemode(parseYaml('kortix_version: 2\nharnesses:\n  pi:\n    codemode: yes\n'))).toBeNull();
    expect(manifestPiCodemode(null)).toBeNull();
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

  test('a runtime: pi manifest still compiles its agents, and the read hands the manifest to the caller', async () => {
    manifestFile = { path: 'kortix.yaml', content: `${GOVERNANCE_FIXTURE}\nruntime: pi\n` };
    mdFileContent = { '.kortix/opencode/agents/support.md': 'Support body.' };
    let seen: Record<string, unknown> | null = null;
    const result = await resolveCompiledAgentConfigForSession(PROJECT, null, { onManifest: (raw) => { seen = raw; } });
    expect(result).not.toBeNull();
    expect((JSON.parse(result!) as CompiledAgents).agent.support.prompt).toBe('Support body.');
    expect((seen as Record<string, unknown> | null)?.runtime).toBe('pi');
    // The restricted-session compiler reads the same manifest and reports it too.
    seen = null;
    await resolveSelectedAgentConfigForSession(PROJECT, 'support', null, { onManifest: (raw) => { seen = raw; } });
    expect((seen as Record<string, unknown> | null)?.runtime).toBe('pi');
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
    const parsed = JSON.parse(result!) as CompiledAgents;
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
    const parsed = JSON.parse(result!) as CompiledAgents;
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

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const compiled = await resolveCompiledAgentConfigForSession(project);
      expect(compiled).not.toBeNull();
      expect(compiled && JSON.parse(compiled).agent['pr-bot']).toBeDefined();
      expect(compiled && JSON.parse(compiled).agent.support.prompt).toBe('Support prompt.');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
    const parsed = JSON.parse(result) as CompiledAgents;

    expect(Object.keys(parsed.agent)).toEqual(['support']);
    expect(parsed.agent.support.prompt).toBe('Support body.');
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
    // Root layout first, then the legacy layout that holds the file.
    expect(readRepoFileCalls).toEqual(['agents/support.md', '.kortix/opencode/agents/support.md']);
  });

  test('reads the root-layout agents/<name>.md without touching the legacy path', async () => {
    manifestFile = { path: 'kortix.yaml', content: GOVERNANCE_FIXTURE };
    mdFileContent = {
      'agents/support.md': supportMd('model: anthropic/claude-sonnet-4-5', 'Root body.'),
      '.kortix/opencode/agents/support.md': supportMd('model: anthropic/claude-sonnet-4-5', 'Legacy body.'),
    };
    readRepoFileCalls = [];

    const parsed = JSON.parse(await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')) as CompiledAgents;

    expect(parsed.agent.support.prompt).toBe('Root body.');
    expect(readRepoFileCalls).toEqual(['agents/support.md']);
  });

  test('an explicit agents.<name>.file is the only path read', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: GOVERNANCE_FIXTURE.replace('  support:\n', '  support:\n    file: team/support.md\n'),
    };
    mdFileContent = {
      'team/support.md': supportMd('model: anthropic/claude-sonnet-4-5', 'Team body.'),
      'agents/support.md': supportMd('model: anthropic/claude-sonnet-4-5', 'Root body.'),
    };
    readRepoFileCalls = [];

    const parsed = JSON.parse(await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')) as CompiledAgents;

    expect(parsed.agent.support.prompt).toBe('Team body.');
    expect(readRepoFileCalls).toEqual(['team/support.md']);
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

describe('v3 YAML-only agent boot', () => {
  test('reads only YAML and an explicit prompt_file at the session ref', async () => {
    manifestFile = { path: 'kortix.yaml', content: `kortix_version: 3
runtime: pi
default_agent: writer
agents:
  writer:
    model: test/model
    prompt: Be concise.
  reader:
    prompt_file: agents/reader.md
` };
    mdFileContent = { 'agents/reader.md': 'Read only.' };
    readRepoFileCalls = [];
    const result = await resolveCompiledAgentConfigForSession(PROJECT, 'feature/yaml');
    expect(JSON.parse(result!).agent.writer.prompt).toBe('Be concise.');
    expect(JSON.parse(result!).agent.reader.prompt).toBe('Read only.');
    expect(readRepoFileCalls).toEqual(['agents/reader.md']);
    const selected = JSON.parse(await resolveSelectedAgentConfigForSession(PROJECT, 'reader', 'feature/yaml'));
    expect(Object.keys(selected.agent).filter((name) => !selected.agent[name].disable)).toEqual(['reader']);
  });

  test('a missing prompt file never produces a partial agent configuration', async () => {
    manifestFile = { path: 'kortix.yaml', content: 'kortix_version: 3\ndefault_agent: writer\nagents:\n  writer:\n    prompt_file: agents/missing.md\n' };
    mdFileContent = {};
    await expect(resolveCompiledAgentConfigForSession(PROJECT)).rejects.toThrow('no such file');
    await expect(resolveSelectedAgentConfigForSession(PROJECT, 'writer')).rejects.toThrow('no such file');
  });

  test('compiles inline behavior without an agent markdown file and isolates selected agent', () => {
    const manifest = parseYaml(`kortix_version: 3\ndefault_agent: writer\nagents:\n  writer:\n    model: test/model\n    prompt: Speak briefly.\n    skills: [review]\n  reader:\n    prompt_file: agents/reader.md\n`);
    const files = { 'agents/reader.md': 'Read only.' };
    const compiled = compileAgentConfig(manifest, 'opencode', files);
    expect(compiled?.model).toBe('test/model');
    expect(compiled?.agent.writer?.prompt).toBe('Speak briefly.');
    expect(compiled?.agent.writer?.permission).toMatchObject({ skill: { '*': 'deny', review: 'allow' } });
    expect(compiled?.agent.reader?.prompt).toBe('Read only.');
    const selected = compileSelectedAgentConfig(manifest, 'reader', 'opencode', files);
    expect(Object.keys(selected.agent).filter((name) => !selected.agent[name]!.disable)).toEqual(['reader']);
    expect(selected.agent.reader?.prompt).toBe('Read only.');
    expect(() => compileAgentConfig(manifest, 'opencode')).toThrow('prompt_file');
    expect(() => compileAgentConfig({ ...manifest, agents: { writer: { prompt_file: '../secret.md' } } }, 'opencode', { '../secret.md': 'wrong' })).toThrow('prompt_file');
  });
});

// Prod 2026-10-14: a project whose declared agents held ~270 KB of prompts never
// booted (one env string over 128 KiB). A v3 project declares them in kortix.yaml.
describe('a compiled config over 128 KiB', () => {
  test('17 declared agents with ~300 KB of prompts reach the sandbox env, every string within the exec limit', async () => {
    const { buildSessionRuntimeEnv } = await import('./session-runtime-env');
    const { MAX_ENV_STRING_BYTES, envStringBytes, readCompiledAgentConfigEnv } = await import('@kortix/api-contract/compiled-agent-config-env');
    const words = 'read the evidence pack then cite each page and the quoted line before any claim about the class'.split(' ');
    const prose = (seed: number) => Array.from({ length: 3_600 }, (_, i) => words[(seed * 7 + i * i) % words.length]).join(' ');
    const agents: Record<string, unknown> = { lead: { mode: 'primary', prompt: 'Lead.' }, admin: { mode: 'primary', prompt: 'Admin.' } };
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      agents[`worker-${i}`] = { mode: 'subagent', model: 'kortix/test-model', variant: 'high', permission: 'allow', prompt_file: `agents/worker-${i}.md` };
      files[`agents/worker-${i}.md`] = prose(i);
    }
    const compiled = JSON.stringify(compileAgentConfig({ kortix_version: 3, default_agent: 'lead', agents }, 'opencode', files));
    expect(Buffer.byteLength(compiled)).toBeGreaterThan(280_000);

    const env = buildSessionRuntimeEnv({ projectId: 'p', sessionId: 's', compiledAgentConfig: compiled } as Parameters<typeof buildSessionRuntimeEnv>[0]);
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) expect({ name, fits: envStringBytes(name, value) <= MAX_ENV_STRING_BYTES }).toEqual({ name, fits: true });
    }
    const delivered = JSON.parse(readCompiledAgentConfigEnv(env)!);
    // v3 also compiles OpenCode's build/plan/general/explore as `disable: true` entries.
    expect(Object.keys(delivered.agent).filter((name) => !delivered.agent[name].disable)).toHaveLength(17);
    expect(delivered.agent['worker-14']).toMatchObject({ mode: 'subagent', model: 'kortix/test-model', variant: 'high', prompt: prose(14) });
    // `permission: allow` compiles to explicit rules; the omitted skills and subagents grants deny skill and task.
    expect(delivered.agent['worker-14'].permission).toMatchObject({ bash: 'allow', edit: 'allow', skill: 'deny', task: 'deny' });
  });
});

describe('v2 agent tool toggles', () => {
  test('manifest tool toggles compile per agent without changing other agents', () => {
    const config = compileAgentConfig({ kortix_version: 2, default_agent: 'worker', agents: { worker: { tools: { bash: false, read: true } }, other: {} } });
    expect(config?.agent.worker.tools).toEqual({ bash: false, read: true });
    expect(config?.agent.other.tools).toBeUndefined();
  });

  test('all, none, a list and exclude compile to the map a harness reads', () => {
    const config = compileAgentConfig({
      kortix_version: 2,
      default_agent: 'everything',
      agents: {
        everything: { tools: 'all' },
        nothing: { tools: 'none' },
        researcher: { tools: ['read', 'web_search', 'lookup_order'] },
        no_shell: { tools: { exclude: ['bash', 'edit'] } },
      },
    });
    expect(config?.agent.everything.tools).toBeUndefined();
    expect(config?.agent.nothing.tools).toEqual({ '*': false });
    expect(config?.agent.researcher.tools).toEqual({ '*': false, read: true, web_search: true, lookup_order: true });
    expect(config?.agent.no_shell.tools).toEqual({ bash: false, edit: false });
  });

  test('kortix_version 3 compiles tools on the inline agent', () => {
    const config = compileAgentConfig({ kortix_version: 3, default_agent: 'writer', agents: { writer: { prompt: 'Write.', tools: ['read'] } } });
    expect(config?.agent.writer.tools).toEqual({ '*': false, read: true });
  });
});

describe('project tools', () => {
  test('the valid top-level tools reach the compiled set as project_tools', () => {
    const manifest = {
      kortix_version: 2,
      default_agent: 'worker',
      tools: { lookup_order: 'tools/lookup_order.ts', note: 'integrations/crm/note.mjs', bash: 'tools/bash.ts', up: '../x.ts' },
      agents: { worker: {} },
    };
    const expected = { lookup_order: 'tools/lookup_order.ts', note: 'integrations/crm/note.mjs' };
    expect(compileAgentConfig(manifest)?.project_tools).toEqual(expected);
    expect(compileSelectedAgentConfig(manifest, 'worker').project_tools).toEqual(expected);
    expect(compileAgentConfig({ ...manifest, tools: undefined })?.project_tools).toBeUndefined();
  });

  const v2 = (tools?: unknown) => ({ kortix_version: 2, default_agent: 'worker', agents: { worker: {} }, ...(tools === undefined ? {} : { tools }) });
  const v3 = (tools?: unknown) => ({ kortix_version: 3, default_agent: 'worker', agents: { worker: { prompt: 'Work.' } }, ...(tools === undefined ? {} : { tools }) });

  test('without a tools key, kortix_tools is absent: the daemon loads every Kortix tool', () => {
    for (const manifest of [v2(), v3()]) {
      expect(compileAgentConfig(manifest)).not.toHaveProperty('kortix_tools');
      expect(compileSelectedAgentConfig(manifest, 'worker')).not.toHaveProperty('kortix_tools');
    }
  });

  test('with a tools key, kortix_tools lists the kortix:<name> entries; project_tools keeps module paths only', () => {
    const tools = {
      web_search: 'kortix:web_search',
      show: 'kortix:show',
      memory: 'tools/memory.ts',
      lookup_order: 'tools/lookup_order.ts',
      image_search: 'kortix:scrape_webpage',
      stray: 'kortix:web_search',
    };
    for (const manifest of [v2(tools)]) {
      for (const compiled of [compileAgentConfig(manifest)!, compileSelectedAgentConfig(manifest, 'worker')]) {
        expect(compiled.kortix_tools).toEqual(['web_search', 'show']);
        expect(compiled.project_tools).toEqual({ memory: 'tools/memory.ts', lookup_order: 'tools/lookup_order.ts' });
        expect(Object.values(compiled.project_tools ?? {}).some((path) => path.startsWith('kortix:'))).toBe(false);
      }
    }
  });

  test('an empty tools key (a map, or every line deleted) compiles to an empty kortix_tools list', () => {
    for (const tools of [{}, null]) {
      for (const manifest of [v2(tools)]) {
        expect(compileAgentConfig(manifest)?.kortix_tools).toEqual([]);
        expect(compileSelectedAgentConfig(manifest, 'worker').kortix_tools).toEqual([]);
        expect(compileAgentConfig(manifest)).not.toHaveProperty('project_tools');
      }
    }
  });
});

describe('compileAgentConfig — a denied bash/edit also denies the tools that do the same job', () => {
  const manifest = parseYaml(
    ['kortix_version: 2', 'default_agent: kortix', 'agents:', '  kortix:', '    skills: all', '  no-edit:', '    skills: all', ''].join('\n'),
  );
  const compileNoEdit = (frontmatter: string) =>
    compileAgentConfig(manifest, 'opencode', {
      'agents/no-edit.md': supportMd(frontmatter, 'body'),
    })!.agent['no-edit']!.permission as Record<string, unknown>;

  test('bash: deny and edit: deny deny pty_* and memory', () => {
    const permission = compileNoEdit('permission:\n  edit: deny\n  bash: deny\n  task: deny');
    expect(permission).toMatchObject({ edit: 'deny', bash: 'deny', task: 'deny', memory: 'deny' });
    for (const tool of ['pty_spawn', 'pty_write', 'pty_read', 'pty_kill', 'pty_list']) {
      expect(permission[tool]).toBe('deny');
    }
  });

  test('a pattern-scoped bash rule that allows something leaves pty_* alone', () => {
    const permission = compileNoEdit('permission:\n  bash:\n    "*": deny\n    "ls *": allow');
    expect(permission.pty_spawn).toBeUndefined();
  });

  test('an explicit rule on the tool wins', () => {
    const permission = compileNoEdit('permission:\n  bash: deny\n  pty_list: allow');
    expect(permission.pty_list).toBe('allow');
    expect(permission.pty_spawn).toBe('deny');
  });
});

describe('v3: the project registers, each agent enables', () => {
  const MANIFEST = `kortix_version: 3
default_agent: lead
skills:
  pdf: skills/pdf
  triage: support/skills/triage
tools:
  lookup_order: tools/lookup_order.ts
commands:
  weekly:
    description: Weekly report.
    prompt_file: commands/weekly.md
  summarize:
    prompt: Summarize $ARGUMENTS.
extensions:
  audit:
    opencode: extensions/audit.opencode.ts
    pi: extensions/audit.pi.ts
  web:
    pi: npm:pi-web-access@0.30.0
  adapter:
    pi:
      source: extensions/adapter
      extensions: ["*.ts"]
agents:
  lead:
    mode: primary
    prompt: Lead.
    skills: all
    subagents: all
    commands: [weekly, summarize]
    extensions: all
    codemode: only
  researcher:
    mode: subagent
    prompt_file: prompts/researcher.md
    permission:
      edit: deny
    skills: [triage, kortix-system]
    commands: [summarize]
    extensions: [web]
  quiet:
    mode: subagent
    prompt: Quiet.
    permission: deny
  off:
    mode: subagent
    prompt: Off.
    enabled: false
`;
  const FILES = { 'commands/weekly.md': 'Write the weekly report for $1.', 'prompts/researcher.md': 'Research.' };
  const compile = () => compileAgentConfig(parseYaml(MANIFEST), 'opencode', FILES)!;

  test('marks the set v3 and passes the registries through', () => {
    const set = compile();
    expect(set.schema).toBe(3);
    expect(set.skills).toEqual({ pdf: 'skills/pdf', triage: 'support/skills/triage' });
    expect(set.project_tools).toEqual({ lookup_order: 'tools/lookup_order.ts' });
    expect(set.kortix_tools).toBeUndefined();
    expect(set.extensions).toEqual({
      audit: { opencode: 'extensions/audit.opencode.ts', pi: 'extensions/audit.pi.ts' },
      web: { pi: 'npm:pi-web-access@0.30.0' },
      adapter: { pi: { source: 'extensions/adapter', extensions: ['*.ts'] } },
    });
  });

  test('a command carries its template and the agents that enable it', () => {
    expect(compile().commands).toEqual({
      weekly: { description: 'Weekly report.', template: 'Write the weekly report for $1.', agents: ['lead'] },
      summarize: { template: 'Summarize $ARGUMENTS.', agents: ['lead', 'researcher'] },
    });
  });

  test('permission defaults to allow, and the skills and subagents grants own skill and task', () => {
    const { lead, researcher, quiet } = compile().agent;
    const allSkills = Object.fromEntries([...KORTIX_SKILL_NAMES, 'pdf', 'triage'].map((name) => [name, 'allow']));
    expect(lead!.permission).toMatchObject({
      read: 'allow',
      bash: 'allow',
      external_directory: 'allow',
      skill: { ...allSkills, '*': 'deny' },
      task: { researcher: 'allow', quiet: 'allow', '*': 'deny' },
    });
    expect(researcher!.permission).toEqual({ edit: 'deny', memory: 'deny', skill: { triage: 'allow', 'kortix-system': 'allow', '*': 'deny' }, task: 'deny' });
    expect((quiet!.permission as Record<string, unknown>).bash).toBe('deny');
    expect((quiet!.permission as Record<string, unknown>).skill).toBe('deny');
  });

  test('extensions and codemode compile per agent', () => {
    const { lead, researcher, quiet } = compile().agent;
    expect(lead!.extensions).toEqual(['audit', 'web', 'adapter']);
    expect(lead!.codemode).toBe('only');
    expect(researcher!.extensions).toEqual(['web']);
    expect(quiet!.extensions).toBeUndefined();
  });

  test('only declared agents run: OpenCode built-ins are disabled, enabled: false disables', () => {
    const { agent } = compile();
    for (const name of ['build', 'plan', 'general', 'explore']) expect(agent[name]).toEqual({ disable: true });
    expect(agent.off!.disable).toBe(true);
    const declared = compileAgentConfig(parseYaml(MANIFEST.replace('  quiet:\n', '  general:\n')), 'opencode', FILES)!;
    expect(declared.agent.general!.prompt).toBe('Quiet.');
  });

  test('a selected agent keeps its subagents and only the commands they run', () => {
    const selected = compileSelectedAgentConfig(parseYaml(MANIFEST), 'researcher', 'opencode', FILES);
    expect(Object.keys(selected.agent).filter((name) => !selected.agent[name]!.disable).sort()).toEqual(['researcher']);
    expect(selected.commands).toEqual({ summarize: { template: 'Summarize $ARGUMENTS.', agents: ['researcher'] } });
    const lead = compileSelectedAgentConfig(parseYaml(MANIFEST), 'lead', 'opencode', FILES);
    expect(Object.keys(lead.agent).filter((name) => !lead.agent[name]!.disable).sort()).toEqual(['lead', 'quiet', 'researcher']);
  });

  test('skills { exclude } allows every skill but the named ones, including skills added later', () => {
    const set = compileAgentConfig(parseYaml(MANIFEST.replace('    skills: all\n', '    skills: { exclude: [kortix-goals, pdf] }\n')), 'opencode', FILES)!;
    expect((set.agent.lead!.permission as Record<string, unknown>).skill).toEqual({ '*': 'allow', 'kortix-goals': 'deny', pdf: 'deny' });
    const empty = compileAgentConfig(parseYaml(MANIFEST.replace('    skills: all\n', '    skills: { exclude: [] }\n')), 'opencode', FILES)!;
    expect((empty.agent.lead!.permission as Record<string, unknown>).skill).toBe('allow');
  });

  test('extensions { exclude } loads every registered extension but the named ones', () => {
    const raw = parseYaml(MANIFEST.replace('    extensions: all\n', '    extensions: { exclude: [web] }\n'));
    const set = compileAgentConfig(raw, 'opencode', FILES)!;
    expect(set.agent.lead!.extensions).toEqual(['audit', 'adapter']);
    expect(Object.keys(set.extensions ?? {}).sort()).toEqual(['adapter', 'audit', 'web']);
    expect(manifestPiPackages(raw, 'lead')).toEqual(['./extensions/audit.pi.ts', { source: './extensions/adapter', extensions: ['*.ts'] }]);
  });

  test('pi packages and codemode come from the session agent', () => {
    const raw = parseYaml(MANIFEST);
    expect(manifestPiPackages(raw, 'lead')).toEqual([
      './extensions/audit.pi.ts',
      'npm:pi-web-access@0.30.0',
      { source: './extensions/adapter', extensions: ['*.ts'] },
    ]);
    expect(manifestPiPackages(raw, 'researcher')).toEqual(['npm:pi-web-access@0.30.0']);
    expect(manifestPiPackages(raw, null)).toEqual(manifestPiPackages(raw, 'lead'));
    expect(manifestPiCodemode(raw, 'lead')).toBe('only');
    expect(manifestPiCodemode(raw, 'researcher')).toBeNull();
    expect(manifestPiPackageLists(raw)).toHaveLength(2);
  });
});

describe('v3: the session resolvers read every prompt file at the session ref', () => {
  const MANIFEST = 'kortix_version: 3\ndefault_agent: lead\ncommands:\n  weekly:\n    prompt_file: commands/weekly.md\nagents:\n  lead:\n    mode: primary\n    prompt_file: prompts/lead.md\n    commands: all\n';

  test('agent and command prompt files compile into the session config', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'prompts/lead.md': 'Lead.', 'commands/weekly.md': 'Weekly for $1.' };
    readRepoFileCalls = [];
    for (const read of [() => resolveCompiledAgentConfigForSession(PROJECT, 'main'), () => resolveSelectedAgentConfigForSession(PROJECT, 'lead', 'main')]) {
      const compiled = JSON.parse((await read())!);
      expect(compiled.agent.lead.prompt).toBe('Lead.');
      expect(compiled.commands.weekly).toEqual({ template: 'Weekly for $1.', agents: ['lead'] });
    }
    expect([...new Set(readRepoFileCalls)].sort()).toEqual(['commands/weekly.md', 'prompts/lead.md']);
  });

  test('an invalid v3 manifest fails the session instead of compiling partially', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST.replace('commands: all', 'commands: [nope]') };
    await expect(resolveCompiledAgentConfigForSession(PROJECT, 'main')).rejects.toThrow('not registered under `commands`');
  });
});

describe('allowlist rules put * first: OpenCode applies the last matching rule', () => {
  // `{ worker: allow, '*': deny }` resolves every name to deny on OpenCode, which then drops the tool.
  test('v3 subagents and skills allowlists start with *', () => {
    const set = compileAgentConfig({ kortix_version: 3, default_agent: 'lead', skills: { probe: 'skills/probe' }, agents: { lead: { mode: 'primary', prompt: 'x', skills: ['probe'], subagents: ['worker'] }, worker: { mode: 'subagent', prompt: 'y' } } })!;
    const permission = set.agent.lead!.permission as Record<string, Record<string, string>>;
    expect(Object.entries(permission.task!)).toEqual([['*', 'deny'], ['worker', 'allow']]);
    expect(Object.entries(permission.skill!)).toEqual([['*', 'deny'], ['probe', 'allow']]);
  });

  test('v2 skills allowlist starts with *', () => {
    const set = compileAgentConfig({ kortix_version: 2, default_agent: 'a', agents: { a: { skills: ['probe'] } } })!;
    expect(Object.entries((set.agent.a!.permission as Record<string, Record<string, string>>).skill!)).toEqual([['*', 'deny'], ['probe', 'allow']]);
  });
});

/**
 * OpenCode 1.18.23 (permission/index.ts `fromConfig` + `evaluate`): every
 * (key, pattern) rule in key order, the LAST match wins. `toEqual` ignores key
 * order, so only an evaluation like this one sees the order bug.
 */
function openCodeAction(permission: unknown, name: string, subject: string): string | undefined {
  const glob = (value: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/ \.\*$/, '( .*)?')}$`, 's').test(value);
  const block = typeof permission === 'string' ? { '*': permission } : (permission as Record<string, unknown>);
  const rules = Object.entries(block).flatMap(([key, rule]) =>
    typeof rule === 'string' ? [[key, '*', rule]] : Object.entries(rule as Record<string, string>).map(([pattern, action]) => [key, pattern, action]),
  );
  return rules.filter(([key, pattern]) => glob(name, key!) && glob(subject, pattern!)).at(-1)?.[2];
}

describe('compileAgentConfig — the most specific rule wins on OpenCode, whatever the authored order', () => {
  const wire = (set: unknown) => JSON.parse(JSON.stringify(set)) as CompiledAgents;

  test('v2: a skills list allows each listed skill and denies the rest (the prod failure shape)', () => {
    const set = wire(compileAgentConfig({ kortix_version: 2, default_agent: 'a', agents: { a: { skills: ['aie-os', 'probe'] } } }));
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'skill', 'aie-os')).toBe('allow');
    expect(openCodeAction(permission, 'skill', 'probe')).toBe('allow');
    expect(openCodeAction(permission, 'skill', 'other')).toBe('deny');
  });

  test('v2: an agent file bash map with `*` last keeps its specific rule', () => {
    const set = wire(
      compileAgentConfig({ kortix_version: 2, default_agent: 'a', agents: { a: { skills: ['probe'] } } }, 'opencode', {
        'agents/a.md': supportMd(['permission:', '  bash:', '    "git push *": ask', '    "*": allow'].join('\n'), 'Body.'),
      }),
    );
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'bash', 'git push origin main')).toBe('ask');
    expect(openCodeAction(permission, 'bash', 'ls')).toBe('allow');
  });

  test('v3: a tool key outranks a `*` written after it', () => {
    const set = wire(
      compileAgentConfig(parseYaml('kortix_version: 3\ndefault_agent: a\nagents:\n  a:\n    prompt: Hi.\n    permission:\n      bash: ask\n      edit:\n        "*.env": deny\n        "*": allow\n      "*": allow\n')),
    );
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'bash', 'ls')).toBe('ask');
    expect(openCodeAction(permission, 'edit', 'apps/api/.env')).toBe('deny');
    expect(openCodeAction(permission, 'read', 'x')).toBe('allow');
  });
});
