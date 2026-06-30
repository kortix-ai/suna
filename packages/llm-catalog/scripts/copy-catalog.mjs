// Copy the generated model catalog next to the emitted module so the published
// dist/index.js can resolve its `./catalog.generated.json` import at runtime.
// tsc type-checks JSON imports (resolveJsonModule) but never emits the .json
// into outDir, so we copy it ourselves after the build.
import { copyFileSync } from 'node:fs';

const src = 'src/catalog.generated.json';
const dest = 'dist/catalog.generated.json';
copyFileSync(src, dest);
console.log(`copied ${src} -> ${dest}`);
