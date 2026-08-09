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

  it('removes superseded cross-cutting workflows and runners', () => {
    for (const path of [
      '.github/workflows/package-tests.yml',
      '.github/workflows/e2e.yml',
      '.github/workflows/qa-nightly.yml',
      'Makefile',
      'tests/bin/kortix.ts',
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
  });

  it('starts a fresh Supabase stack before migrations without waiting on schema health', () => {
    const source = readFileSync(resolve(root, 'tests/src/core/local-stack.ts'), 'utf8');

    expect(source).toMatch(/"start",\s+"--ignore-health-check"/);
  });

  it('generates an unpredictable internal gateway token for each local stack', () => {
    const source = readFileSync(resolve(root, 'tests/src/core/local-stack.ts'), 'utf8');

    expect(source).toContain('const gatewayToken = `ke2e-local-${crypto.randomUUID()}`;');
    expect(source).not.toContain('"ke2e-local-gateway-internal-token"');
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
    const smoke = source.indexOf("'smoke:install'");
    const dryPack = source.indexOf('verifyPublishablePackage(directory, false)');

    expect(smoke).toBeGreaterThan(-1);
    expect(dryPack).toBeGreaterThan(smoke);
    expect(source).toContain('scripts/publish-npm-package.test.mjs');
    expect(source).toContain("'@kortix/sdk', 'typecheck'");
    expect(source).toContain("verifyPublishablePackage('agent-tunnel')");
    expect(source).toContain('packed agent-tunnel CLI cannot load its WebSocket fallback');
    expect(source).toContain("'--no-sort'");
    expect(source).toContain("KORTIX_API_TEST_WORKERS: '3'");
    expect(source).toContain("['@kortix/cli', '@kortix/sandbox-agent-server']");
    expect(source).toContain("await runWorkspaceTests(['@kortix/db'], 1)");
    expect(source).toContain("'!kortix-api'");
    expect(source).toContain("'!@kortix/db'");
  });

  it('runs isolated API test files through a bounded parallel worker pool', () => {
    const source = readFileSync(resolve(root, 'apps/api/scripts/test.sh'), 'utf8');

    expect(source).toContain('api_test_workers="${KORTIX_API_TEST_WORKERS:-4}"');
    expect(source).toContain('--parallel="$api_test_workers"');
  });

  it('keeps process-heavy package tests on their proven concurrency settings', () => {
    const cliPackage = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8'));
    const agentPackage = JSON.parse(
      readFileSync(resolve(root, 'apps/kortix-sandbox-agent-server/package.json'), 'utf8'),
    );
    const dbPackage = JSON.parse(readFileSync(resolve(root, 'packages/db/package.json'), 'utf8'));

    expect(cliPackage.scripts.test).toContain('bun test --isolate --parallel=4');
    expect(agentPackage.scripts.test).toBe('bun test');
    expect(dbPackage.scripts.test).toBe('bun test --parallel=2 --max-concurrency 2');
  });

  it('keeps connector discovery convergence out of the parallel API lane', () => {
    const source = readFileSync(resolve(root, 'tests/src/flows/connectors.flow.ts'), 'utf8');
    const start = source.indexOf("'CONN-15'");
    const end = source.indexOf("'CONN-12'", start);

    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).toContain('serial: true');
  });

  it('runs browser fixture SQL through the Node client without a host psql binary', () => {
    const source = readFileSync(resolve(root, 'tests/e2e/helpers/database.ts'), 'utf8');

    expect(source).toContain('new Client');
    expect(source).not.toContain('execFileSync("psql"');
  });
});
