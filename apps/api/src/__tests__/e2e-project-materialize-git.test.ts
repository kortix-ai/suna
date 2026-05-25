import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeRepoContext } from '../projects/git';

let root = '';
let previousCacheDir: string | undefined;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

describe('project git materialization', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kortix-materialize-e2e-'));
    previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('extracts repeated full-tree archives from a bare mirror without truncation', async () => {
    const source = join(root, 'source');
    const origin = join(root, 'origin.git');
    mkdirSync(join(source, '.kortix', 'opencode', 'skills', 'legal-writer', 'scripts'), { recursive: true });
    mkdirSync(join(source, 'src', 'nested'), { recursive: true });

    git(['init', '-b', 'main'], source);
    git(['config', 'user.email', 'e2e@kortix.test'], source);
    git(['config', 'user.name', 'Kortix E2E'], source);

    for (let i = 0; i < 75; i += 1) {
      writeFileSync(
        join(source, 'src', 'nested', `file-${String(i).padStart(2, '0')}.txt`),
        `fixture-${i}\n${'x'.repeat(2048)}\n`,
        'utf8',
      );
    }
    writeFileSync(
      join(source, '.kortix', 'opencode', 'skills', 'legal-writer', 'scripts', 'courtlistener.py'),
      'print("courtlistener fixture")\n',
      'utf8',
    );
    writeFileSync(join(source, 'kortix.toml'), '[project]\nname = "materialize-e2e"\n', 'utf8');
    git(['add', '.'], source);
    git(['commit', '-m', 'initial'], source);

    git(['-c', 'init.defaultBranch=main', 'init', '--bare', origin]);
    git(['remote', 'add', 'origin', origin], source);
    git(['push', '--quiet', 'origin', 'main'], source);
    const commit = git(['rev-parse', 'HEAD'], source);

    const project = {
      projectId: '00000000-0000-4000-a000-000000000997',
      repoUrl: origin,
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
    };

    for (let i = 0; i < 5; i += 1) {
      const dir = await materializeRepoContext(project, commit);
      try {
        expect(existsSync(join(dir, 'kortix.toml'))).toBe(true);
        expect(readFileSync(join(dir, 'src', 'nested', 'file-74.txt'), 'utf8')).toContain('fixture-74');
        expect(readFileSync(
          join(dir, '.kortix', 'opencode', 'skills', 'legal-writer', 'scripts', 'courtlistener.py'),
          'utf8',
        )).toContain('courtlistener fixture');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
