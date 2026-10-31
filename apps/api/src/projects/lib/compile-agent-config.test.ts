import { describe, expect, mock, test } from 'bun:test';
import { AGENT_BLOCK_KEYS_V3, KORTIX_SKILL_NAMES, parseManifestText, usableManifest, validateManifest } from '@kortix/manifest-schema';

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
  resolveRemoteBranchTip: async () => null,
  invalidateProjectMirror: () => {},
}));

const {
  CompileAgentConfigError,
  OpencodeAgentConfigSchema,
  compileAgentConfig,
  compileSelectedAgentConfig,
  manifestPiCodemode,
  manifestPiPackageLists,
  manifestPiPackages,
  resolveCompiledAgentConfigForSession,
  resolveSelectedAgentConfigForSession,
} = await import('./compile-agent-config');
type CompiledAgents = ReturnType<typeof compileAgentConfig>;

const MANIFEST = `default_agent: support
agents:
  support:
    model: anthropic/claude-sonnet-4-5
    prompt_file: agents/support.md
    tools: all
  pr-bot:
    mode: subagent
    prompt_file: agents/pr-bot.md
    tools: all
`;

function parseYaml(raw: string): Record<string, unknown> {
  return parseManifestText(raw);
}

describe('OpencodeAgentConfigSchema (the agent editor\'s behavior half)', () => {
  test('every field but `prompt` is an agent block key, so a save never writes a key the manifest refuses', () => {
    const schemaKeys = Object.keys(OpencodeAgentConfigSchema.shape);
    expect(schemaKeys).toContain('prompt');
    expect(schemaKeys.filter((key) => key !== 'prompt' && !(AGENT_BLOCK_KEYS_V3 as readonly string[]).includes(key))).toEqual([]);
  });
});

