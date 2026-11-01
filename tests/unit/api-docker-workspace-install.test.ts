import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Exercise pnpm against the actual dependency-stage COPY inputs, not the full
// checkout: a workspace override must resolve even when no app imports it.
test('API Docker dependency context resolves workspace overrides', () => {
  const root = resolve(import.meta.dirname, '../..');
  const context = mkdtempSync(join(tmpdir(), 'api-docker-workspace-'));
  try {
    const dockerfile = readFileSync(join(root, 'apps/api/Dockerfile'), 'utf8');
    const stage = dockerfile.split('FROM node:22-slim AS deps')[1].split('RUN corepack')[0];
    for (const line of stage.split('\n')) {
      if (!line.startsWith('COPY ')) continue;
      const fields = line.replaceAll('${SERVICE}', 'apps/api').split(/\s+/).slice(1);
      const destination = fields.pop();
      if (!destination) throw new Error('COPY destination missing');
      for (const source of fields) {
        const target = statSync(join(root, source)).isDirectory()
          ? join(context, destination)
          : join(context, destination, source.split('/').pop() ?? source);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, source), target, { recursive: true });
      }
    }
    const result = spawnSync(
      'pnpm',
      [
        'install',
        '--filter',
        './apps/api...',
        '--filter',
        'kortix',
        '--shamefully-hoist',
        '--prod=false',
        '--ignore-scripts',
        '--lockfile-only',
        '--offline',
      ],
      {
        cwd: context,
        env: { ...process.env, CI: 'true' },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}, 60_000);
