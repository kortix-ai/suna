import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitBackedProject } from '../git/types';
import { compilePiCommands, resolveCompiledPiCommandsForSession } from './compile-pi-commands';

const roots: string[] = [];
const originalMirrorRoot = process.env.KORTIX_GIT_CACHE_DIR;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kortix Test',
      GIT_AUTHOR_EMAIL: 'test@kortix.test',
      GIT_COMMITTER_NAME: 'Kortix Test',
      GIT_COMMITTER_EMAIL: 'test@kortix.test',
    },
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalMirrorRoot === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalMirrorRoot;
});

describe('compilePiCommands', () => {
  test('combines JSONC and markdown commands with markdown taking precedence', () => {
    expect(
      compilePiCommands({
        configRaw: `{
          // The config command remains available.
          "command": {
            "from-config": { "template": "Config $ARGUMENTS", "description": "JSONC" },
            "review": { "template": "old", "model": "anthropic/old" },
          },
        }`,
        markdownFiles: {
          '.kortix/pi/commands/review.md':
            '---\ndescription: Review code\nsubtask: false\n---\n\nReview $1 and $2\n',
        },
        configDir: '.kortix/pi',
      }),
    ).toEqual([
      {
        name: 'from-config',
        description: 'JSONC',
        template: 'Config $ARGUMENTS',
        source: 'command',
        hints: ['$ARGUMENTS'],
      },
      {
        name: 'review',
        description: 'Review code',
        template: 'Review $1 and $2',
        subtask: false,
        source: 'command',
        hints: ['$1', '$2'],
      },
    ]);
  });

  test('uses a markdown command name override and derives OpenCode hints', () => {
    expect(
      compilePiCommands({
        configRaw: null,
        markdownFiles: {
          '.kortix/pi/commands/review.md':
            '---\nname: inspect\n---\nInspect $2, $10, $2, and $ARGUMENTS\n',
        },
        configDir: '.kortix/pi',
      }),
    ).toEqual([
      {
        name: 'inspect',
        template: 'Inspect $2, $10, $2, and $ARGUMENTS',
        source: 'command',
        hints: ['$10', '$2', '$ARGUMENTS'],
      },
    ]);
  });

  test('preserves unsupported OpenCode options so execution can reject them explicitly', () => {
    expect(
      compilePiCommands({
        configRaw: null,
        markdownFiles: {
          '.kortix/pi/command/delegate.md':
            '---\nagent: plan\nmodel: anthropic/claude\nsubtask: true\n---\nDo it\n',
        },
        configDir: '.kortix/pi',
      }),
    ).toEqual([
      {
        name: 'delegate',
        template: 'Do it',
        agent: 'plan',
        model: 'anthropic/claude',
        subtask: true,
        source: 'command',
        hints: [],
      },
    ]);
  });

  test('rejects malformed command entries instead of silently omitting them', () => {
    expect(() =>
      compilePiCommands({
        configRaw: '{"command":{"broken":{"description":"missing template"}}}',
        markdownFiles: {},
        configDir: '.kortix/pi',
      }),
    ).toThrow('broken');
  });
});

describe('resolveCompiledPiCommandsForSession', () => {
  test('reads command content from the immutable source SHA, not the moved branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-pi-commands-'));
    roots.push(root);
    const source = join(root, 'source');
    mkdirSync(join(source, '.kortix', 'pi', 'commands'), { recursive: true });
    git(['init', '-b', 'main'], source);
    writeFileSync(
      join(source, 'kortix.yaml'),
      'kortix_version: 3\ndefault_agent: build\nagents:\n  build: {}\n',
    );
    writeFileSync(
      join(source, '.kortix', 'pi', 'commands', 'review.md'),
      '---\ndescription: Original\n---\n\nReview $ARGUMENTS\n',
    );
    git(['add', '-A'], source);
    git(['commit', '-m', 'original command'], source);
    const originalSha = git(['rev-parse', 'HEAD'], source);

    writeFileSync(
      join(source, '.kortix', 'pi', 'commands', 'review.md'),
      '---\ndescription: Moved\n---\n\nIgnore the requested SHA\n',
    );
    git(['add', '-A'], source);
    git(['commit', '-m', 'move branch'], source);

    const mirrors = mkdtempSync(join(tmpdir(), 'kortix-pi-command-mirrors-'));
    roots.push(mirrors);
    process.env.KORTIX_GIT_CACHE_DIR = mirrors;
    const project: GitBackedProject = {
      projectId: crypto.randomUUID(),
      repoUrl: `file://${source}`,
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
      gitAuthToken: 'test-token',
    };

    expect(await resolveCompiledPiCommandsForSession(project, originalSha)).toEqual([
      {
        name: 'review',
        description: 'Original',
        template: 'Review $ARGUMENTS',
        source: 'command',
        hints: ['$ARGUMENTS'],
      },
    ]);
  });
});
