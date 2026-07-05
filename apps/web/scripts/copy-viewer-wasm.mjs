import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Document viewers (PDF, DOCX, XLSX) load their WebAssembly engines inside
// `blob:`-URL Web Workers. Inside such a worker a bundler-emitted, root-relative
// asset URL cannot be resolved by `fetch`. Copying each engine's wasm into
// `public/` lets the viewers reference it at a stable, origin-qualified absolute
// URL that resolves correctly from inside the worker.
const assets = [
  {
    from: '../node_modules/@embedpdf/pdfium/dist/pdfium.wasm',
    to: '../public/pdfium/pdfium.wasm',
  },
  {
    from: '../node_modules/@extend-ai/react-docx/dist/docx_wasm_bg.wasm',
    to: '../public/react-docx/docx_wasm_bg.wasm',
  },
  {
    from: '../node_modules/@extend-ai/react-xlsx/dist/duke_sheets_wasm_bg.wasm',
    to: '../public/react-xlsx/duke_sheets_wasm_bg.wasm',
  },
];

for (const asset of assets) {
  const src = new URL(asset.from, import.meta.url).pathname;
  const out = new URL(asset.to, import.meta.url).pathname;
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(src, out);
  console.log(`Copied ${asset.from.split('/').pop()} -> ${out}`);
}
