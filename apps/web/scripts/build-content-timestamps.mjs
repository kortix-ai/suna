// Derives a lastModified timestamp for every public content source that lacks
// an explicit `date` frontmatter field — docs MDX files and code-rendered
// marketing pages — by reading the most recent git commit that touched the
// source file. Use-cases already carry a `date` frontmatter value that
// public-content.ts reads directly, so they are intentionally excluded here to
// avoid drift between the two sources.
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
//
// The committed manifest is only the fallback for builds that cannot read full
// git history (a shallow clone). A date in it cannot be verified from the tree:
// a squash merge stamps a new committer date on the commit that carries it.
// `invalidContentTimestamps` therefore checks what the tree decides: the entry
// keys equal the content sources on disk, and every value is an ISO instant.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS_WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APPS_WEB, '..', '..');
const DOCS_ROOT = join(APPS_WEB, 'content', 'docs');
const MANIFEST_PATH = join(APPS_WEB, 'src', 'lib', 'seo', 'content-timestamps.json');

// Marketing slug -> source page.tsx path (relative to repo root). Mirrors the
// MARKETING_RECORDS mapping in src/lib/seo/public-content.ts; both lists must
// stay in sync. A slug without a backing page.tsx (none today) is skipped.
const MARKETING_SOURCES = {
  index: 'apps/web/src/app/[locale]/(public)/(marketing)/(home)/page.tsx',
  about: 'apps/web/src/app/[locale]/(public)/(seo)/about/page.tsx',
  contact: 'apps/web/src/app/[locale]/(public)/(marketing)/contact/page.tsx',
  developers: 'apps/web/src/app/[locale]/(public)/(marketing)/developers/page.tsx',
  enterprise: 'apps/web/src/app/[locale]/(public)/(marketing)/enterprise/page.tsx',
  pricing: 'apps/web/src/app/[locale]/(public)/(marketing)/pricing/page.tsx',
  marketplace: 'apps/web/src/app/[locale]/(public)/(marketing)/marketplace/page.tsx',
  legal: 'apps/web/src/app/[locale]/(public)/(seo)/legal/page.tsx',
  security: 'apps/web/src/app/[locale]/(public)/(marketing)/security/page.tsx',
  'self-hosted': 'apps/web/src/app/[locale]/(public)/(marketing)/self-hosted/page.tsx',
  services: 'apps/web/src/app/[locale]/(public)/(sales)/services/page.tsx',
  'case-studies': 'apps/web/src/features/marketing/case-studies/content.ts',
  'white-label': 'apps/web/src/app/[locale]/(public)/(marketing)/white-label/page.tsx',
  careers: 'apps/web/src/app/[locale]/(public)/(seo)/careers/page.tsx',
  changelog: 'apps/web/src/app/[locale]/(public)/(seo)/changelog/page.tsx',
  'use-cases': 'apps/web/src/app/[locale]/(public)/(seo)/use-cases/page.tsx',
  download: 'apps/web/src/app/[locale]/(public)/download/page.tsx',
  cli: 'apps/web/src/app/[locale]/(public)/(marketing)/cli/page.tsx',
  desktop: 'apps/web/src/app/[locale]/(public)/(marketing)/desktop/page.tsx',
  mobile: 'apps/web/src/app/[locale]/(public)/(marketing)/mobile/page.tsx',
  slack: 'apps/web/src/app/[locale]/(public)/(marketing)/slack/page.tsx',
  teams: 'apps/web/src/app/[locale]/(public)/(marketing)/teams/page.tsx',
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

function lastCommit(format, pathRelativeToRepo) {
  try {
    return execFileSync('git', ['log', '-1', `--format=${format}`, 'HEAD', '--', pathRelativeToRepo], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function lastCommitIso(pathRelativeToRepo) {
  const committed = lastCommit('%cI', pathRelativeToRepo);
  if (committed) return new Date(committed).toISOString();
  // A source file that exists on disk but has no commit touching it yet — a
  // page written on a branch and not yet committed. `git log` is silent for it,
  // which would leave its record without a `lastModified` and fail
  // public-content.test.ts on every uncommitted new page. Fall back to the
  // file's own modification time: it is the same "when did this content become
  // publishable" signal, and the git value takes over on the first commit.
  try {
    const absolute = join(REPO_ROOT, pathRelativeToRepo);
    if (!existsSync(absolute)) return null;
    return statSync(absolute).mtime.toISOString();
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
    return raw.split('\n').filter(Boolean).sort();
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

// Manifest key -> source path relative to the repo root.
function contentSources() {
  const sources = {};
  for (const [slug, sourceRel] of Object.entries(MARKETING_SOURCES)) {
    sources[`marketing:${slug}`] = sourceRel;
  }
  for (const absPath of listDocsMdx()) {
    const rel = relative(REPO_ROOT, absPath).replaceAll('\\', '/');
    const docsRel = rel.replace(/^apps\/web\/content\/docs\//, '');
    sources[`docs:${slugifyDocs(docsRel)}`] = rel;
  }
  return sources;
}

function collectContentTimestampManifest() {
  const manifest = {};
  for (const [key, rel] of Object.entries(contentSources())) {
    const iso = lastCommitIso(rel);
    if (iso) manifest[key] = iso;
  }
  return manifest;
}

// Keys of `committed` that disagree with the content sources on disk: a source
// without an entry, an entry without a source, or a value that is not an ISO
// instant. Reads the tree only, so the result is the same on every branch.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function invalidContentTimestamps(committed) {
  const sources = contentSources();
  const expected = Object.entries(sources)
    .filter(([, rel]) => existsSync(join(REPO_ROOT, rel)))
    .map(([key]) => key);
  const invalid = [];
  for (const key of new Set([...expected, ...Object.keys(committed)])) {
    const value = committed[key];
    const valid = expected.includes(key) && typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
    if (!valid) invalid.push(key);
  }
  return invalid.sort();
}

function createContentTimestampManifest() {
  if (!gitAvailable()) return {};
  return collectContentTimestampManifest();
}

function refreshContentTimestamps() {
  // No git or a shallow clone (Vercel's default checkout). In a shallow
  // clone `git log -1 -- <path>` returns the single present commit for
  // every file, which would overwrite the correct committed manifest
  // (built in a full-history environment) with uniform build-time
  // timestamps. Preserve the committed manifest by leaving it in place.
  if (!gitAvailable()) return {};

  const manifest = collectContentTimestampManifest();
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--strict')) {
      if (!gitAvailable()) throw new Error('Content timestamps require full git history');
      const manifest = collectContentTimestampManifest();
      mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      refreshContentTimestamps();
    }
  } catch (error) {
    if (process.argv.includes('--strict')) throw error;
    // The manifest is an optimization. Direct generation must not block a build.
  }
}

export { createContentTimestampManifest, invalidContentTimestamps, MANIFEST_PATH, refreshContentTimestamps };
