// Stage a workspace package's package.json for `npm publish`.
//
// In the monorepo, publishable packages point main/types/exports at src/ so
// in-repo TypeScript consumers compile straight from source with no prebuilt
// dist/. The PUBLISHED npm artifact must instead point at the compiled dist/,
// ship only dist + README, lock the release version, and replace any
// `workspace:*` dependency with the concrete version it ships in lockstep with.
//
// Each publishable package declares its published layout in its own
// `publishConfig` (main/types/exports/files/type). This script promotes that
// onto the top-level manifest npm reads from the tarball — so the published
// package is correct regardless of whether the npm client honours publishConfig
// overrides — then validates that every published entrypoint actually exists in
// the build output (catches drift between publishConfig and the emitted dist/).
//
// Run from the package directory AFTER `bun run build`:
//
//   VERSION=1.2.3 node ../../scripts/stage-npm-publish.mjs
//
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const version = process.env.VERSION?.trim();
if (!version) {
  console.error('stage-npm-publish: VERSION env is required');
  process.exit(1);
}

const path = 'package.json';
const pkg = JSON.parse(readFileSync(path, 'utf8'));

// 1) Lock the published version to the platform release version.
pkg.version = version;

// 2) Promote the publishConfig layout (dist-pointing) onto the top-level fields
//    npm reads from the tarball, then drop the now-applied overrides (the rest
//    of publishConfig — e.g. `access` — stays so npm still honours it).
//
//    `browser`/`unpkg`/`jsdelivr` are promoted the same way, if present: npm,
//    unpkg, and jsDelivr all read these from the TOP-LEVEL manifest only —
//    nothing consults `publishConfig` for them. A package with no CDN bundle
//    (e.g. @kortix/llm-catalog) simply has none of these keys in publishConfig,
//    so the promotion is a no-op for it — if-present, never assumed.
const pc = pkg.publishConfig ?? {};
for (const field of ['type', 'main', 'types', 'exports', 'files', 'bin', 'browser', 'unpkg', 'jsdelivr']) {
  if (pc[field] !== undefined) {
    pkg[field] = pc[field];
    delete pc[field];
  }
}

// 3) Replace every `workspace:` dependency with the exact lockstep version, so
//    the published package resolves its siblings from the public registry. Real
//    registry ranges (^, >=, …) and peer ranges are left untouched.
const pinned = [];
for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      deps[name] = version;
      pinned.push(`${name}@${version}`);
    }
  }
}

// 4) Validate that every published entrypoint exists in dist/ — a missing target
//    means the build did not emit what publishConfig advertises, which would
//    publish a broken package. Fail loudly instead.
const targets = new Set();
const add = (v) => {
  if (typeof v === 'string' && v.startsWith('./')) targets.add(v);
};
add(pkg.main);
add(pkg.types);
add(pkg.browser);
add(pkg.unpkg);
add(pkg.jsdelivr);
const walkExports = (entry) => {
  if (typeof entry === 'string') add(entry);
  else if (entry && typeof entry === 'object') for (const v of Object.values(entry)) walkExports(v);
};
walkExports(pkg.exports);
const missing = [...targets].filter((t) => !existsSync(t));
if (missing.length) {
  console.error(`stage-npm-publish: ${pkg.name} declares entrypoints missing from the build output:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Run the package build first, or fix publishConfig to match the emitted dist/.');
  process.exit(1);
}

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`staged ${pkg.name}@${version} for publish`);
console.log(`  main:   ${pkg.main ?? '(none)'}`);
console.log(`  types:  ${pkg.types ?? '(none)'}`);
if (pkg.browser || pkg.unpkg || pkg.jsdelivr) {
  console.log(`  browser:${pkg.browser ?? '(none)'}  unpkg:${pkg.unpkg ?? '(none)'}  jsdelivr:${pkg.jsdelivr ?? '(none)'}`);
}
console.log(`  files:  ${JSON.stringify(pkg.files ?? [])}`);
console.log(`  exports:${Object.keys(pkg.exports ?? {}).length} entrypoint(s), all present in dist/`);
if (pinned.length) console.log(`  pinned: ${pinned.join(', ')}`);
