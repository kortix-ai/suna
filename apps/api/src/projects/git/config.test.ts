import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { runGit as realRunGit, runGitCapture as realRunGitCapture } from './mirror';
import type { GitBackedProject, ProjectConfigSummary } from './types';

// `config.ts` reaches git only through `./mirror` (refreshMirror → runGit /
// runGitCapture). Point `refreshMirror` at a real bare repository seeded per
// test and pass git calls through: loadProjectConfig then runs black-box
// against a real repo tree — real ls-tree/show, no network, no database.
const mirrorModule = await import('./mirror');
// Snapshot the real implementations BEFORE mock.module patches the module:
// whatever bun does to the already-imported bindings, these stay original.
const realRunGitFn: typeof realRunGit = mirrorModule.runGit;
const realRunGitCaptureFn: typeof realRunGitCapture = mirrorModule.runGitCapture;

let repoPath = '';
let runGitImpl: (
  ...args: Parameters<typeof realRunGit>
) => Promise<{ stdout: string; stderr: string }>;
let runGitCaptureImpl: (
  ...args: Parameters<typeof realRunGitCapture>
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

mock.module('./mirror', () => ({
  ...mirrorModule,
  runGit: async (...args: Parameters<typeof realRunGit>) => runGitImpl(...args),
  runGitCapture: async (...args: Parameters<typeof realRunGitCapture>) =>
    runGitCaptureImpl(...args),
  refreshMirror: async () => repoPath,
}));

const { loadProjectConfig } = await import('./config');

const exec = promisify(execFile);

const project: GitBackedProject = {
  projectId: 'config-characterization',
  defaultBranch: 'main',
  repoUrl: 'unused-refresh-mirror-is-mocked',
  manifestPath: 'kortix.yaml',
  gitAuthToken: null,
  gitAuthHeaders: {},
};

async function git(args: string[], cwd?: string): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

let repoRoot = '';

/** Seed a bare remote whose `main` holds `files`, like a pushed repo. */
async function seedRepo(files: Record<string, string>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-config-char-'));
  repoRoot = root;
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await git(['init', '--initial-branch=main', seed]);
  await git(['config', 'user.name', 'Kortix Test'], seed);
  await git(['config', 'user.email', 'test@kortix.invalid'], seed);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(seed, path)), { recursive: true });
    await writeFile(join(seed, path), content);
  }
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'seed'], seed);
  await git(['init', '--bare', remote]);
  await git(['push', '--quiet', remote, 'main:refs/heads/main'], seed);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  repoPath = remote;
}

const ROOT = `kortix_version: 2
default_agent: kortix
imports:
  - .kortix/agents.yaml
agents:
  kortix:
    connectors: all
env:
  required:
    - FIXTURE_REQUIRED_KEY
  optional:
    - FIXTURE_OPTIONAL_KEY
`;

// Two agent files whose paths sort differently under code-unit `.sort()`
// (`agent/Zulu.md` < `agents/alpha.md`: 'Z' 0x5A < 's' 0x73) than under
// `localeCompare` (agents/alpha.md would come first). Pins the agents
// pipeline's plain path sort against an accidental locale sort.
const AGENT_FILES = {
  '.kortix/opencode/agent/Zulu.md': `---
name: Zulu Agent
description: The zulu agent
mode: primary
model: openai/gpt-5
---
Body of the zulu agent.
`,
  '.kortix/opencode/agents/alpha.md': `---
description: Alpha from the plural dir
---
`,
};

const RESOURCE_FILES = {
  '.kortix/opencode/opencode.jsonc': `{
  // trailing comment, jsonc tolerated by the reader
  "model": "openai/gpt-5",
  "default_agent": "Beta Agent",
}
`,
  '.kortix/opencode/skills/alpha/SKILL.md': `---
name: Alpha Skill
description: First in locale order
---
`,
  '.kortix/opencode/skills/beta/SKILL.md': `---
description: Beta skill without a name
---
`,
  '.kortix/opencode/skills/Zeta/SKILL.md': `---
name: Zeta Skill
---
`,
  '.kortix/opencode/command/echo.md': `---
name: Echo
description: Echo from the singular dir
---
`,
  '.kortix/opencode/commands/zoom.md': `---
description: Zoom command
---
`,
};

beforeEach(async () => {
  repoPath = '';
  runGitImpl = realRunGitFn;
  runGitCaptureImpl = realRunGitCaptureFn;
});

afterEach(async () => {
  repoPath = '';
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = '';
});

