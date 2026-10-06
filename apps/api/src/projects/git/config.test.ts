// Characterization tests for `loadProjectConfig`: they pin the exact summary a
// repo with an imported manifest plus agent/skill/command files produces —
// every field, and the ordering of the `agents`/`skills`/`commands` lists.
// They pass before and after the manifest-resolver / resource-scanner split.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { loadProjectConfig } from './config';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

const ROOT = `# Synthetic root manifest
kortix_version: 2
imports:
  - .kortix/triggers/
env:
  required:
    - FOO_TOKEN
    - BAR_KEY
  optional:
    - OPTIONAL_ONE
opencode:
  config_dir: .kortix/opencode
`;

const OPENCODE_JSONC = `{
  // synthetic default agent
  "default_agent": "builder"
}
`;

const SEED: Record<string, string> = {
  'kortix.yaml': ROOT,
  '.kortix/triggers/nightly.yaml': `triggers:
  - slug: nightly
    type: cron
    cron: "0 3 * * *"
    prompt: run the nightly job
`,
  '.kortix/opencode/opencode.jsonc': OPENCODE_JSONC,
  // Agents: both `agent/` and `agents/` forms, one with no frontmatter.
  '.kortix/opencode/agent/zeta.md': `---
name: Zeta
description: The zeta agent
mode: primary
model: test/zeta-model
---
Zeta body.
`,
  '.kortix/opencode/agents/alpha.md': `---
description: The alpha agent
---
Alpha body.
`,
  '.kortix/opencode/agent/untitled.md': 'No frontmatter here.\n',
  '.kortix/opencode/agent/notes.txt': 'not an agent\n',
  // Skills: sorted by slug; one with no frontmatter.
  '.kortix/opencode/skills/bravo/SKILL.md': `---
name: Bravo Skill
description: The bravo skill
---
`,
  '.kortix/opencode/skills/alpha/SKILL.md': 'Alpha skill body.\n',
  '.kortix/opencode/skills/ignored/README.md': 'not a skill\n',
  // Commands: both `command/` and `commands/` forms.
  '.kortix/opencode/commands/deploy.md': `---
description: Deploy the app
---
`,
  '.kortix/opencode/command/rollback.md': `---
name: Rollback
---
`,
};

let testRoot = '';
let remotePath = '';
let seedPath = '';
let cacheDir = '';
let previousCacheDir: string | undefined;
let project: GitBackedProject;

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
  test('pins the manifest, signals and opencode.jsonc fields of an imported manifest', async () => {
    const config = await loadProjectConfig(project);

    expect(config.is_kortix_repo).toBe(true);
    expect(config.signals).toEqual({ manifest: true, openCodeConfig: true, openCodeAgent: true });
    // `manifest_raw` stays the ROOT file text even when imports merge into `manifest`.
    expect(config.manifest_raw).toBe(ROOT);
    expect(config.manifest_version).toEqual({
      version: 2,
      latest_version: 3,
      migration_offered: false,
      target_version: null,
      unknown_reason: null,
      path: 'kortix.yaml',
    });
    // The merged document carries the imported trigger and the root env/opencode keys.
    expect(config.manifest.env).toEqual({
      required: ['FOO_TOKEN', 'BAR_KEY'],
      optional: ['OPTIONAL_ONE'],
    });
    expect(config.manifest.opencode).toEqual({ config_dir: '.kortix/opencode' });
    expect(config.manifest.triggers).toEqual([
      { slug: 'nightly', type: 'cron', cron: '0 3 * * *', prompt: 'run the nightly job' },
    ]);
    expect(config.env).toEqual({ required: ['FOO_TOKEN', 'BAR_KEY'], optional: ['OPTIONAL_ONE'] });
    expect(config.open_code_raw).toBe(OPENCODE_JSONC);
    expect(config.open_code_default_agent).toBe('builder');
    expect(config.default_agent).toBe('builder');
  });

  test('pins the agents list and its ordering (sorted by path)', async () => {
    const config = await loadProjectConfig(project);

    // No manifest agents declaration → OpenCode native discovery, native list verbatim.
    expect(config.agent_discovery).toBe('opencode');
    expect(config.agents).toEqual([
      {
        name: 'untitled',
        path: '.kortix/opencode/agent/untitled.md',
        description: null,
        mode: null,
        model: null,
        source: 'opencode',
        enabled: true,
      },
      {
        name: 'Zeta',
        path: '.kortix/opencode/agent/zeta.md',
        description: 'The zeta agent',
        mode: 'primary',
        model: 'test/zeta-model',
        source: 'opencode',
        enabled: true,
      },
      {
        name: 'alpha',
        path: '.kortix/opencode/agents/alpha.md',
        description: 'The alpha agent',
        mode: null,
        model: null,
        source: 'opencode',
        enabled: true,
      },
    ]);
  });

  test('pins the skills list and its ordering (sorted by slug, path normalized)', async () => {
    const config = await loadProjectConfig(project);

    expect(config.skills).toEqual([
      {
        name: 'alpha',
        path: '.kortix/opencode/skills/alpha/SKILL.md',
        description: null,
      },
      {
        name: 'Bravo Skill',
        path: '.kortix/opencode/skills/bravo/SKILL.md',
        description: 'The bravo skill',
      },
    ]);
  });

  test('pins the commands list and its ordering (sorted by slug, both dir forms)', async () => {
    const config = await loadProjectConfig(project);

    expect(config.commands).toEqual([
      {
        name: 'deploy',
        path: '.kortix/opencode/commands/deploy.md',
        description: 'Deploy the app',
      },
      {
        name: 'Rollback',
        path: '.kortix/opencode/command/rollback.md',
        description: null,
      },
    ]);
  });

  // The skill-create route serializes every frontmatter string as a
  // double-quoted YAML scalar (the one single-line form valid for any text),
  // so a description may carry quotes, colons and backslashes. The summary
  // parser must read that scalar back to its text, or the catalog shows the
  // escapes.
  test('reads a quoted frontmatter scalar with escapes back to its text', async () => {
    await push(
      {
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
    expect(skill?.name).toBe('Quoted "Skill"');
    expect(skill?.description).toBe('Runs deploys: say "go"');
  });
});
