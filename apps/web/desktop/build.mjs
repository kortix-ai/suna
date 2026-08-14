#!/usr/bin/env node
// Build the Kortix desktop bundle: `apps/web`'s (app) route group, statically
// exported to `out/`, for the Electron shell to serve over `app://`.
//
// WHY A SCRIPT AND NOT JUST A CONFIG FLAG
// `output: 'export'` is all-or-nothing over the app directory, and most of
// `src/app` cannot be exported and should not be: `(public)` is the marketing
// and SEO surface (llms.txt, .well-known/*, OG image generation, blog RSS),
// `(system)` is API route handlers, and `src/middleware.ts` is unsupported in
// export mode outright. The desktop app needs none of it — the Electron nav
// gate already sends non-product routes to the user's real browser.
//
// So the build temporarily takes everything except `(app)` out of the app
// directory, exports what is left, and puts it all back. Every mutation is
// journalled and undone in a `finally`, including on crash and on SIGINT, so a
// failed build never leaves the checkout modified. Nothing here is committed in
// a mutated state and `apps/web`'s normal build is untouched.
//
// Usage:  node desktop/build.mjs [--backend-url https://dev-api.kortix.com]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(WEB_ROOT, 'src', 'app');
const HIDDEN_DIR = path.join(WEB_ROOT, '.desktop-hidden');
const DESKTOP_DIR = path.join(WEB_ROOT, 'desktop');

// Everything in src/app that the desktop bundle keeps. The (app) group is the
// authenticated product surface; the loose files are the root layout and the
// error/not-found boundaries it needs to render at all.
const KEEP_ENTRIES = new Set([
  '(app)',
  // The real sign-in UI. Its server actions are replaced by a client-side
  // overlay (desktop/overlay/app/(auth)/auth/actions.ts) so the PAGE ships
  // unchanged; only the pieces listed in HIDE_NESTED cannot be exported.
  '(auth)',
  // Kept only because the root layout imports the fonts that live under it
  // (`./(system)/fonts/roobert`). Everything else in the group is hidden by
  // HIDE_NESTED below.
  '(system)',
  'layout.tsx',
  'error.tsx',
  'global-error.tsx',
  'not-found.tsx',
  'globals.css',
  'react-query-provider.tsx',
]);

// Paths inside a kept entry that must still be hidden, relative to src/app.
const HIDE_NESTED = [
  // Route handlers — a static export emits no server routes. /auth/callback is
  // re-provided as a client page by the overlay.
  '(auth)/auth/callback',
  '(auth)/auth/mobile',
  // Browser hand-off flows that belong in the real browser, not the app. Each
  // also carries a dynamic segment or server dependency of its own.
  '(auth)/oauth',
  '(auth)/cli',
  '(auth)/github',
  '(auth)/tunnel',
  '(auth)/teams',
  '(auth)/slack',
  '(system)/api',
  '(system)/maintenance',
  '(system)/countryerror',
  '(system)/debug',
  '(system)/p',
];

// Param value every dynamic segment is exported against. Chosen to be
// impossible as a real id so a shell page leaking into a real URL is obvious
// in a screenshot rather than subtle.
const SHELL_PARAM = '__shell__';

/* ─── Mutation journal ─────────────────────────────────────────────────── */

/** @type {Array<() => void>} */
const undoStack = [];

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  undoStack.push(() => {
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.renameSync(to, from);
  });
}

function writeNew(file, contents) {
  // Record which ancestor directories we are about to create, so undo can take
  // them away again. Leaving them behind is not cosmetic: an empty leftover
  // `src/app/(desktop-callback)/` is a route-group entry that the NEXT build
  // dutifully hides, and restore then fails with ENOTEMPTY when the overlay has
  // meanwhile recreated it. Observed exactly that.
  const created = [];
  for (let dir = path.dirname(file); !fs.existsSync(dir); dir = path.dirname(dir)) {
    created.push(dir);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);

  undoStack.push(() => {
    fs.rmSync(file, { force: true });
    // Deepest first; rmdir refuses a non-empty directory, which is the correct
    // behaviour if something else legitimately landed there.
    for (const dir of created) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break;
      }
    }
  });
}

