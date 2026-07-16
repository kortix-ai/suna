// Usage: node scripts/vendor-extend-viewer.mjs pdf-viewer src/features/file-renderers/pdf
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [name, outDir] = process.argv.slice(2);
if (!name || !outDir) {
  console.error('Usage: node scripts/vendor-extend-viewer.mjs <registry-name> <out-dir>');
  process.exit(1);
}

const res = await fetch(`https://www.extend.ai/ui/r/${name}.json`);
if (!res.ok) {
  console.error(`Registry fetch failed: ${res.status}`);
  process.exit(1);
}
const item = await res.json();
mkdirSync(outDir, { recursive: true });
for (const file of item.files) {
  const target = join(outDir, basename(file.path));
  writeFileSync(target, file.content);
  console.log(`${target} (${Math.round(file.content.length / 1024)}KB)`);
}
