import { defineConfig } from 'vitest/config';

// Only the Convex backend tests run under vitest (convex-test needs import.meta.glob).
// Everything else under tests/unit runs under bun test.
export default defineConfig({
  test: { include: ['tests/convex/**/*.test.ts'], environment: 'node' },
});
