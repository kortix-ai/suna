import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Bind the Vite server vitest runs to an explicit loopback address. Vite's
  // default host is `localhost`, and resolveHostname() dns-probes it during
  // buildStart — on a box where `localhost` does not resolve (/etc/hosts
  // unreadable by the suite's user) that probe throws ENOTFOUND and kills the
  // run before a single test starts. An explicit host skips the probe; on a
  // normal machine it changes nothing: the server stays in middleware mode and
  // never listens.
  server: { host: '127.0.0.1' },
  test: {
    name: 'unit',
    root: import.meta.dirname,
    environment: 'node',
    globals: true,
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