describe('a broken part of kortix.yaml is turned off, never fatal', () => {
  test('one broken agent compiles off; the others compile; manifest_issues names the error', () => {
    // What `resolveCompiledAgentConfigForSession` does with the file it read.
    const { parsed, issues } = validateManifest(
      'default_agent: lead\nagents:\n  lead:\n    prompt: Lead.\n  broken:\n    prompt: Broken.\n    temperature: hot\n',
    );
    const set = compileAgentConfig(usableManifest(parsed, issues), {}, [...issues]);
    expect(set.schema).toBe(3);
    expect(set.default_agent).toBe('lead');
    expect(set.agent.lead!.prompt).toBe('Lead.');
    expect(set.agent.broken).toEqual({ disable: true });
    expect(set.manifest_issues?.[0]).toMatchObject({ path: 'agents.broken.temperature', severity: 'error', line: 7 });
  });

  test('a missing prompt file turns its agent off and names the file; a selected agent without it throws', () => {
    const manifest = parseYaml(MANIFEST);
    const set = compileAgentConfig(manifest, { 'agents/support.md': 'Support.' });
    expect(set.agent.support!.prompt).toBe('Support.');
    expect(set.agent['pr-bot']).toEqual({ disable: true });
    expect(set.manifest_issues).toEqual([
      expect.objectContaining({ path: 'agents.pr-bot.prompt_file', severity: 'error' }),
    ]);
    expect(() => compileSelectedAgentConfig(manifest, 'pr-bot', {})).toThrow(CompileAgentConfigError);
    expect(() => compileSelectedAgentConfig(manifest, 'pr-bot', {})).toThrow('off');
    // A path outside the repository is never read.
    const escaped = compileAgentConfig({ default_agent: 'w', agents: { w: { prompt_file: '../secret.md' } } }, { '../secret.md': 'wrong' });
    expect(escaped.agent.w).toEqual({ disable: true });
  });

  test('warnings never reach the session: only errors, at most 50', () => {
    const obsolete = { path: 'kortix_version', message: 'obsolete', severity: 'warning' as const };
    expect(compileAgentConfig({}, {}, [obsolete]).manifest_issues).toBeUndefined();

    const issues = [
      obsolete,
      ...Array.from({ length: 60 }, (_, i) => ({ path: `triggers[${i}].cron`, message: 'bad', severity: 'error' as const })),
    ];
    const set = compileAgentConfig({}, {}, issues);
    expect(set.manifest_issues).toHaveLength(50);
    expect(set.manifest_issues!.every((issue) => issue.severity === 'error')).toBe(true);
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

  test("reads each agent's prompt file and hands the applied manifest to the caller", async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'agents/support.md': 'Support body.', 'agents/pr-bot.md': 'PR bot body.' };
    readRepoFileCalls = [];
    let seen: Record<string, unknown> | null = null;
    const parsed = JSON.parse((await resolveCompiledAgentConfigForSession(PROJECT, null, { onManifest: (raw) => { seen = raw; } }))!) as CompiledAgents;
    expect(parsed.agent.support!.prompt).toBe('Support body.');
    expect(parsed.agent['pr-bot']!.prompt).toBe('PR bot body.');
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
    expect(parsed.manifest_issues).toBeUndefined();
    expect(new Set(readRepoFileCalls)).toEqual(new Set(['agents/support.md', 'agents/pr-bot.md']));
    expect((seen as Record<string, unknown> | null)?.default_agent).toBe('support');
  });

  test('a manifest with an error compiles what the project applies and carries the issue', async () => {
    manifestFile = {
      path: 'kortix.yaml',
      content: 'default_agent: lead\ncommands:\n  weekly:\n    prompt: Weekly.\nagents:\n  lead:\n    prompt: Lead.\n  helper:\n    prompt: Help.\n    commands: [nope]\n',
    };
    const parsed = JSON.parse((await resolveCompiledAgentConfigForSession(PROJECT, 'main'))!) as CompiledAgents;
    expect(parsed.agent.lead!.prompt).toBe('Lead.');
    expect(parsed.agent.helper).toEqual({ disable: true });
    expect(parsed.manifest_issues?.[0]).toMatchObject({ path: expect.stringMatching(/^agents\.helper\.commands/), severity: 'error' });
  });

  test('a YAML syntax error compiles the built-ins only and names the error', async () => {
    manifestFile = { path: 'kortix.yaml', content: 'agents:\n  lead: [unclosed\n' };
    const parsed = JSON.parse((await resolveCompiledAgentConfigForSession(PROJECT))!) as CompiledAgents;
    expect(Object.values(parsed.agent).every((agent) => agent.disable === true)).toBe(true);
    expect(parsed.manifest_issues?.[0]).toMatchObject({ path: '<yaml>', severity: 'error' });
  });

  test('a TRANSIENT git failure throws, never an agent stripped of its prompt', async () => {
    // The caller keeps the config the session runs and `stale` reads null
    // ("could not tell") rather than a confident, wrong "up to date".
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = {};
    transientFailurePaths = new Set(['agents/support.md']);
    try {
      await expect(resolveCompiledAgentConfigForSession(PROJECT)).rejects.toThrow('fatal: unable to access remote');
    } finally {
      transientFailurePaths = new Set();
    }
  });
});

describe('resolveCompiledAgentConfigForSession — the ref it compiles from', () => {
  test("compiles from the SESSION's ref, not the project default", async () => {
    // The bug this covers: a session started on a feature branch compiled main's
    // manifest and main's prompt files, so editing an agent, pushing the branch
    // and starting a session on it changed nothing.
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'agents/support.md': 'x', 'agents/pr-bot.md': 'y' };
    refsRead = [];
    await resolveCompiledAgentConfigForSession(PROJECT, 'feature/new-agent');
    expect(new Set(refsRead)).toEqual(new Set(['feature/new-agent']));
  });

  test('falls back to the default branch when the session names no ref, or a blank one', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'agents/support.md': 'x', 'agents/pr-bot.md': 'y' };
    for (const ref of [undefined, '   ']) {
      refsRead = [];
      await resolveCompiledAgentConfigForSession(PROJECT, ref);
      expect(new Set(refsRead)).toEqual(new Set(['main']));
    }
  });
});

