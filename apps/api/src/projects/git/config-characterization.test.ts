/**
 * Characterization tests for `loadProjectConfig` (KRTX-307).
 *
 * These pin the CURRENT behavior of the config introspection — manifest
 * fields, the agents/skills/commands lists and their ordering — for a repo
 * with an imported manifest plus agent/skill/command files, and for a repo
 * with no manifest at all. They pass unchanged before and after the
 * behavior-preserving split of `loadProjectConfig`; any drift in output
 * shape, field values or ordering fails here first.
 *
 * The expected values were captured from the unmodified implementation
 * (origin/main `849413e86`). Synthetic fixture data only.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runGit as realRunGit } from './mirror';

// `config.ts` reaches the repo through `./files`, which imports `runGit` +
// `refreshMirror` from `./mirror`. Mock the module so `refreshMirror`
// short-circuits to a real local git checkout in a temp dir, while `runGit`
// stays the real git runner.
const mirrorModule = await import('./mirror');

let repoPath = '';

mock.module('./mirror', () => ({
  ...mirrorModule,
  runGit: realRunGit,
  refreshMirror: async () => repoPath,
}));

const { loadProjectConfig } = await import('./config');

const exec = promisify(execFile);

const project = {
  projectId: 'test-project',
  defaultBranch: 'main',
  repoUrl: 'https://github.com/kortix-ai/test.git',
  gitAuthToken: null,
  gitAuthHeaders: {},
} as any;

const ROOT_KORTIX_YAML = `# Demo root manifest (synthetic)
kortix_version: 2
default_agent: kortix
env:
  required:
    - DATABASE_URL
    - API_KEY
  optional:
    - FEATURE_FLAG
imports:
  - .kortix/agents.yaml
`;

const IMPORTED_AGENTS_YAML = `# Demo imported agents (synthetic)
agents:
  ghost:
    description: Disabled agent
    disable: true
  planner:
    description: Breaks work into steps
    connectors:
      - slack
    permissions:
      - fs.write
    sandbox: privileged
    apps:
      - studio
`;

const AGENT_A = `---
name: Native A
description: Singular-dir agent
mode: primary
model: gpt-x
---
Body of native A.
`;

const AGENT_B = `---
description: Plural-dir agent without a name
mode: subagent
---
Body of native B.
`;

const SKILL_ALPHA = `---
name: Alpha Skill
description: First skill alphabetically
---
Alpha steps.
`;

const SKILL_DEMO = `---
name: Demo Skill
description: Second skill
---
Demo steps.
`;

const COMMAND_ONE = `---
description: Singular command
---
Run one.
`;

const COMMAND_TWO = `---
name: Two Command
description: Plural command
---
Run two.
`;

const OPENCODE_JSONC = `{
  // opencode config (synthetic)
  "default_agent": "native-b",
}
`;

async function seedRepo(files: Record<string, string>): Promise<void> {
  repoPath = await mkdtemp(join(tmpdir(), 'kortix-loadprojectconfig-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoPath, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const git = async (args: string[]) =>
    exec('git', ['-c', 'user.email=agent@example.test', '-c', 'user.name=Agent', ...args], {
      cwd: repoPath,
    });
  await git(['init', '-b', 'main']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'fixture']);
}

beforeEach(() => {
  repoPath = '';
});

afterEach(async () => {
  if (repoPath) await rm(repoPath, { recursive: true, force: true });
});

describe('loadProjectConfig (characterization)', () => {
  test('imported manifest + agent/skill/command files: full summary is pinned', async () => {
    await seedRepo({
      'kortix.yaml': ROOT_KORTIX_YAML,
      '.kortix/agents.yaml': IMPORTED_AGENTS_YAML,
      '.kortix/opencode/agent/native-a.md': AGENT_A,
      '.kortix/opencode/agents/native-b.md': AGENT_B,
      // Committed out of alphabetical order: pins the slug sort, not commit order.
      '.kortix/opencode/skills/demo/SKILL.md': SKILL_DEMO,
      '.kortix/opencode/skills/alpha/SKILL.md': SKILL_ALPHA,
      '.kortix/opencode/command/one.md': COMMAND_ONE,
      '.kortix/opencode/commands/two.md': COMMAND_TWO,
      '.kortix/opencode/opencode.jsonc': OPENCODE_JSONC,
      // Extra file that must NOT appear in any scan.
      'README.md': '# noise\n',
    });

    const summary = await loadProjectConfig(project);

    expect(summary).toEqual({
      is_kortix_repo: true,
      signals: {
        manifest: true,
        openCodeConfig: true,
        openCodeAgent: true,
      },
      manifest_raw: ROOT_KORTIX_YAML,
      manifest: {
        kortix_version: 2,
        default_agent: 'kortix',
        env: {
          required: ['DATABASE_URL', 'API_KEY'],
          optional: ['FEATURE_FLAG'],
        },
        imports: ['.kortix/agents.yaml'],
        agents: {
          ghost: {
            description: 'Disabled agent',
            disable: true,
          },
          planner: {
            description: 'Breaks work into steps',
            connectors: ['slack'],
            permissions: ['fs.write'],
            sandbox: 'privileged',
            apps: ['studio'],
          },
        },
      },
      manifest_version: {
        version: 2,
        latest_version: 2,
        migration_offered: false,
        target_version: null,
        unknown_reason: null,
        path: 'kortix.yaml',
      },
      env: {
        required: ['DATABASE_URL', 'API_KEY'],
        optional: ['FEATURE_FLAG'],
      },
      open_code_raw: OPENCODE_JSONC,
      open_code_default_agent: 'kortix',
      agent_discovery: 'declarative',
      agents: [
        {
          name: 'ghost',
          path: 'kortix.yaml#agents.ghost',
          description: null,
          mode: null,
          model: null,
          source: 'kortix.yaml',
          enabled: true,
          sandbox: null,
          scope: {
            env: [],
            connectors: [],
            kortix_permissions: [],
            kortix_cli: [],
            apps: [],
          },
        },
        {
          name: 'planner',
          path: 'kortix.yaml#agents.planner',
          description: null,
          mode: null,
          model: null,
          source: 'kortix.yaml',
          enabled: true,
          sandbox: 'privileged',
          scope: {
            env: [],
            connectors: ['slack'],
            kortix_permissions: [],
            kortix_cli: [],
            apps: ['studio'],
          },
        },
      ],
      skills: [
        {
          name: 'Alpha Skill',
          path: '.kortix/opencode/skills/alpha/SKILL.md',
          description: 'First skill alphabetically',
        },
        {
          name: 'Demo Skill',
          path: '.kortix/opencode/skills/demo/SKILL.md',
          description: 'Second skill',
        },
      ],
      commands: [
        {
          name: 'one',
          path: '.kortix/opencode/command/one.md',
          description: 'Singular command',
        },
        {
          name: 'Two Command',
          path: '.kortix/opencode/commands/two.md',
          description: 'Plural command',
        },
      ],
    });

    // Ordering proofs, stated explicitly for the reader:
    expect(summary.agents.map((a) => a.name)).toEqual(['ghost', 'planner']);
    expect(summary.skills.map((s) => s.path)).toEqual([
      '.kortix/opencode/skills/alpha/SKILL.md',
      '.kortix/opencode/skills/demo/SKILL.md',
    ]);
    expect(summary.commands.map((c) => c.path)).toEqual([
      '.kortix/opencode/command/one.md',
      '.kortix/opencode/commands/two.md',
    ]);
  });

  test('no manifest, native OpenCode resources only: opencode discovery branch is pinned', async () => {
    await seedRepo({
      '.kortix/opencode/agent/native-a.md': AGENT_A,
      '.kortix/opencode/agents/native-b.md': AGENT_B,
      '.kortix/opencode/skills/demo/SKILL.md': SKILL_DEMO,
      '.kortix/opencode/commands/two.md': COMMAND_TWO,
      '.kortix/opencode/opencode.jsonc': OPENCODE_JSONC,
    });

    const summary = await loadProjectConfig(project);

    expect(summary).toEqual({
      is_kortix_repo: true,
      signals: {
        manifest: false,
        openCodeConfig: true,
        openCodeAgent: true,
      },
      manifest_raw: null,
      manifest: {},
      manifest_version: {
        version: null,
        latest_version: 2,
        migration_offered: false,
        target_version: null,
        unknown_reason: 'unreadable',
        path: null,
      },
      env: { required: [], optional: [] },
      open_code_raw: OPENCODE_JSONC,
      open_code_default_agent: 'native-b',
      agent_discovery: 'opencode',
      agents: [
        {
          name: 'Native A',
          path: '.kortix/opencode/agent/native-a.md',
          description: 'Singular-dir agent',
          mode: 'primary',
          model: 'gpt-x',
          source: 'opencode',
          enabled: true,
        },
        {
          // Name falls back to the file stem when frontmatter has none; the
          // singular `agent/` dir sorts before the plural `agents/` dir.
          name: 'native-b',
          path: '.kortix/opencode/agents/native-b.md',
          description: 'Plural-dir agent without a name',
          mode: 'subagent',
          model: null,
          source: 'opencode',
          enabled: true,
        },
      ],
      skills: [
        {
          name: 'Demo Skill',
          path: '.kortix/opencode/skills/demo/SKILL.md',
          description: 'Second skill',
        },
      ],
      commands: [
        {
          name: 'Two Command',
          path: '.kortix/opencode/commands/two.md',
          description: 'Plural command',
        },
      ],
    });

    expect(summary.agents.map((a) => a.path)).toEqual([
      '.kortix/opencode/agent/native-a.md',
      '.kortix/opencode/agents/native-b.md',
    ]);
  });
});
