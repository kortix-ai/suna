#!/usr/bin/env node
// Guard that runs before electron-builder packages the app.
//
// The shell falls back to loading the remote website when no bundle is present
// (src/bundle.js bundleDir() -> null). That fallback is correct at runtime and
// dangerous at package time: without this check, a release whose bundle step
// silently failed would install fine, launch fine, and quietly be the OLD
// network-dependent app. Nobody would notice until the next outage.
//
// So: refuse to package unless the export is present and plausible.

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '..', 'web', 'out');

// Files every desktop export must contain. Each one is load-bearing:
//   projects.html          — the window's first navigation target
//   auth.html              — sign-in; its absence is the "/auth 404" regression
//   auth/callback.html     — the OAuth landing
//   _next                  — the client bundle the pages are useless without
const REQUIRED = [
  'projects.html',
  'auth.html',
  path.join('auth', 'callback.html'),
  '_next',
];

function fail(message) {
  console.error(`\n[prepack] ${message}\n`);
  console.error('Build the bundle first:');
  console.error('  cd apps/web && node desktop/build.mjs --web-origin <https://…>\n');
  process.exit(1);
}

if (!fs.existsSync(OUT)) {
  fail(`No desktop bundle at ${OUT}.`);
}

const missing = REQUIRED.filter((entry) => !fs.existsSync(path.join(OUT, entry)));
if (missing.length > 0) {
  fail(`Desktop bundle at ${OUT} is incomplete — missing: ${missing.join(', ')}.`);
}

// A shell-exported dynamic route is the whole point of the bundle; if the
// export ran without them, deep links would 404 at runtime instead of at build.
const shell = path.join(OUT, 'projects', '__shell__.html');
if (!fs.existsSync(shell)) {
  fail(`Desktop bundle has no dynamic-route shell (${shell}). Deep links would 404.`);
}

const count = fs.readdirSync(OUT, { recursive: true }).length;
console.log(`[prepack] ✓ desktop bundle present (${count} entries)`);
