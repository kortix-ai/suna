// Characterization tests for `loadProjectConfig`: they pin the exact summary a
// repo with an imported manifest produces — every field, the ordering of the
// `agents`/`skills`/`commands` lists, and `manifest_health`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectConfig } from './config';
import { listManagedSkills } from '../../skills/catalog';
import { getStarterFiles } from '@kortix/starter';
import { isSelectableAgent } from '@kortix/sdk/projects-client';
import { projectConfigAgentsToRuntimeAgents } from '@kortix/sdk';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

const ROOT = `# Synthetic root manifest
imports:
  - .kortix/triggers/
env:
  required:
    - FOO_TOKEN
    - BAR_KEY
  optional:
    - OPTIONAL_ONE
`;

const SEED: Record<string, string> = {
  'kortix.yaml': ROOT,
  '.kortix/triggers/nightly.yaml': `triggers:
  - slug: nightly
    type: cron
    cron: "0 3 * * *"
    prompt: run the nightly job
`,
};

let testRoot = '';
let remotePath = '';
let seedPath = '';
let cacheDir = '';
let previousCacheDir: string | undefined;
let project: GitBackedProject;

/** Remove files from the remote's default branch. */
async function remove(paths: string[], message: string): Promise<void> {
  await git(['rm', '-q', ...paths], seedPath);
  await git(['commit', '-m', message], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
}

/** Commit files straight to the remote, as a user pushing from their laptop. */
async function push(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seedPath, path)), { recursive: true });
    await writeFile(join(seedPath, path), content);
  }
  await git(['add', '-A'], seedPath);
  await git(['commit', '-m', message], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-config-char-'));
  cacheDir = join(testRoot, 'git-cache');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
  remotePath = join(testRoot, 'remote.git');
  seedPath = join(testRoot, 'seed');
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', seedPath]);
  await git(['config', 'user.name', 'Kortix Test'], seedPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await push(SEED, 'seed the synthetic project');
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `config-char-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
  await rm(testRoot, { recursive: true, force: true });
});

describe('loadProjectConfig characterization', () => {
  test('a fresh starter declares one agent, worker, and offers it', async () => {
    const files = getStarterFiles({ projectName: 'Picker regression' });
    await push(Object.fromEntries(files.map((file) => [file.path, file.content])), 'seed a fresh starter');
    const config = await loadProjectConfig(project);
    expect(config.agents.map((agent) => agent.name)).toEqual(['worker']);
    expect(config.agents.filter(isSelectableAgent).map((agent) => agent.name)).toEqual(['worker']);
    expect(projectConfigAgentsToRuntimeAgents({ ...config, agents: config.agents.map((agent) => ({ ...agent, source: undefined })) }).filter(isSelectableAgent).map((agent) => agent.name)).toEqual(['worker']);
  });

  test('hidden primary agents keep their visibility marker', async () => {
    await push({ 'kortix.yaml': 'default_agent: assistant\nagents:\n  assistant:\n    mode: primary\n  internal:\n    mode: primary\n    hidden: true\n' }, 'declare automation');
    const config = await loadProjectConfig(project);
    expect(config.agents.map((agent) => agent.name)).toEqual(['assistant', 'internal']);
    expect(config.agents.filter(isSelectableAgent).map((agent) => agent.name)).toEqual(['assistant']);
  });

  test('spaces: agents carry their space, and spaces list header and tabs, dropping unknown tab types', async () => {
    await push(
      {
        'kortix.yaml': [
          'default_agent: assistant',
          'spaces:',
          '  ops:',
          '    label: Ops',
          '    order: 2',
          '  eng:',
          '    label: Engineering',
          '    description: Ship it.',
          '    order: 1',
          '    header: [agents, new_session]',
          '    tabs:',
          '      - type: goals',
          '      - type: link',
          '        label: Status',
          '        url: https://status.example.com',
          '        embed: true',
          '      - type: board',
          '        blocks:',
          '          - type: text',
          '            text: Hello',
          '      - type: video',
          'agents:',
          '  assistant:',
          '    mode: primary',
          '    space: eng',
          '',
        ].join('\n'),
      },
      'declare spaces',
    );
    const config = await loadProjectConfig(project);
    expect(config.agents.map((agent) => [agent.name, agent.space])).toEqual([['assistant', 'eng']]);
    expect(config.spaces).toEqual([
      {
        name: 'eng',
        label: 'Engineering',
        description: 'Ship it.',
        order: 1,
        header: ['agents', 'new_session'],
        tabs: [
          { type: 'goals' },
          { type: 'link', label: 'Status', url: 'https://status.example.com', embed: true },
          { type: 'board', blocks: [{ type: 'text', text: 'Hello' }] },
        ],
      },
      { name: 'ops', label: 'Ops', order: 2 },
    ]);
  });

  test('imported agents: every registered agent is listed, a disabled one with enabled: false, attributed to its declaring file', async () => {
    // The reported shape: a root manifest that declares no `agents:` of its own
    // and imports a domain file that does — one enabled, one disabled agent.
    await push(
      {
        'kortix.yaml': `# Synthetic root manifest
imports:
  - domains/kortix.yaml
`,
        'domains/kortix.yaml': `agents:
  builder:
    connectors: all
  observer:
    enabled: false
    connectors: all
`,
      },
      'declare agents through an imported domain file',
    );

    const config = await loadProjectConfig(project);

    expect(config.agent_discovery).toBe('declarative');
    // Every registered agent is listed — the disabled one carries `enabled: false`
    // instead of vanishing (launch surfaces filter it at their own layer).
    expect(config.agents.map((agent) => [agent.name, agent.enabled, agent.path])).toEqual([
      ['builder', true, 'domains/kortix.yaml#agents.builder'],
      ['observer', false, 'domains/kortix.yaml#agents.observer'],
    ]);
    // The scope mirror still resolves from the declaring block.
    expect(config.agents[1]?.scope?.connectors).toBe('all');
  });

  test('pins the manifest, signals and health fields of an imported manifest', async () => {
    const config = await loadProjectConfig(project);

    expect(config.is_kortix_repo).toBe(true);
    expect(config.signals).toEqual({ manifest: true, openCodeConfig: false, openCodeAgent: false });
    // `manifest_raw` stays the ROOT file text even when imports merge into `manifest`.
    expect(config.manifest_raw).toBe(ROOT);
    expect(config.manifest_health).toEqual({ path: 'kortix.yaml', state: 'ok', errors: 0, warnings: 0, issues: [] });
    // The merged document carries the imported trigger and the root env.
    expect(config.manifest.env).toEqual({
      required: ['FOO_TOKEN', 'BAR_KEY'],
      optional: ['OPTIONAL_ONE'],
    });
    expect(config.manifest.triggers).toEqual([
      { slug: 'nightly', type: 'cron', cron: '0 3 * * *', prompt: 'run the nightly job' },
    ]);
    expect(config.env).toEqual({ required: ['FOO_TOKEN', 'BAR_KEY'], optional: ['OPTIONAL_ONE'] });
    expect(config.open_code_raw).toBeNull();
    expect(config.default_agent).toBeNull();
    expect(config.agent_discovery).toBe('declarative');
    expect(config.agents).toEqual([]);
    expect(config.commands).toEqual([]);
  });

  // The skill-create route serializes every frontmatter string as a
  // double-quoted YAML scalar (the one single-line form valid for any text),
  // so a description may carry quotes, colons and backslashes. The summary
  // parser must read that scalar back to its text, or the catalog shows the
  // escapes.
  test('reads a quoted frontmatter scalar with escapes back to its text', async () => {
    await push(
      {
        'kortix.yaml': `${ROOT}skills:\n  quoted: skills/quoted\n`,
        'skills/quoted/SKILL.md': `---
name: "Quoted \\"Skill\\""
description: "Runs deploys: say \\"go\\""
---
`,
      },
      'add the quoted skill',
    );
    const config = await loadProjectConfig(project);

    const skill = config.skills.find((s) => s.path === 'skills/quoted/SKILL.md');
    expect(skill?.name).toBe('quoted');
    expect(skill?.description).toBe('Runs deploys: say "go"');
  });

  // A plain scalar (the writer emits one when the text needs no quoting) may
  // end in a quote character; the reader must not eat it as a closing quote.
  test('reads a plain scalar that ends in a quote back intact', async () => {
    await push(
      {
        'kortix.yaml': `${ROOT}skills:\n  plain: skills/plain\n`,
        'skills/plain/SKILL.md': '---\nname: Deploy "v1"\ndescription: Covers the don\'t path\n---\n',
      },
      'add the plain skill',
    );
    const config = await loadProjectConfig(project);

    const skill = config.skills.find((s) => s.path === 'skills/plain/SKILL.md');
    expect(skill?.name).toBe('plain');
    expect(skill?.description).toBe("Covers the don't path");
  });
});

describe('loadProjectConfig: kortix.yaml is the only source', () => {
  test('agents come from the YAML blocks, skills from the registry plus the Kortix skills, commands from the registry', async () => {
    await push(
      {
        'kortix.yaml': `default_agent: lead
skills:
  triage: support/skills/triage
commands:
  report:
    description: Write the report.
    prompt_file: commands/report.md
  ping:
    prompt: Say pong.
agents:
  lead:
    description: Leads the work.
    mode: primary
    model: kortix/glm-5.3-flash
    prompt_file: agents/lead.md
    skills: all
    commands: [report]
  helper:
    mode: subagent
    enabled: false
    prompt: Help.
`,
        'agents/lead.md': 'You lead.\n',
        'commands/report.md': 'Report on $ARGUMENTS.\n',
        'support/skills/triage/SKILL.md': '---\nname: triage\ndescription: Sort tickets.\n---\n',
        // Not registered: never listed.
        'skills/stray/SKILL.md': '---\nname: stray\n---\n',
      },
      'manifest',
    );

    const config = await loadProjectConfig(project);

    expect(config.default_agent).toBe('lead');
    expect(config.open_code_raw).toBeNull();
    expect(config.agent_discovery).toBe('declarative');
    expect(config.agents.map((agent) => [agent.name, agent.path, agent.description, agent.mode, agent.model, agent.enabled])).toEqual([
      ['helper', 'kortix.yaml#agents.helper', null, 'subagent', null, false],
      ['lead', 'agents/lead.md', 'Leads the work.', 'primary', 'kortix/glm-5.3-flash', true],
    ]);
    expect(config.skills.find((skill) => skill.name === 'triage')).toEqual({
      name: 'triage',
      path: 'support/skills/triage/SKILL.md',
      description: 'Sort tickets.',
    });
    expect(config.skills.some((skill) => skill.name === 'stray')).toBe(false);
    expect(config.skills.some((skill) => skill.name === 'kortix-system')).toBe(true);
    expect(config.commands).toEqual([
      { name: 'ping', path: 'kortix.yaml#commands.ping', description: null },
      { name: 'report', path: 'commands/report.md', description: 'Write the report.' },
    ]);
  });
});

describe('loadProjectConfig: manifest_health', () => {
  test('a manifest with no issue is ok', async () => {
    await push({ 'kortix.yaml': 'default_agent: lead\nagents:\n  lead:\n    prompt: Lead.\n    tools: all\n' }, 'a clean manifest');
    const config = await loadProjectConfig(project);
    expect(config.manifest_health).toEqual({ path: 'kortix.yaml', state: 'ok', errors: 0, warnings: 0, issues: [] });
  });

  test('an unknown agent key is an error at its path and line', async () => {
    await push(
      { 'kortix.yaml': 'default_agent: lead\nagents:\n  lead:\n    prompt: Lead.\n    tools: all\n    descripton: Leads.\n' },
      'a typo in an agent key',
    );
    const config = await loadProjectConfig(project);
    expect(config.manifest_health.state).toBe('issues');
    expect(config.manifest_health.errors).toBe(1);
    const [issue] = config.manifest_health.issues;
    expect(issue).toMatchObject({ path: 'agents.lead.descripton', severity: 'error', line: 6 });
    expect(issue?.message).toContain('description');
    // The raw file is still served, so an editor can show it.
    expect(config.manifest_raw).toContain('descripton');
  });

  test('no manifest file is missing: the project runs its built-in agents only', async () => {
    await remove(['kortix.yaml', '.kortix/triggers/nightly.yaml'], 'remove the manifest');
    const config = await loadProjectConfig(project);
    expect(config.manifest_health).toEqual({ path: null, state: 'missing', errors: 0, warnings: 0, issues: [] });
    expect(config.is_kortix_repo).toBe(false);
    expect(config.manifest_raw).toBeNull();
  });

  test('a repository with only a retired kortix.toml gets one error naming it', async () => {
    await remove(['kortix.yaml', '.kortix/triggers/nightly.yaml'], 'remove the manifest');
    await push({ 'kortix.toml': '[project]\nname = "legacy"\n' }, 'a retired manifest');
    const config = await loadProjectConfig(project);
    expect(config.manifest_health.state).toBe('issues');
    expect(config.manifest_health.path).toBe('kortix.toml');
    expect(config.manifest_health.errors).toBe(1);
    expect(config.manifest_health.issues[0]).toMatchObject({ path: 'kortix.toml', severity: 'error' });
    expect(config.manifest_health.issues[0]?.message).toContain('https://kortix.com/docs/developers#kortixyaml-reference');
  });
});