function overwrite(file, contents) {
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, contents);
  undoStack.push(() => fs.writeFileSync(file, original));
}

function restore() {
  while (undoStack.length > 0) {
    const undo = undoStack.pop();
    try {
      undo();
    } catch (err) {
      // Keep unwinding: one failed undo must not strand the rest of the tree.
      console.error(`[desktop/build] restore step failed: ${err.message}`);
    }
  }
  // Undoing the moves leaves the empty parent directories behind. Remove the
  // staging tree only once it holds no files at all — anything still in there
  // is un-restored source and must stay put for a human to look at.
  if (fs.existsSync(HIDDEN_DIR)) {
    const leftover = fs
      .readdirSync(HIDDEN_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile());
    if (leftover.length === 0) {
      fs.rmSync(HIDDEN_DIR, { recursive: true, force: true });
    } else {
      console.error(
        `[desktop/build] ${leftover.length} file(s) still in ${path.relative(WEB_ROOT, HIDDEN_DIR)} — restore incomplete`,
      );
    }
  }
}

/* ─── Route-tree analysis ──────────────────────────────────────────────── */

/**
 * Every routable path under a route group that contains a dynamic segment,
 * as a Next route pattern (`/projects/[id]/sessions/[sessionId]`).
 *
 * Route groups `(name)` and private folders `_name` contribute no URL segment,
 * matching Next's own routing rules.
 */
function collectDynamicRoutes(dir, prefix = '') {
  /** @type {{ pattern: string, dir: string, param: string }[]} */
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('_') || name.startsWith('.')) continue;

    const isGroup = name.startsWith('(') && name.endsWith(')');
    const isDynamic = name.startsWith('[') && name.endsWith(']');
    const childPrefix = isGroup ? prefix : `${prefix}/${name}`;
    const childDir = path.join(dir, name);

    if (isDynamic) {
      found.push({
        pattern: childPrefix,
        dir: childDir,
        param: name.slice(1, -1).replace(/^\.\.\./, ''),
      });
    }
    found.push(...collectDynamicRoutes(childDir, childPrefix));
  }
  return found;
}

/* ─── Build steps ──────────────────────────────────────────────────────── */

function hideNonDesktopRoutes() {
  const hiddenApp = path.join(HIDDEN_DIR, 'app');
  let hidden = 0;
  for (const entry of fs.readdirSync(APP_DIR)) {
    if (KEEP_ENTRIES.has(entry)) continue;
    move(path.join(APP_DIR, entry), path.join(hiddenApp, entry));
    hidden += 1;
  }
  for (const nested of HIDE_NESTED) {
    const from = path.join(APP_DIR, nested);
    if (!fs.existsSync(from)) continue;
    move(from, path.join(hiddenApp, nested));
    hidden += 1;
  }

  // Middleware is rejected outright by `output: 'export'`. Its desktop-relevant
  // job (auth gating) is the Electron nav gate's plus the client route guard's.
  const middleware = path.join(WEB_ROOT, 'src', 'middleware.ts');
  if (fs.existsSync(middleware)) {
    move(middleware, path.join(HIDDEN_DIR, 'middleware.ts'));
  }

  console.log(`[desktop/build] hid ${hidden} non-desktop app entries + middleware`);
}

