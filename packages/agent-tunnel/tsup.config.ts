import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry points — standalone executables
  {
    entry: {
      'agent-cli': 'src/agent/cli.ts',
      'client-cli': 'src/client/cli.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    banner: {
      js: '#!/usr/bin/env node',
    },
    bundle: true,
    external: ['os', 'fs', 'path', 'crypto', 'child_process'],
    sourcemap: false,
    clean: true,
  },
  // Library exports — for programmatic use
  {
    entry: {
      'index': 'src/index.ts',
      'shared/index': 'src/shared/index.ts',
      'server/index': 'src/server/index.ts',
      'client/index': 'src/client/index.ts',
      'agent/index': 'src/agent/index.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    bundle: false,
    dts: true,
    sourcemap: true,
    clean: false,
  },
]);
