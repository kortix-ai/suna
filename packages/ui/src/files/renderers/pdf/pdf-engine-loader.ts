import type { PdfEngine } from '@embedpdf/models';

const PDFIUM_WASM_PATH = '/pdfium/pdfium.wasm';

// The pdfium engine runs inside a `blob:`-URL Web Worker. A root-relative path
// (e.g. "/pdfium/pdfium.wasm") has no usable base inside that worker and throws
// on `fetch`, so the URL must be absolutized against the document origin before
// it is handed to the worker.
function resolvePdfiumWasmUrl(): string {
  if (typeof window === 'undefined') return PDFIUM_WASM_PATH;
  return new URL(PDFIUM_WASM_PATH, window.location.origin).href;
}

let sharedEnginePromise: Promise<PdfEngine> | null = null;
export function loadSharedPdfEngine() {
  sharedEnginePromise ??= import('@embedpdf/engines/pdfium-worker-engine').then(
    ({ createPdfiumEngine }) => createPdfiumEngine(resolvePdfiumWasmUrl(), {}),
  );

  return sharedEnginePromise;
}