function addShellParams(dynamicRoutes) {
  for (const route of dynamicRoutes) {
    const layout = path.join(route.dir, 'layout.tsx');
    const generator =
      `\n// Injected by desktop/build.mjs — a static export must prerender every\n` +
      `// dynamic segment against a concrete value. Real ids only exist at runtime,\n` +
      `// so one shell is exported and desktop/nav-shim.tsx recovers the real param\n` +
      `// from the URL at render time.\n` +
      `export function generateStaticParams() {\n` +
      `  return [{ ${JSON.stringify(route.param)}: ${JSON.stringify(SHELL_PARAM)} }];\n` +
      `}\n`;

    if (fs.existsSync(layout)) {
      const source = fs.readFileSync(layout, 'utf8');
      if (/^\s*['"]use client['"]/m.test(source)) {
        throw new Error(
          `${path.relative(WEB_ROOT, layout)} is a client component, so it cannot export ` +
            `generateStaticParams. Add a server layout at this segment.`,
        );
      }
      overwrite(layout, source + generator);
    } else {
      writeNew(
        layout,
        `import type { ReactNode } from 'react';\n` +
          `\n// Passthrough layout created by desktop/build.mjs solely to host\n` +
          `// generateStaticParams for this dynamic segment.\n` +
          `export default function DesktopShellLayout({ children }: { children: ReactNode }) {\n` +
          `  return children;\n` +
          `}\n` +
          generator,
      );
    }
  }
  console.log(`[desktop/build] shell params for ${dynamicRoutes.length} dynamic segments`);
}

function writeRoutePatterns(dynamicRoutes) {
  // Most-specific first: nav-shim takes the first match, and a deeper pattern
  // yields strictly more params than its ancestors.
  const patterns = [...new Set(dynamicRoutes.map((r) => r.pattern))].sort(
    (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b),
  );

  overwrite(
    path.join(DESKTOP_DIR, 'route-patterns.generated.ts'),
    `// GENERATED by desktop/build.mjs — do not edit.\n` +
      `// Every dynamic route in the desktop bundle, most-specific first.\n` +
      `// Consumed by desktop/nav-shim.tsx to recover real params from the URL.\n\n` +
      `export const ROUTE_PATTERNS: readonly string[] = [\n` +
      patterns.map((p) => `  ${JSON.stringify(p)},\n`).join('') +
      `];\n`,
  );
  console.log(`[desktop/build] route patterns: ${patterns.length}`);
  for (const p of patterns) console.log(`               ${p}`);
}

function applyOverlay() {
  const overlayRoot = path.join(DESKTOP_DIR, 'overlay');
  if (!fs.existsSync(overlayRoot)) return;

  let count = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(from);
        continue;
      }
      const target = path.join(WEB_ROOT, 'src', path.relative(overlayRoot, from));
      const contents = fs.readFileSync(from);
      if (fs.existsSync(target)) overwrite(target, contents);
      else writeNew(target, contents);
      count += 1;
    }
  };
  walk(overlayRoot);
  console.log(`[desktop/build] applied ${count} overlay files`);
}

/* ─── Entry point ──────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const backendUrlIndex = args.indexOf('--backend-url');
const backendUrl =
  backendUrlIndex !== -1 ? args[backendUrlIndex + 1] : process.env.NEXT_PUBLIC_BACKEND_URL;

// The https origin OAuth returns to. Must be an allowlisted Supabase redirect
// host, so it is the real web app — never the loopback the bundle runs on.
const webOriginIndex = args.indexOf('--web-origin');
const webOrigin =
  webOriginIndex !== -1 ? args[webOriginIndex + 1] : process.env.KORTIX_DESKTOP_WEB_ORIGIN;

if (fs.existsSync(HIDDEN_DIR)) {
  throw new Error(
    `${path.relative(WEB_ROOT, HIDDEN_DIR)} already exists — a previous desktop build did not ` +
      `restore. Move its contents back into src/ before retrying.`,
  );
}

let interrupted = false;
const onSignal = () => {
  if (interrupted) return;
  interrupted = true;
  restore();
  process.exit(130);
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  const dynamicRoutes = collectDynamicRoutes(path.join(APP_DIR, '(app)'));
  hideNonDesktopRoutes();
  applyOverlay();
  addShellParams(dynamicRoutes);
  writeRoutePatterns(dynamicRoutes);

  console.log('[desktop/build] running next build (static export)…');
  execFileSync(path.join(WEB_ROOT, 'node_modules', '.bin', 'next'), ['build'], {
    cwd: WEB_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      KORTIX_DESKTOP_BUILD: '1',
      ...(backendUrl ? { NEXT_PUBLIC_BACKEND_URL: backendUrl } : {}),
      ...(webOrigin ? { KORTIX_DESKTOP_WEB_ORIGIN: webOrigin } : {}),
    },
  });

  const out = path.join(WEB_ROOT, 'out');
  if (!fs.existsSync(path.join(out, 'index.html')) && !fs.existsSync(out)) {
    throw new Error('next build produced no out/ directory');
  }
  console.log(`[desktop/build] ✓ exported to ${path.relative(process.cwd(), out)}`);
} finally {
  restore();
  console.log('[desktop/build] restored source tree');
}
