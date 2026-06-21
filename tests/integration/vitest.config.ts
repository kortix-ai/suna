import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    root: import.meta.dirname,
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default', ['junit', { suiteName: 'integration' }]],
    outputFile: {
      junit: '../test-results/integration/junit.xml',
    },
  },
});
