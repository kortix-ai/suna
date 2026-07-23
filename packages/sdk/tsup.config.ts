import { defineConfig } from 'tsup';

/**
 * Browser bundles, beside (never replacing) the `tsc` ESM dist/.
 *
 * `noExternal` inlines workspace runtime deps a <script> tag cannot resolve.
 * Keep the bundle ACP/runtime-client based; native harness SDKs must not enter
 * the browser bundle.
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
    noExternal: [/^@kortix\//],
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
    noExternal: [/^@kortix\//],
    // tsup's default iife naming always appends ".global.js" to the entry
    // name (even when the name already says "global"), which would emit
    // dist/kortix.global.global.js instead of the dist/kortix.global.js this
    // package publishes via unpkg/jsdelivr. Pin the extension explicitly.
    outExtension: () => ({ js: '.js' }),
  },
]);
