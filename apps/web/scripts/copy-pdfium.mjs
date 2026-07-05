import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const wasm = new URL('../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url).pathname;
const out = new URL('../public/pdfium/pdfium.wasm', import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
copyFileSync(wasm, out);
console.log(`Copied pdfium.wasm -> ${out}`);
