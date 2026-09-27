/**
 * Bundles entry.ts the way Metro resolves it: `@/` is the app root and
 * `#default-font/` is the MathJax TeX font (metro.config.js alias).
 * Usage: bun scripts/hermes-math-check/build.ts <outfile>   (cwd = apps/mobile)
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';

const [outfile] = process.argv.slice(2);
const fontDir = realpathSync(path.resolve('node_modules/@mathjax/mathjax-tex-font/mjs'));

const result = await Bun.build({
  entrypoints: [path.resolve(import.meta.dir, 'entry.ts')],
  target: 'browser',
  format: 'iife',
  plugins: [
    {
      name: 'mathjax-default-font',
      setup(build) {
        build.onResolve({ filter: /^#default-font\// }, (args) => ({
          path: path.join(fontDir, args.path.slice('#default-font/'.length)),
        }));
      },
    },
  ],
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
await Bun.write(outfile, result.outputs[0]);
