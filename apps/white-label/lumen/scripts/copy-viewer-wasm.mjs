// The @kortix/ui document viewers (PDF, DOCX, XLSX) load their WebAssembly
// engines from this origin's public/ folder (/pdfium/, /react-docx/, /react-xlsx/),
// because a blob: worker cannot resolve a bundler asset URL. Copy them there
// before `next dev` / `next build`. The copies are gitignored.
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// pnpm links each dependency under its dependent's node_modules; a package's own deps sit beside it.
const uiDir = dirname(createRequire(import.meta.url).resolve('@kortix/ui/package.json'));
const dep = (dir, name) => realpathSync(join(dir, 'node_modules', name));
const engines = dep(uiDir, '@embedpdf/engines');

const assets = [
  [join(engines, '..', 'pdfium', 'dist/pdfium.wasm'), 'pdfium/pdfium.wasm'],
  [join(dep(uiDir, '@extend-ai/react-docx'), 'dist/docx_wasm_bg.wasm'), 'react-docx/docx_wasm_bg.wasm'],
  [join(dep(uiDir, '@extend-ai/react-xlsx'), 'dist/duke_sheets_wasm_bg.wasm'), 'react-xlsx/duke_sheets_wasm_bg.wasm'],
];
const publicDir = new URL('../public/', import.meta.url).pathname;
for (const [from, to] of assets) {
  mkdirSync(dirname(join(publicDir, to)), { recursive: true });
  copyFileSync(from, join(publicDir, to));
}
console.log(`viewer wasm: ${assets.length} files in public/`);
