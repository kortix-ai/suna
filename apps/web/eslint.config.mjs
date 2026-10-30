import { readFileSync } from 'node:fs';
import { sharedConfig, sdkBoundaryConfig } from '../../scripts/eslint/shared-config.mjs';
const sdkBoundaryBaseline = JSON.parse(
  readFileSync(new URL('./src/sdk-boundary-baseline.json', import.meta.url), 'utf8'),
);
const sdkBoundaryLegacyFiles = [
  ...new Set(
    sdkBoundaryBaseline.map((entry) => {
      const [, file] = entry.split('\t');
      return `src/${file}`;
    }),
  ),
];
const sdkBoundaryShimFiles = ['src/lib/iam-client.ts'];
export default [
  ...sharedConfig,
  { ...sdkBoundaryConfig, ignores: [...sdkBoundaryLegacyFiles, ...sdkBoundaryShimFiles] },
  {
    /* The module that binds DEFAULT_ICON_WEIGHT onto the SSR icons, plus the
       test that checks the binding against the raw entry. Nothing else may
       reach past it. */
    files: ['src/lib/icons/ssr.tsx', 'src/lib/icons/ssr.test.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    /* fumadocs-mdx codegen output (gitignored, not tracked — see
       apps/web/.gitignore). It ships its own `@ts-nocheck` intentionally
       (skips type checking a generated re-export barrel) and is
       regenerated on every `next dev`/`next build`, so there is nothing to
       fix here; exclude it from linting entirely. */
    ignores: ['.source/**'],
  },
];
