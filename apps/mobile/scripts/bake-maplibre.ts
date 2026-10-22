/**
 * Bakes assets/maplibre/maplibre-gl.webjs and maplibre-gl-css.webjs from the pinned maplibre-gl.
 * Run after a version change: `bun scripts/bake-maplibre.ts` (or `pnpm bake:maplibre`).
 * Bake with the Bun version CI pins (1.4.3): another Bun minifies to other names, and the byte check fails.
 *
 * MapLibre 6 ships ES modules and a separate worker module. The map page is an HTML string in a
 * WebView (map-html.ts), with no origin to load modules from, so it inlines one classic script:
 * the worker bundled to a source string and started from a Blob URL (`setWorkerUrl`), and the
 * library on `window.maplibregl`. map-asset.test.ts rebuilds it and compares the bytes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dir, '..');
const dist = path.join(root, 'node_modules/maplibre-gl/dist');
const ENTRY = 'kx-maplibre-entry';

async function bundle(entry: string, plugins: Bun.BunPlugin[] = []): Promise<string> {
  // A classic script cannot hold import.meta. The library reads import.meta.url as a base URL: to guess a
  // worker next to itself (unused: the worker URL is set) and to resolve the worker URL. The page's URL serves.
  const define = { 'import.meta.url': 'location.href' };
  const out = await Bun.build({ entrypoints: [entry], format: 'iife', target: 'browser', minify: true, define, plugins });
  if (!out.success) throw new AggregateError(out.logs, 'maplibre bundle failed');
  const code = await out.outputs[0].text();
  if (code.includes('import.meta')) throw new Error('maplibre bundle still reads import.meta');
  return code;
}

export async function buildMaplibreScript(): Promise<string> {
  const library = path.join(dist, 'maplibre-gl.mjs');
  // Minify drops comments; the BSD-3 license banner stays on top.
  const license = readFileSync(library, 'utf8').match(/^\/\*\*[\s\S]*?\*\//)?.[0];
  if (!license) throw new Error('maplibre-gl.mjs has no license banner');
  // The worker runs as a classic script: a module worker from a Blob URL fails to load in an opaque
  // origin (the WebView page has baseUrl ''). The library starts a classic worker for a URL ending in
  // .cjs, and a Blob URL resolves without its fragment, so '#worker.cjs' selects it.
  const worker = await bundle(path.join(dist, 'maplibre-gl-worker.mjs'));
  const entry = `import * as maplibregl from ${JSON.stringify(library)};
maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' })) + '#worker.cjs');
window.maplibregl = maplibregl;`;
  const script = await bundle(ENTRY, [
    {
      name: ENTRY,
      setup(build) {
        build.onResolve({ filter: new RegExp(`^${ENTRY}$`) }, () => ({ path: ENTRY, namespace: ENTRY }));
        build.onLoad({ filter: /.*/, namespace: ENTRY }, () => ({ contents: entry, loader: 'js' }));
      },
    },
  ]);
  return `${license}\n${script}`;
}

if (import.meta.main) {
  writeFileSync(path.join(root, 'assets/maplibre/maplibre-gl.webjs'), await buildMaplibreScript());
  writeFileSync(path.join(root, 'assets/maplibre/maplibre-gl-css.webjs'), readFileSync(path.join(dist, 'maplibre-gl.css')));
}
