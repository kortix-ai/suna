import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compilePiRuntime } from './compiled-pi-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('compiled Pi command payload', () => {
  test('bakes commands into the manifest and worker global', () => {
    const commands = [
      {
        name: 'review',
        description: 'Review code',
        template: 'Review $ARGUMENTS',
        source: 'command' as const,
        hints: ['$ARGUMENTS'],
      },
    ];
    const artifact = compilePiRuntime({
      projectId: 'project-command',
      ref: 'main',
      sourceSha: 'c'.repeat(40),
      agentConfig: null,
      defaultAgent: 'build',
      commands,
      workerBundle:
        'console.log(JSON.stringify(globalThis.__KORTIX_COMPILED__.commands));\nprocess.exit(0);\n',
    });

    expect(JSON.parse(artifact.manifest.command_config ?? 'null')).toEqual(commands);
    expect(artifact.manifest.command_config_etag).toMatch(/^[0-9a-f]{16}$/);

    const root = mkdtempSync(join(tmpdir(), 'kortix-pi-command-runtime-'));
    roots.push(root);
    const path = join(root, 'worker.mjs');
    writeFileSync(path, artifact.source, { mode: 0o700 });
    expect(JSON.parse(execFileSync(process.execPath, [path], { encoding: 'utf8' }))).toEqual(
      commands,
    );
  });

  test('command bytes participate in the artifact identity', () => {
    const base = {
      projectId: 'project-command',
      ref: 'main',
      sourceSha: 'c'.repeat(40),
      agentConfig: null,
      defaultAgent: 'build',
      workerBundle: 'process.exit(0);',
    };
    const first = compilePiRuntime({
      ...base,
      commands: [{ name: 'review', template: 'Review old', source: 'command', hints: [] }],
    });
    const second = compilePiRuntime({
      ...base,
      commands: [{ name: 'review', template: 'Review new', source: 'command', hints: [] }],
    });

    expect(second.sha256).not.toBe(first.sha256);
  });
});
