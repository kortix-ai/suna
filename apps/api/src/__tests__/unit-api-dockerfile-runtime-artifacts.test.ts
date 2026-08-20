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
    expect(dockerfile).toContain(
      'COPY apps/sandbox/MACHINE.fast.md ./apps/sandbox/MACHINE.fast.md',
    );
    expect(dockerfile).toContain('COPY apps/sandbox/lazy-tools ./apps/sandbox/lazy-tools');
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

    expect(dockerfile).toContain(
      'COPY --from=deps /app/packages/db/scripts/migration-runtime-overrides.ts ./packages/db/scripts/migration-runtime-overrides.ts',
    );
  });
});