describe('resolveSelectedAgentConfigForSession', () => {
  test('reads and emits only the selected agent', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'agents/support.md': 'Support body.', 'agents/pr-bot.md': 'PR bot body.' };
    const parsed = JSON.parse(await resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')) as CompiledAgents;
    expect(Object.keys(parsed.agent).filter((name) => !parsed.agent[name]!.disable)).toEqual(['support']);
    expect(parsed.agent.support!.prompt).toBe('Support body.');
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
  });

  test('a selected agent that is missing or off fails with an error naming the issue', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = { 'agents/support.md': 'x', 'agents/pr-bot.md': 'y' };
    await expect(resolveSelectedAgentConfigForSession(PROJECT, 'missing', 'main')).rejects.toThrow('not declared');
    manifestFile = { path: 'kortix.yaml', content: `${MANIFEST}    temperature: hot\n` };
    await expect(resolveSelectedAgentConfigForSession(PROJECT, 'pr-bot', 'main')).rejects.toThrow(/off\. Fix kortix\.yaml: agents\.pr-bot\.temperature/);
  });

  test('a project without a manifest fails selected-agent compilation', async () => {
    manifestFile = null;
    await expect(resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')).rejects.toThrow('no manifest');
  });

  test('fails closed when the selected agent prompt cannot be read', async () => {
    manifestFile = { path: 'kortix.yaml', content: MANIFEST };
    mdFileContent = {};
    transientFailurePaths = new Set(['agents/support.md']);
    try {
      await expect(resolveSelectedAgentConfigForSession(PROJECT, 'support', 'main')).rejects.toThrow('fatal: unable to access remote');
    } finally {
      transientFailurePaths = new Set();
    }
  });
});

