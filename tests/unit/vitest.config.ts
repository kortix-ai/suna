import { defineConfig } from 'vitest/config';

export default defineConfig({
  // A pinned loopback host: vite's buildStart resolves `localhost` via DNS and
  // an unresolvable localhost (a locked-down runtime's hosts file) rejects the
  // whole startup. 127.0.0.1 needs no lookup and serves the same interface.
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
