import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const testsPackage = JSON.parse(readFileSync(resolve(root, 'tests/package.json'), 'utf8'));

describe('local test runner contract', () => {
  it('uses the one workspace lockfile', () => {
    expect(existsSync(resolve(root, 'pnpm-lock.yaml'))).toBe(true);
    expect(existsSync(resolve(root, 'tests/bun.lock'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/package-lock.json'))).toBe(false);
  });

  it('exposes one local-first command from the repository root', () => {
    expect(rootPackage.scripts.test).toBe('bun tests/bin/local.ts');
    expect(rootPackage.scripts['test:flows']).toBeUndefined();
    expect(rootPackage.scripts['test:browser']).toBeUndefined();
    expect(testsPackage.scripts.test).toContain('vitest run');
  });

  it('starts a fresh Supabase stack before migrations without waiting on schema health', () => {
    const source = readFileSync(resolve(root, 'tests/src/core/local-stack.ts'), 'utf8');

    expect(source).toMatch(/"start",\s+"--ignore-health-check"/);
  });

  it('snapshots fixture counts into results before teardown starts', () => {
    const runner = readFileSync(resolve(root, 'tests/src/core/runner.ts'), 'utf8');
    const fixtureSnapshot = runner.indexOf('fixtureStats: world.fixtureStats()');
    const teardown = runner.indexOf('await world.teardownAll()');

    expect(fixtureSnapshot).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(fixtureSnapshot);
  });

  it('builds publishable artifacts once and schedules package tests by load class', () => {
    const source = readFileSync(resolve(root, 'tests/bin/package-quality.ts'), 'utf8');
    const smoke = source.indexOf('"smoke:install"');
    const dryPack = source.indexOf('verifyPublishablePackage(directory, false)');

    expect(smoke).toBeGreaterThan(-1);
    expect(dryPack).toBeGreaterThan(smoke);
    expect(source).toContain('"--no-sort"');
    expect(source).toContain('KORTIX_API_TEST_WORKERS: "3"');
    expect(source).toContain('["@kortix/cli", "@kortix/sandbox-agent-server"]');
    expect(source).toContain('await runWorkspaceTests(["@kortix/db"], 1)');
    expect(source).toContain('"!kortix-api"');
    expect(source).toContain('"!@kortix/db"');
  });

  it('runs isolated API test files through a bounded parallel worker pool', () => {
    const source = readFileSync(resolve(root, 'apps/api/scripts/test.sh'), 'utf8');

    expect(source).toContain('api_test_workers="${KORTIX_API_TEST_WORKERS:-4}"');
    expect(source).toContain('--parallel="$api_test_workers"');
  });

  it('runs process-heavy CLI and sandbox-agent test files in parallel', () => {
    const cliPackage = JSON.parse(
      readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8'),
    );
    const agentPackage = JSON.parse(
      readFileSync(resolve(root, 'apps/kortix-sandbox-agent-server/package.json'), 'utf8'),
    );
    const dbPackage = JSON.parse(
      readFileSync(resolve(root, 'packages/db/package.json'), 'utf8'),
    );

    expect(cliPackage.scripts.test).toContain('bun test --isolate --parallel=4');
    expect(agentPackage.scripts.test).toBe('bun test --parallel=4');
    expect(dbPackage.scripts.test).toBe('bun test --parallel=2 --max-concurrency 2');
  });

  it('keeps connector discovery convergence out of the parallel API lane', () => {
    const source = readFileSync(resolve(root, 'tests/src/flows/connectors.flow.ts'), 'utf8');
    const start = source.indexOf("'CONN-15'");
    const end = source.indexOf("'CONN-12'", start);

    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).toContain('serial: true');
  });
});
