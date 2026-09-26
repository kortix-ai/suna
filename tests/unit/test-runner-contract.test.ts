import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
      // Cloud-sandbox CI workers (Platinum/Daytona) — lanes run natively on
      // Blacksmith since 2026-08-26.
      'tests/bin/sandbox-ci.ts',
      'tests/bin/sandbox-ci-cleanup.ts',
      'tests/src/core/sandbox-ci.ts',
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
    expect(source).toContain("KORTIX_TEST_TIMEOUT_MS: '30000'");
    expect(source).toContain("KORTIX_ATTACHMENT_OFFLOAD: '0'");
    expect(source).toContain("await runWorkspaceTests(['@kortix/cli'], 1)");
    expect(source).toContain("await runWorkspaceTests(['kortixd'], 1)");
    expect(source).not.toContain("['@kortix/cli', 'kortixd']");
    expect(source).toContain("runWorkspaceTests(['@kortix/db'], 1)");
    expect(source).toContain('Promise.allSettled(tasks)');
    expect(source.match(/await runAll\(\[/g)).toHaveLength(5);
    expect(source).toContain("'!kortix-api'");
    expect(source).toContain("'!@kortix/db'");
    expect(source).toContain("skipSdkTests ? ['!@kortix/sdk'] : []");
  });

  it('runs isolated API test files through a bounded parallel worker pool', () => {
    const source = readFileSync(resolve(root, 'apps/api/scripts/test.sh'), 'utf8');

    expect(source).toContain('api_test_workers="${KORTIX_API_TEST_WORKERS:-$(detect_api_test_workers)}"');
    expect(source).toContain('--parallel="$api_test_workers"');
    const choose = (availableMb: number) => Number(execFileSync('bash', [
      '-c', `source apps/api/scripts/test-workers.sh; select_api_test_workers ${availableMb}`,
    ], { cwd: root, encoding: 'utf8' }).trim());
    expect([choose(2048), choose(8192), choose(10600), choose(32768)]).toEqual([1, 1, 2, 4]);
  });

  it('restarts Bun after 80 files and still runs later batches after a failure', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'kortix-api-batches-'));
    try {
      const executable = resolve(temp, 'bun');
      const calls = resolve(temp, 'calls');
      writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$BATCH_CAPTURE"\nprintf "END\\n" >> "$BATCH_CAPTURE"\ncount=$(grep -c "^END$" "$BATCH_CAPTURE")\nif [ "$count" = 2 ]; then exit 1; fi\n');
      chmodSync(executable, 0o755);
      const run = spawnSync('bash', ['scripts/test.sh'], {
        cwd: resolve(root, 'apps/api'),
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, BATCH_CAPTURE: calls, KORTIX_API_TEST_WORKERS: '2' },
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      const count = Number(run.stderr.match(/API unit suite: (\d+) files/)?.[1]);
      const batches = readFileSync(calls, 'utf8').split('END\n').filter(Boolean).map((batch) => batch.split('\n').filter(Boolean));
      expect(batches.length).toBe(Math.ceil(count / 80));
      expect(batches.every((batch) => batch.includes('--parallel=2'))).toBe(true);
      expect(batches.every((batch) => batch.filter((arg) => arg.endsWith('.test.ts')).length <= 80)).toBe(true);
      expect(batches.reduce((total, batch) => total + batch.filter((arg) => arg.endsWith('.test.ts')).length, 0)).toBe(count);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps process-heavy package tests on their proven concurrency settings', () => {
    const cliPackage = JSON.parse(readFileSync(resolve(root, 'apps/cli/package.json'), 'utf8'));
    const agentPackage = JSON.parse(
      readFileSync(resolve(root, 'apps/kortix-sandbox-agent-server/package.json'), 'utf8'),
    );
    const dbPackage = JSON.parse(readFileSync(resolve(root, 'packages/db/package.json'), 'utf8'));

    expect(cliPackage.scripts.test).toContain(
      'bun test --timeout ${KORTIX_TEST_TIMEOUT_MS:-15000} --isolate --parallel=4',
    );
    expect(agentPackage.scripts.test).toBe('bun test');
    // Serial on purpose. `--parallel` implies `--isolate`, and under isolation
    // Bun 1.3.14 re-creates process.stdout/stderr per test file, dups the
    // stdio fd into epoll, and never ends the outgoing sinks at the swap
    // (oven-sh/bun#37968; the fix, oven-sh/bun#38008, is still open). A reused
    // fd number then fails EPOLL_CTL_ADD with EEXIST — Linux only, so it never
    // reproduces on a laptop — and Bun reports it as a failure that names no
    // test. That killed the packages lane on run 35331083850, both attempts at
    // the same SHA. 28 files: 11s parallel vs 34s serial, measured in a Linux
    // container against the real disposable-PostgreSQL containers.
    // The PostgreSQL contracts (`*.integration.test.ts`) run one file per
    // process in the `db-suites` lane of the core run, not here.
    expect(dbPackage.scripts.test).toBe(
      "bun test --max-concurrency 2 --path-ignore-patterns='**/*.integration.test.ts'",
    );
  });

  it('keeps bun test isolation opt-in, with a stated reason per package', () => {
    // Isolation is a cost (see the EEXIST note above), not a free speedup. A
    // package earns it with file count, or by giving each file its own PROCESS
    // so the leaking swap never happens. Adding a name here is a deliberate
    // decision to carry that risk.
    const isolated: Record<string, string> = {
      '@kortix/cli': '107 test files; serial would cost minutes, not seconds',
      'Kortix-Computer-Frontend': '762 test files; serial is not viable',
      '@kortix/sdk': 'xargs -n1 -P4 runs one file per process: no isolate swap, no leak',
    };

    const offenders: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const entry of readdirSync(resolve(root, group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = resolve(root, group, entry.name, 'package.json');
        if (!existsSync(manifest)) continue;
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        const script: string | undefined = parsed.scripts?.test;
        if (!script || !parsed.name) continue;
        if (!/--isolate\b|--parallel\b/.test(script)) continue;
        if (parsed.name in isolated) continue;
        offenders.push(`${parsed.name}: ${script}`);
      }
    }

    expect(offenders).toEqual([]);
    for (const [name, reason] of Object.entries(isolated)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('keeps connector discovery convergence out of the parallel API lane', () => {
    const source = readFileSync(resolve(root, 'tests/src/flows/connectors.flow.ts'), 'utf8');
    const start = source.indexOf("'CONN-15'");
    const end = source.indexOf("'CONN-12'", start);

    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).toContain('serial: true');
  });

  it('runs browser fixture SQL through the Node client without a host psql binary', () => {
    const databaseSource = readFileSync(resolve(root, 'tests/e2e/helpers/database.ts'), 'utf8');
    const manifestSource = readFileSync(
      resolve(root, 'tests/e2e/helpers/manifest-project.ts'),
      'utf8',
    );

    expect(databaseSource).toContain('new Client');
    expect(`${databaseSource}\n${manifestSource}`).not.toMatch(/\bpsql\b/);
  });
});