describe('loadProjectConfig (characterization)', () => {
  test('imported v2 manifest + declarative agents + opencode resources: pinned output', async () => {
    await seedRepo({
      'kortix.yaml': ROOT,
      '.kortix/agents.yaml': 'agents:\n  galileo:\n    connectors: none\n',
      ...AGENT_FILES,
      ...RESOURCE_FILES,
    });
    const config = await loadProjectConfig(project);
    expect(config).toEqual(EXPECTED_A);
  });

  test('manifest without agents: opencode file discovery + legacy default_agent fallback', async () => {
    await seedRepo({
      'kortix.yaml': 'kortix_version: 2\ndefault_agent: alpha\n',
      ...AGENT_FILES,
      '.kortix/opencode/opencode.jsonc': '{ "default_agent": "alpha" }\n',
    });
    const config = await loadProjectConfig(project);
    expect(config).toEqual(EXPECTED_B);
  });
});

const EXPECTED_A: ProjectConfigSummary = {
  is_kortix_repo: true,
  signals: {
    manifest: true,
    openCodeConfig: true,
    openCodeAgent: true,
  },
  manifest_raw: `kortix_version: 2
default_agent: kortix
imports:
  - .kortix/agents.yaml
agents:
  kortix:
    connectors: all
env:
  required:
    - FIXTURE_REQUIRED_KEY
  optional:
    - FIXTURE_OPTIONAL_KEY
`,
  manifest: {
    kortix_version: 2,
    default_agent: 'kortix',
    imports: ['.kortix/agents.yaml'],
    agents: {
      kortix: {
        connectors: 'all',
      },
      galileo: {
        connectors: 'none',
      },
    },
    env: {
      required: ['FIXTURE_REQUIRED_KEY'],
      optional: ['FIXTURE_OPTIONAL_KEY'],
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
    required: ['FIXTURE_REQUIRED_KEY'],
    optional: ['FIXTURE_OPTIONAL_KEY'],
  },
  open_code_raw: `{
  // trailing comment, jsonc tolerated by the reader
  "model": "openai/gpt-5",
  "default_agent": "Beta Agent",
}
`,
  open_code_default_agent: 'kortix',
  agent_discovery: 'declarative',
  agents: [
    {
      name: 'galileo',
      path: 'kortix.yaml#agents.galileo',
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
      name: 'kortix',
      path: 'kortix.yaml#agents.kortix',
      description: null,
      mode: null,
      model: null,
      source: 'kortix.yaml',
      enabled: true,
      sandbox: null,
      scope: {
        env: [],
        connectors: 'all',
        kortix_permissions: [],
        kortix_cli: [],
        apps: [],
      },
    },
  ],
  skills: [
    {
      name: 'Alpha Skill',
      path: '.kortix/opencode/skills/alpha/SKILL.md',
      description: 'First in locale order',
    },
    {
      name: 'beta',
      path: '.kortix/opencode/skills/beta/SKILL.md',
      description: 'Beta skill without a name',
    },
    {
      name: 'Zeta Skill',
      path: '.kortix/opencode/skills/Zeta/SKILL.md',
      description: null,
    },
  ],
  commands: [
    {
      name: 'Echo',
      path: '.kortix/opencode/command/echo.md',
      description: 'Echo from the singular dir',
    },
    {
      name: 'zoom',
      path: '.kortix/opencode/commands/zoom.md',
      description: 'Zoom command',
    },
  ],
};

const EXPECTED_B: ProjectConfigSummary = {
  is_kortix_repo: true,
  signals: {
    manifest: true,
    openCodeConfig: true,
    openCodeAgent: true,
  },
  manifest_raw: `kortix_version: 2
default_agent: alpha
`,
  manifest: {
    kortix_version: 2,
    default_agent: 'alpha',
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
    required: [],
    optional: [],
  },
  open_code_raw: `{ "default_agent": "alpha" }
`,
  open_code_default_agent: 'alpha',
  agent_discovery: 'opencode',
  agents: [
    {
      name: 'Zulu Agent',
      path: '.kortix/opencode/agent/Zulu.md',
      description: 'The zulu agent',
      mode: 'primary',
      model: 'openai/gpt-5',
      source: 'opencode',
      enabled: true,
    },
    {
      name: 'alpha',
      path: '.kortix/opencode/agents/alpha.md',
      description: 'Alpha from the plural dir',
      mode: null,
      model: null,
      source: 'opencode',
      enabled: true,
    },
  ],
  skills: [],
  commands: [],
};
