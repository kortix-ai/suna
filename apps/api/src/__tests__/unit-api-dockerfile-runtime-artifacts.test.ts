import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

describe('API image sandbox runtime artifacts', () => {
  test('copies every file staged by the runtime snapshot builder', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');

    expect(dockerfile).toContain(
      'COPY apps/sandbox/opencode-warmup.sh ./apps/sandbox/opencode-warmup.sh',
    );
    expect(dockerfile).toContain('COPY apps/sandbox/MACHINE.md ./apps/sandbox/MACHINE.md');
  });

  test('refreshes the compiled agent time after the final source copy', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const sourceCopy = dockerfile.lastIndexOf(
      'COPY apps/kortix-sandbox-agent-server/src ./apps/kortix-sandbox-agent-server/src',
    );
    const artifactRefresh = dockerfile.lastIndexOf(
      'touch apps/kortix-sandbox-agent-server/dist/kortix-agent',
    );

    expect(sourceCopy).toBeGreaterThan(-1);
    expect(artifactRefresh).toBeGreaterThan(sourceCopy);
  });

  test('copies every migration runner dependency into the self-host image', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const scriptsDir = resolve(repoRoot, 'packages/db/scripts');
    const pending = ['migrate.ts'];
    const runnerFiles = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (runnerFiles.has(file)) continue;
      runnerFiles.add(file);
      const source = readFileSync(resolve(scriptsDir, file), 'utf8');
      for (const match of source.matchAll(/from '\.\/([\w-]+)'/g)) {
        pending.push(`${match[1]}.ts`);
      }
    }

    expect(runnerFiles.size).toBeGreaterThan(1);
    for (const file of runnerFiles) {
      expect(dockerfile).toContain(
        `COPY --from=deps /app/packages/db/scripts/${file} ./packages/db/scripts/${file}`,
      );
    }
  });
});
