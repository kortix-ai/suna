import { defineConfig } from 'vitest/config';

export default defineConfig({
  // A literal IP, never 'localhost': vite@7's buildStart resolves 'localhost'
  // through DNS on every startup, and a container without a readable
  // /etc/hosts (the factory worker sandboxes) crashes the whole lane before a
  // single test runs. vite@8 already skips that probe under a verbatim
  // result order; pinning the host skips it everywhere.
  server: {
    host: '127.0.0.1',
  },
  test: {
    name: 'unit',
    root: import.meta.dirname,
    environment: 'node',
    globals: true,
    // Several unit tests spawn bash or git, and `pnpm test` runs this lane beside
    // five others. A test that spawns a shell script (announce-dev-live,
    // kortixd-package-boundary) takes under 1 s alone and passed 5 s, vitest's
    // default, at a load average of 33.
    testTimeout: 30_000,
    // On a small sandbox the five sibling lanes saturate every core and this
    // lane's own main process starves past vitest's fixed 60 s worker→main RPC
    // timeout: flow-runner-unit died four runs in a row on a 6-vCPU factory
    // sandbox with all 796 tests passing — the lane failed on the unhandled
    // RPC error, not on a test. Cap the pool with KE2E_UNIT_MAX_WORKERS on
    // such boxes (the factory's attestation runs do); CI and dev machines
    // keep vitest's default. Fewer workers cost wall time, not coverage.
    maxWorkers: process.env.KE2E_UNIT_MAX_WORKERS
      ? Number(process.env.KE2E_UNIT_MAX_WORKERS)
      : undefined,
    include: ['**/*.test.ts'],
    reporters: ['default', ['junit', { suiteName: 'unit' }]],
    outputFile: {
      junit: '../test-results/unit/junit.xml',
    },
    coverage: {
      enabled: false,
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: '../test-results/unit/coverage',
      include: ['**/*.ts'],
      exclude: ['**/*.test.ts', 'vitest.config.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