describe('YAML-only agent boot', () => {
  test('reads only YAML and an explicit prompt_file at the session ref', async () => {
    manifestFile = { path: 'kortix.yaml', content: `default_agent: writer
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

  test('compiles inline behavior without an agent markdown file and isolates selected agent', () => {
    const manifest = parseYaml(`default_agent: writer\nskills:\n  review: skills/review\nagents:\n  writer:\n    model: test/model\n    prompt: Speak briefly.\n    skills: [review]\n  reader:\n    prompt_file: agents/reader.md\n`);
    const files = { 'agents/reader.md': 'Read only.' };
    const compiled = compileAgentConfig(manifest, files);
    expect(compiled.model).toBe('test/model');
    expect(compiled.agent.writer?.prompt).toBe('Speak briefly.');
    expect(compiled.agent.writer?.permission).toMatchObject({ skill: { '*': 'deny', review: 'allow' } });
    expect(compiled.agent.reader?.prompt).toBe('Read only.');
    const selected = compileSelectedAgentConfig(manifest, 'reader', files);
    expect(Object.keys(selected.agent).filter((name) => !selected.agent[name]!.disable)).toEqual(['reader']);
    expect(selected.agent.reader?.prompt).toBe('Read only.');
  });
});

// Prod 2026-10-14: a project whose declared agents held ~270 KB of prompts never
// booted (one env string over 128 KiB). A project declares them in kortix.yaml.
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
    const compiled = JSON.stringify(compileAgentConfig({ default_agent: 'lead', agents }, files));
    expect(Buffer.byteLength(compiled)).toBeGreaterThan(280_000);

    const env = buildSessionRuntimeEnv({ projectId: 'p', sessionId: 's', compiledAgentConfig: compiled } as Parameters<typeof buildSessionRuntimeEnv>[0]);
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined) expect({ name, fits: envStringBytes(name, value) <= MAX_ENV_STRING_BYTES }).toEqual({ name, fits: true });
    }
    const delivered = JSON.parse(readCompiledAgentConfigEnv(env)!);
    // The set also compiles OpenCode's build/plan/general/explore as `disable: true` entries.
    expect(Object.keys(delivered.agent).filter((name) => !delivered.agent[name].disable)).toHaveLength(17);
    expect(delivered.agent['worker-14']).toMatchObject({ mode: 'subagent', model: 'kortix/test-model', variant: 'high', prompt: prose(14) });
    // `permission: allow` compiles to explicit rules; the omitted skills and subagents grants deny skill and task.
    expect(delivered.agent['worker-14'].permission).toMatchObject({ bash: 'allow', edit: 'allow', skill: 'deny', task: 'deny' });
  });
});

describe('agent tools', () => {
  test('all, none, a list and exclude compile to the map a harness reads', () => {
    const config = compileAgentConfig({
      default_agent: 'everything',
      agents: {
        everything: { prompt: 'x', tools: 'all' },
        nothing: { prompt: 'x', tools: 'none' },
        researcher: { prompt: 'x', tools: ['read', 'web_search', 'lookup_order'] },
        no_shell: { prompt: 'x', tools: { exclude: ['bash', 'edit'] } },
        unset: { prompt: 'x' },
      },
    });
    expect(config.agent.everything!.tools).toBeUndefined();
    expect(config.agent.nothing!.tools).toEqual({ '*': false });
    expect(config.agent.researcher!.tools).toEqual({ '*': false, read: true, web_search: true, lookup_order: true });
    expect(config.agent.no_shell!.tools).toEqual({ bash: false, edit: false });
    expect(config.agent.unset!.tools).toBeUndefined();
  });

  test("an agent's exclude turns image_gen off for that agent only", () => {
    const compiled = compileAgentConfig({ default_agent: 'worker', agents: { worker: { prompt: 'x', tools: { exclude: ['image_gen'] } }, other: { prompt: 'y' } } });
    expect(compiled.agent.worker!.tools).toEqual({ image_gen: false });
    expect(compiled.agent.other!.tools).toBeUndefined();
  });
});

describe('project tools', () => {
  const manifest = (tools?: unknown) => ({ default_agent: 'worker', agents: { worker: { prompt: 'Work.' } }, ...(tools === undefined ? {} : { tools }) });

  test('the valid top-level tools reach the compiled set as project_tools', () => {
    const withTools = manifest({ lookup_order: 'tools/lookup_order.ts', note: 'integrations/crm/note.mjs', bash: 'tools/bash.ts', up: '../x.ts' });
    const expected = { lookup_order: 'tools/lookup_order.ts', note: 'integrations/crm/note.mjs' };
    expect(compileAgentConfig(withTools).project_tools).toEqual(expected);
    expect(compileSelectedAgentConfig(withTools, 'worker').project_tools).toEqual(expected);
    expect(compileAgentConfig(manifest()).project_tools).toBeUndefined();
  });

  test('kortix_tools is never set: a session loads every Kortix tool', () => {
    for (const tools of [undefined, {}, { lookup_order: 'tools/lookup_order.ts' }]) {
      expect(compileAgentConfig(manifest(tools))).not.toHaveProperty('kortix_tools');
      expect(compileSelectedAgentConfig(manifest(tools), 'worker')).not.toHaveProperty('kortix_tools');
    }
  });

  test('image_gen mapped to a project module compiles as a project tool', () => {
    expect(compileAgentConfig(manifest({ image_gen: 'tools/img.ts' })).project_tools?.image_gen).toBe('tools/img.ts');
  });
});

describe('compileAgentConfig — a denied bash/edit also denies the tools that do the same job', () => {
  const compileNoEdit = (permission: Record<string, unknown>) =>
    compileAgentConfig({ default_agent: 'kortix', agents: { kortix: { prompt: 'x' }, 'no-edit': { prompt: 'body', permission } } }).agent['no-edit']!
      .permission as Record<string, unknown>;

  test('bash: deny and edit: deny deny pty_* and memory', () => {
    const permission = compileNoEdit({ edit: 'deny', bash: 'deny' });
    expect(permission).toMatchObject({ edit: 'deny', bash: 'deny', task: 'deny', memory: 'deny' });
    for (const tool of ['pty_spawn', 'pty_write', 'pty_read', 'pty_kill', 'pty_list']) {
      expect(permission[tool]).toBe('deny');
    }
  });

  test('a pattern-scoped bash rule that allows something leaves pty_* alone', () => {
    const permission = compileNoEdit({ bash: { '*': 'deny', 'ls *': 'allow' } });
    expect(permission.pty_spawn).toBeUndefined();
  });

  test('an explicit rule on the tool wins', () => {
    const permission = compileNoEdit({ bash: 'deny', pty_list: 'allow' });
    expect(permission.pty_list).toBe('allow');
    expect(permission.pty_spawn).toBe('deny');
  });
});

describe('the project registers, each agent enables', () => {
  const MANIFEST = `default_agent: lead
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
  const compile = () => compileAgentConfig(parseYaml(MANIFEST), FILES)!;

  test('marks the set `schema: 3` and passes the registries through', () => {
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

  test('only declared agents run: OpenCode built-ins are disabled, enabled: false compiles to disable alone', () => {
    const { agent } = compile();
    for (const name of ['build', 'plan', 'general', 'explore']) expect(agent[name]).toEqual({ disable: true });
    expect(agent.off).toEqual({ disable: true });
    const declared = compileAgentConfig(parseYaml(MANIFEST.replace('  quiet:\n', '  general:\n')), FILES)!;
    expect(declared.agent.general!.prompt).toBe('Quiet.');
  });

  test('a selected agent keeps its subagents and only the commands they run', () => {
    const selected = compileSelectedAgentConfig(parseYaml(MANIFEST), 'researcher', FILES);
    expect(Object.keys(selected.agent).filter((name) => !selected.agent[name]!.disable).sort()).toEqual(['researcher']);
    expect(selected.commands).toEqual({ summarize: { template: 'Summarize $ARGUMENTS.', agents: ['researcher'] } });
    const lead = compileSelectedAgentConfig(parseYaml(MANIFEST), 'lead', FILES);
    expect(Object.keys(lead.agent).filter((name) => !lead.agent[name]!.disable).sort()).toEqual(['lead', 'quiet', 'researcher']);
  });

  test('skills { exclude } allows every skill but the named ones, including skills added later', () => {
    const set = compileAgentConfig(parseYaml(MANIFEST.replace('    skills: all\n', '    skills: { exclude: [kortix-goals, pdf] }\n')), FILES)!;
    expect((set.agent.lead!.permission as Record<string, unknown>).skill).toEqual({ '*': 'allow', 'kortix-goals': 'deny', pdf: 'deny' });
    const empty = compileAgentConfig(parseYaml(MANIFEST.replace('    skills: all\n', '    skills: { exclude: [] }\n')), FILES)!;
    expect((empty.agent.lead!.permission as Record<string, unknown>).skill).toBe('allow');
  });

  test('extensions { exclude } loads every registered extension but the named ones', () => {
    const raw = parseYaml(MANIFEST.replace('    extensions: all\n', '    extensions: { exclude: [web] }\n'));
    const set = compileAgentConfig(raw, FILES)!;
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

describe('the session resolvers read every prompt file at the session ref', () => {
  const COMMANDS = 'default_agent: lead\ncommands:\n  weekly:\n    prompt_file: commands/weekly.md\nagents:\n  lead:\n    mode: primary\n    prompt_file: prompts/lead.md\n    commands: all\n    tools: all\n';

  test('agent and command prompt files compile into the session config', async () => {
    manifestFile = { path: 'kortix.yaml', content: COMMANDS };
    mdFileContent = { 'prompts/lead.md': 'Lead.', 'commands/weekly.md': 'Weekly for $1.' };
    readRepoFileCalls = [];
    for (const read of [() => resolveCompiledAgentConfigForSession(PROJECT, 'main'), () => resolveSelectedAgentConfigForSession(PROJECT, 'lead', 'main')]) {
      const compiled = JSON.parse((await read())!);
      expect(compiled.agent.lead.prompt).toBe('Lead.');
      expect(compiled.commands.weekly).toEqual({ template: 'Weekly for $1.', agents: ['lead'] });
    }
    expect([...new Set(readRepoFileCalls)].sort()).toEqual(['commands/weekly.md', 'prompts/lead.md']);
  });

  test('a command whose prompt file is missing is left out and named', async () => {
    manifestFile = { path: 'kortix.yaml', content: COMMANDS };
    mdFileContent = { 'prompts/lead.md': 'Lead.' };
    const compiled = JSON.parse((await resolveCompiledAgentConfigForSession(PROJECT, 'main'))!) as CompiledAgents;
    expect(compiled.agent.lead!.prompt).toBe('Lead.');
    expect(compiled.commands).toBeUndefined();
    expect(compiled.manifest_issues).toEqual([expect.objectContaining({ path: 'commands.weekly.prompt_file', severity: 'error' })]);
  });
});

describe('allowlist rules put * first: OpenCode applies the last matching rule', () => {
  // `{ worker: allow, '*': deny }` resolves every name to deny on OpenCode, which then drops the tool.
  test('subagents and skills allowlists start with *', () => {
    const set = compileAgentConfig({ default_agent: 'lead', skills: { probe: 'skills/probe' }, agents: { lead: { mode: 'primary', prompt: 'x', skills: ['probe'], subagents: ['worker'] }, worker: { mode: 'subagent', prompt: 'y' } } });
    const permission = set.agent.lead!.permission as Record<string, Record<string, string>>;
    expect(Object.entries(permission.task!)).toEqual([['*', 'deny'], ['worker', 'allow']]);
    expect(Object.entries(permission.skill!)).toEqual([['*', 'deny'], ['probe', 'allow']]);
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

  test('a skills list allows each listed skill and denies the rest (the prod failure shape)', () => {
    const set = wire(compileAgentConfig({ default_agent: 'a', skills: { 'aie-os': 'skills/aie-os', probe: 'skills/probe' }, agents: { a: { prompt: 'x', skills: ['aie-os', 'probe'] } } }));
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'skill', 'aie-os')).toBe('allow');
    expect(openCodeAction(permission, 'skill', 'probe')).toBe('allow');
    expect(openCodeAction(permission, 'skill', 'other')).toBe('deny');
  });

  test('a bash map with `*` last keeps its specific rule', () => {
    const set = wire(compileAgentConfig({ default_agent: 'a', agents: { a: { prompt: 'x', permission: { bash: { 'git push *': 'ask', '*': 'allow' } } } } }));
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'bash', 'git push origin main')).toBe('ask');
    expect(openCodeAction(permission, 'bash', 'ls')).toBe('allow');
  });

  test('a tool key outranks a `*` written after it', () => {
    const set = wire(
      compileAgentConfig(parseYaml('default_agent: a\nagents:\n  a:\n    prompt: Hi.\n    permission:\n      bash: ask\n      edit:\n        "*.env": deny\n        "*": allow\n      "*": allow\n')),
    );
    const permission = set.agent.a!.permission;
    expect(openCodeAction(permission, 'bash', 'ls')).toBe('ask');
    expect(openCodeAction(permission, 'edit', 'apps/api/.env')).toBe('deny');
    expect(openCodeAction(permission, 'read', 'x')).toBe('allow');
  });
});
