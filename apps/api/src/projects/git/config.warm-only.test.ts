// KRTX-819 regression tests: a warm-only project-config read never refreshes
// the git mirror.
//
// Prod evidence (2026-10-03, Better Stack ClickHouse): after the over-budget
// mirror reaper evicted a project's bare mirror, every GET
// /v1/projects/:id/secrets on that pod blocked on an inline cold clone —
// 3 clone attempts at the 90 s bare-clone timeout per mirror touch, 2 touches
// per read, ~542 s per request — until the 25 s request deadline returned 503
// while the handler kept cloning. The secrets route reads manifest METADATA
// (env key names, agent grants); it must serve what the pod already has and
// never clone or fetch inline.

import { beforeEach, afterEach, describe, expect, test, mock } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
// Load the real mirror module FIRST so the mock wrapper below can delegate.
import * as mirrorActual from './mirror';
import type { GitBackedProject } from './types';

const exec = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim();
}

let refreshCalls = 0;
// Capture the real function BEFORE the mock: bun's mock.module rewires the live
// module namespace, so a wrapper that calls `mirrorActual.refreshMirror` would
// recurse into itself.
const realRefreshMirror = mirrorActual.refreshMirror;
// Count every refreshMirror call any importer makes, without changing what it
// does: the warm-only contract is "zero calls", the default path keeps calling.
mock.module('./mirror', () => ({
  ...mirrorActual,
  refreshMirror: ((...args: Parameters<typeof realRefreshMirror>) => {
    refreshCalls += 1;
    return realRefreshMirror(...args);
  }) as typeof realRefreshMirror,
}));

const { loadProjectConfig } = await import('./config');

const MANIFEST = `kortix_version: 2
env:
  required:
    - FOO_TOKEN
    - BAR_KEY
  optional:
    - OPTIONAL_ONE
opencode:
  config_dir: .kortix/opencode
`;

const OPENCODE_JSONC = '{\n  "default_agent": "builder"\n}\n';

let testRoot = '';
let remotePath = '';
let seedPath = '';
let cacheDir = '';
let previousCacheDir: string | undefined;
let project: GitBackedProject;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-config-warm-'));
  cacheDir = join(testRoot, 'git-cache');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = cacheDir;
  refreshCalls = 0;
  remotePath = join(testRoot, 'remote.git');
  seedPath = join(testRoot, 'seed');
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', seedPath]);
  await git(['config', 'user.name', 'Kortix Test'], seedPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await mkdir(dirname(join(seedPath, 'kortix.yaml')), { recursive: true });
  await writeFile(join(seedPath, 'kortix.yaml'), MANIFEST);
  await mkdir(dirname(join(seedPath, '.kortix/opencode/opencode.jsonc')), { recursive: true });
  await writeFile(join(seedPath, '.kortix/opencode/opencode.jsonc'), OPENCODE_JSONC);
  await git(['add', '-A'], seedPath);
  await git(['commit', '-m', 'seed the synthetic project'], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `config-warm-${crypto.randomUUID()}`,
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

describe('warm-only project config reads (KRTX-819)', () => {
  test('no mirror on disk: degrade to the no-manifest summary without refreshing', async () => {
    const config = await loadProjectConfig(project, [], { warmOnly: true });

    expect(config.manifest_raw).toBeNull();
    expect(config.env).toEqual({ required: [], optional: [] });
    expect(config.agents).toEqual([]);
    expect(config.skills).toEqual([]);
    expect(config.commands).toEqual([]);
    expect(config.open_code_raw).toBeNull();
    expect(refreshCalls).toBe(0);
  });

  test('warm mirror on disk: read it locally without refreshing', async () => {
    await mirrorActual.refreshMirror(project);
    refreshCalls = 0;

    const config = await loadProjectConfig(project, [], { warmOnly: true });

    expect(config.manifest_raw).toBe(MANIFEST);
    expect(config.env.required).toEqual(['FOO_TOKEN', 'BAR_KEY']);
    expect(config.env.optional).toEqual(['OPTIONAL_ONE']);
    expect(config.open_code_raw).toBe(OPENCODE_JSONC);
    expect(refreshCalls).toBe(0);
  });

  test('default read (no warmOnly) still refreshes: the opt-in changes nothing else', async () => {
    const config = await loadProjectConfig(project);

    expect(config.manifest_raw).toBe(MANIFEST);
    expect(config.env.required).toEqual(['FOO_TOKEN', 'BAR_KEY']);
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
  });
});
