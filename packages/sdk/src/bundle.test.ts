import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(import.meta.dir, '..', 'dist');
const ESM = join(DIST, 'kortix.esm.min.js');
const IIFE = join(DIST, 'kortix.global.js');

// These tests require `pnpm --filter @kortix/sdk run build:bundles` to have run.
const built = existsSync(ESM) && existsSync(IIFE);

test.skipIf(!built)('no browser bundle contains node:child_process', () => {
  for (const file of [ESM, IIFE]) {
    const source = readFileSync(file, 'utf8');
    // Native harness SDKs commonly pull Node-only modules. If they land here,
    // the browser bundle crossed the runtime-client boundary.
    expect(source.includes('node:child_process') ? `${file} pulls node:child_process` : null).toBeNull();
    expect(source.includes('async_hooks') ? `${file} pulls async_hooks` : null).toBeNull();
  }
});

test.skipIf(!built)('the IIFE bundle assigns a Kortix global with the core API', () => {
  const source = readFileSync(IIFE, 'utf8');
  expect(source.length).toBeGreaterThan(1000);
  // `globalName: 'Kortix'` makes tsup emit `var Kortix=(()=>{…})()`.
  expect(/\bKortix\b/.test(source)).toBe(true);
});
