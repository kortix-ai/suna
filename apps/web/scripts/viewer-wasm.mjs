import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Document viewers (PDF, DOCX, XLSX) load their WebAssembly engines inside
// `blob:`-URL Web Workers. Inside such a worker a bundler-emitted, root-relative
// asset URL cannot be resolved by `fetch`. Copying each engine's wasm into
// `public/` lets the viewers reference it at a stable, origin-qualified absolute
// URL that resolves correctly from inside the worker.
//
// Single source of truth for the copy: both the CLI entry point
// (scripts/copy-viewer-wasm.mjs, prefixed onto `dev`/`build` in package.json)
// and next.config.ts (belt-and-suspenders for any path that invokes `next
// build`/`next dev` directly, bypassing the npm script) call this module.
export const VIEWER_WASM_ASSETS = [
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

function resolve(relativePath) {
  return new URL(relativePath, import.meta.url).pathname;
}

/** Absolute paths of the `public/` wasm files the viewers require at runtime. */
export function getViewerWasmOutputPaths() {
  return VIEWER_WASM_ASSETS.map((asset) => resolve(asset.to));
}

/**
 * Copy each viewer engine's wasm binary from node_modules into `public/`.
 * Returns the copied assets (with resolved absolute paths) on success.
 *
 * Throws if any source file is missing — e.g. a slim prod image that ships
 * `public/` but not the node_modules the wasm ships in. Callers decide
 * whether that's fatal (see next.config.ts, which tolerates it when
 * `public/` already has the outputs baked in from build time).
 */
export function copyViewerWasm() {
  const copied = [];
  for (const asset of VIEWER_WASM_ASSETS) {
    const src = resolve(asset.from);
    const out = resolve(asset.to);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
    copied.push({ from: asset.from, to: asset.to, src, out });
  }
  return copied;
}
