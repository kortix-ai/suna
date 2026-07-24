// Derives a lastModified timestamp for every public content source that lacks
// an explicit `date` frontmatter field — docs MDX files and code-rendered
// marketing pages — by reading the most recent git commit that touched the
// source file. Blog posts and use-cases already carry a `date` frontmatter
// value that public-content.ts reads directly, so they are intentionally
// excluded here to avoid drift between the two sources.
//
// Output: apps/web/src/lib/seo/content-timestamps.json
//   { "<kind>:<slug>": "<ISO 8601 commit-date string>", ... }
//
// The manifest is regenerated on every `next build` / `next dev` (wired into
// next.config.ts alongside the viewer-wasm belt-and-suspenders pattern) so the
// runtime always sees fresh timestamps without a per-request `git` call.
// `public-content.ts` reads the manifest with a graceful fallback to
// `undefined` when it is absent (e.g. a fresh clone that has not been built
// yet, or the bun test runner before the manifest is generated), preserving
// the prior behavior for those code paths.
//
// Why %cI (committer date, strict ISO) instead of %aI (author date): the
// committer date reflects when the change landed on the branch being built,
// which is the closest git-native proxy for "when this content became
// publishable on this site." Author date can predate the merge by months when a
// commit is rebased or cherry-picked, which would mislead recency-aware
// retrievers.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const APPS_WEB = resolve(new URL('.', import.meta.url).pathname, '..');
const REPO_ROOT = resolve(APPS_WEB, '..', '..');
const DOCS_ROOT = join(APPS_WEB, 'content', 'docs');
const MANIFEST_PATH = join(APPS_WEB, 'src', 'lib', 'seo', 'content-timestamps.json');

// Marketing slug -> source page.tsx path (relative to repo root). Mirrors the
// MARKETING_RECORDS mapping in src/lib/seo/public-content.ts; both lists must
// stay in sync. A slug without a backing page.tsx (none today) is skipped.
const MARKETING_SOURCES = {
  index: 'apps/web/src/app/(public)/(marketing)/page.tsx',
  about: 'apps/web/src/app/(public)/(seo)/about/page.tsx',
  contact: 'apps/web/src/app/(public)/(marketing)/contact/page.tsx',
  developers: 'apps/web/src/app/(public)/(marketing)/developers/page.tsx',
  enterprise: 'apps/web/src/app/(public)/(marketing)/enterprise/page.tsx',
  pricing: 'apps/web/src/app/(public)/(marketing)/pricing/page.tsx',
  marketplace: 'apps/web/src/app/(public)/(marketing)/marketplace/page.tsx',
  support: 'apps/web/src/app/(public)/(marketing)/support/page.tsx',
  legal: 'apps/web/src/app/(public)/(seo)/legal/page.tsx',
};

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', cwd: REPO_ROOT });
    if (!existsSync(join(REPO_ROOT, '.git'))) return false;
    // A shallow clone (Vercel's default checkout) makes `git log -1 -- <path>`
    // return the single present commit for EVERY file, which would overwrite
    // the correct committed manifest with uniform build-time timestamps. Detect
    // a shallow clone and skip regeneration so the committed manifest (built in
    // a full-history environment) is preserved. `git rev-parse --is-shallow-
    // repository` prints `true`/`false`; a missing `.git/shallow` is the same
    // signal without the subprocess.
    const shallowFile = join(REPO_ROOT, '.git', 'shallow');
    if (existsSync(shallowFile)) return false;
    const out = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return out === 'false';
  } catch {
    return false;
  }
}

function lastCommitIso(pathRelativeToRepo) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', pathRelativeToRepo], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function listDocsMdx() {
  if (!existsSync(DOCS_ROOT)) return [];
  // `find` is portable across Linux/macOS dev and CI. Output is sorted so the
  // generated manifest is deterministic for a given git tree.
  try {
    const raw = execFileSync('find', [DOCS_ROOT, '-name', '*.mdx', '-type', 'f'], {
      encoding: 'utf8',
    });
    return raw
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function slugifyDocs(relativePath) {
  // content/docs/index.mdx -> index
  // content/docs/concepts/accounts.mdx -> concepts/accounts
  // content/docs/concepts/index.mdx -> concepts
  const noExt = relativePath.replace(/\.mdx$/, '');
  const normalized = noExt.replaceAll('\\', '/');
  if (normalized === 'index') return 'index';
  return normalized.replace(/\/index$/, '');
}

function build() {
  const manifest = {};

  if (!gitAvailable()) {
    // No git or a shallow clone (Vercel's default checkout). In a shallow
    // clone `git log -1 -- <path>` returns the single present commit for
    // every file, which would overwrite the correct committed manifest
    // (built in a full-history environment) with uniform build-time
    // timestamps. Preserve the committed manifest by leaving it in place
    // and returning without writing. public-content.ts reads the existing
    // file; if none exists (fresh clone w/o a committed manifest), it falls
    // back to undefined lastModified (the prior behavior). Return an empty
    // object here only to signal "not regenerated"; the on-disk file is the
    // source of truth at runtime.
    return manifest;
  }

  // Marketing pages
  for (const [slug, sourceRel] of Object.entries(MARKETING_SOURCES)) {
    const iso = lastCommitIso(sourceRel);
    if (iso) manifest[`marketing:${slug}`] = iso;
  }

  // Docs MDX files
  for (const absPath of listDocsMdx()) {
    const rel = relative(REPO_ROOT, absPath).replaceAll('\\', '/');
    const docsRel = rel.replace(/^apps\/web\/content\/docs\//, '');
    const slug = slugifyDocs(docsRel);
    const iso = lastCommitIso(rel);
    if (iso) manifest[`docs:${slug}`] = iso;
  }

  safeWrite(manifest);
  return manifest;
}

// Never throw from the build-time side effect: a non-writable output dir or a
// transient fs failure must not crash `next build`/`next dev`. The manifest
// is an optimization (freshness signaling), not a correctness requirement —
// public-content.ts tolerates its absence.
function safeWrite(manifest) {
  try {
    const dir = dirname(MANIFEST_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    // intentionally swallowed; see comment above
  }
}

try {
  build();
} catch {
  // belt-and-suspenders: any uncaught error in build() is swallowed so the
  // importing next.config.ts never fails to load.
}

export { build, MANIFEST_PATH };
