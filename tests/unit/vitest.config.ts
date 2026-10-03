import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    root: import.meta.dirname,
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
    // Pin the loopback address. Vite's resolveHostname probes `localhost` via
    // DNS while building the runner server, and a locked-down runner (its
    // /etc/hosts is unreadable) fails that probe with ENOTFOUND before any
    // test runs. A concrete host skips the probe; localhost and 127.0.0.1 are
    // the same address on an ordinary machine, so nothing changes there.
    api: { host: '127.0.0.1' },
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
