import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'contract',
    root: import.meta.dirname,
    environment: 'node',
    globals: true,
    include: ['**/*.pact.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    isolate: false,
    reporters: ['default', ['junit', { suiteName: 'contract' }]],
    outputFile: {
      junit: '../test-results/contract/junit.xml',
    },
  },
});
