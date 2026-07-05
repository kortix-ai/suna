import { copyViewerWasm } from './viewer-wasm.mjs';

// Thin CLI entry point — the actual copy logic (and the "why") lives in
// scripts/viewer-wasm.mjs, which next.config.ts also imports directly so
// there is exactly one source of truth for the asset list and copy behavior.
for (const asset of copyViewerWasm()) {
  console.log(`Copied ${asset.from.split('/').pop()} -> ${asset.out}`);
}
