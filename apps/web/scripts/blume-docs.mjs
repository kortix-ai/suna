import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// /docs is a Blume (Astro) static site built from `content/docs/` +
// `blume.config.ts`. `blume build` writes its output to `dist/` at the repo
// root of apps/web. Its `deployment.base` config leaves pages FLAT at the
// dist root (verified: `dist/index.html`, `dist/quickstart/index.html`,
// `dist/sdk/index.html`) rather than nested under a `dist/docs/` subfolder —
// so the whole `dist/` directory, not a subdirectory of it, is what gets
// copied into `public/docs/`.
//
// Single source of truth for the build + copy: next.config.ts imports this
// module directly (belt-and-suspenders, same pattern as scripts/viewer-wasm.mjs
// and scripts/emojibase-data.mjs) so the docs site is guaranteed to exist
// before `next build` finishes, even though Vercel's buildCommand is a bare
// `next build` that never runs an npm script.
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB_ROOT, 'dist');
const PUBLIC_DOCS = path.join(WEB_ROOT, 'public', 'docs');
const CONTENT_DOCS = path.join(WEB_ROOT, 'content', 'docs');
const BLUME_CONFIG = path.join(WEB_ROOT, 'blume.config.ts');

/** Absolute paths of the `public/docs/` files that prove the Blume build landed. */
export function getBlumeDocsOutputPaths() {
  return [
    path.join(PUBLIC_DOCS, 'index.html'),
    path.join(PUBLIC_DOCS, 'quickstart', 'index.html'),
  ];
}

/** Most recent mtime (ms) of any file under `root`, or of `root` itself if it's a file. */
function newestMtimeMs(root) {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(root)) {
    const childMtime = newestMtimeMs(path.join(root, entry));
    if (childMtime > newest) newest = childMtime;
  }
  return newest;
}

/**
 * True when `public/docs/index.html` already reflects the current
 * `content/docs/` + `blume.config.ts` sources, so the (tens-of-seconds)
 * `blume build` can be skipped.
 *
 * next.config.ts loads once in the main `next build` process and again,
 * independently, in each forked static-generation worker — every load calls
 * `buildBlumeDocs()`. Those forks are separate OS processes with no shared
 * memory, so the only reliable place to dedupe across them is the
 * filesystem: skip the rebuild if the output is no older than every input.
 */
function isPublicDocsUpToDate() {
  const outputIndex = getBlumeDocsOutputPaths()[0];
  if (!fs.existsSync(outputIndex)) return false;
  const outputMtime = fs.statSync(outputIndex).mtimeMs;
  return outputMtime >= newestMtimeMs(CONTENT_DOCS) && outputMtime >= newestMtimeMs(BLUME_CONFIG);
}

/**
 * Build the Blume docs site (`npx blume build`) and copy its flat `dist/`
 * output into `public/docs/`, replacing whatever was there before.
 *
 * No-ops when `public/docs/` is already at least as new as its sources (see
 * `isPublicDocsUpToDate`) — otherwise every one of `next build`'s forked
 * static-generation workers would redundantly rerun the full Astro build.
 *
 * Throws if `blume build` fails or if `dist/` does not exist afterward.
 * Callers (next.config.ts) decide whether that is fatal — see the
 * `getBlumeDocsOutputPaths()` existence check there, which tolerates a slim
 * prod image that ships `public/` but not the `content/docs/` build inputs.
 */
export function buildBlumeDocs() {
  if (isPublicDocsUpToDate()) return;
  execFileSync('npx', ['blume', 'build'], { cwd: WEB_ROOT, stdio: 'inherit' });
  fs.rmSync(PUBLIC_DOCS, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DOCS, { recursive: true });
  fs.cpSync(DIST, PUBLIC_DOCS, { recursive: true });
}
