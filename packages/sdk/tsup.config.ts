import { defineConfig } from 'tsup';

/**
 * Browser bundles, beside (never replacing) the `tsc` ESM dist/.
 *
 * `noExternal` inlines the runtime deps a <script> tag cannot resolve. We inline
 * ONLY `@opencode-ai/sdk/v2/client` — its graph is error-interceptor + the three
 * generated modules, all browser-safe. The package's root and `/server` entries
 * pull `node:child_process`; letting a bundler reach them ships a broken global.
 */
export default defineConfig([
  {
    entry: { 'kortix.esm.min': 'src/index.ts' },
    format: ['esm'],
    minify: true,
    platform: 'browser',
    outDir: 'dist',
    dts: false,
    clean: false,
    noExternal: [/^@kortix\//, /^@opencode-ai\//],
  },
  {
    entry: { 'kortix.global': 'src/index.ts' },
    format: ['iife'],
    globalName: 'Kortix',
    minify: true,
    platform: 'browser',
    outDir: 'dist',
    dts: false,
    clean: false,
    noExternal: [/^@kortix\//, /^@opencode-ai\//],
    // tsup's default iife naming always appends ".global.js" to the entry
    // name (even when the name already says "global"), which would emit
    // dist/kortix.global.global.js instead of the dist/kortix.global.js this
    // package publishes via unpkg/jsdelivr. Pin the extension explicitly.
    outExtension: () => ({ js: '.js' }),
  },
]);
