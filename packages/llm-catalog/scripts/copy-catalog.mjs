// Copy the generated JSON files next to the emitted modules so the published
// dist/ can resolve its `./catalog.generated.json` and
// `./provider-env.generated.json` imports at runtime. tsc type-checks JSON
// imports (resolveJsonModule) but never emits the .json into outDir, so we
// copy them ourselves after the build.
import { copyFileSync } from 'node:fs';

for (const name of ['catalog.generated.json', 'provider-env.generated.json']) {
  const src = `src/${name}`;
  const dest = `dist/${name}`;
  copyFileSync(src, dest);
  console.log(`copied ${src} -> ${dest}`);
}
