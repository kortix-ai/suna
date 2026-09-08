/**
 * Reading a template's repository — the file tree and one file's text.
 *
 * A template is a public GitHub repo pinned to `resolved_sha`, and nothing about
 * its files is in our database. So this reads GitHub directly, always at the
 * pinned sha, which is what makes the whole thing safe to cache forever: a
 * `owner/repo@sha` is immutable, so a response can never go stale and a memo
 * never needs invalidating.
 *
 * `githubFetch` supplies the token (5,000 req/hr instead of the anonymous 60)
 * and refuses to send it anywhere but GitHub's two hosts. This module is that
 * leaf's first consumer since the old marketplace was deleted — which is
 * exactly why it was kept.
 *
 * A leaf itself: no config, no db, so the route's semantics stay unit-testable
 * without booting the API's env graph.
 */

import { githubFetch } from '../shared/github-fetch';
import type { TemplateCatalogEntry } from '../templates/catalog';

/** One readable file in a template's repository. */
export interface TemplateFile {
  /** Repo-relative path, e.g. `.kortix/opencode/agents/sre.md`. */
  path: string;
  /** Bytes, as GitHub reports them. */
  size: number;
}

/**
 * The most files we will list. A template is a small, curated repo; a listing
 * this long already means someone pinned the wrong thing, and an unbounded list
 * would be an unbounded response.
 */
const MAX_FILES = 600;

/**
 * The largest file we will serve. Big enough for any manifest, agent or skill
 * document; small enough that one request cannot pin a lot of memory.
 */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Extensions the viewer cannot render. They are hidden from the tree rather
 * than listed-and-broken: everything the tree shows can be opened, which is the
 * property that makes it worth clicking.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'class', 'pyc',
  'sqlite', 'db', 'lock',
]);

function isRenderable(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  // No extension at all (LICENSE, Dockerfile, Makefile) is text by convention.
  if (dot <= 0) return true;
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Content keyed by `owner/repo@sha[:path]`, which can never change — so this is
 * a memo, not a cache: there is no TTL and no invalidation, only a bound.
 *
 * The bound matters because the keys are per-template and per-file. Oldest-out
 * on overflow (a Map iterates in insertion order), which for a curated catalog
 * read by crawlers is indistinguishable from LRU and costs no bookkeeping.
 */
const memo = new Map<string, unknown>();
const MEMO_MAX_ENTRIES = 400;

function remember<T>(key: string, value: T): T {
  if (memo.size >= MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, value);
  return value;
}

/** `owner/repo@sha` — the identity every read is keyed and pinned by. */
function pinOf(template: TemplateCatalogEntry): string {
  return `${template.repo}@${template.resolved_sha}`;
}

/**
 * Every readable file in the template's repo at its pinned commit.
 *
 * Returns `[]` rather than throwing when GitHub will not answer: the file tree
 * is an enrichment of the detail page, and a rate limit or a deleted repo must
 * degrade to "no files" instead of 500-ing a page whose real content — what the
 * template declares — came from the catalog and is already in hand.
 */
export async function listTemplateFiles(
  template: TemplateCatalogEntry,
): Promise<TemplateFile[]> {
  const key = `tree:${pinOf(template)}`;
  const hit = memo.get(key);
  if (hit) return hit as TemplateFile[];

  const url = `https://api.github.com/repos/${template.repo}/git/trees/${template.resolved_sha}?recursive=1`;
  try {
    const response = await githubFetch(url, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      tree?: Array<{ path?: string; type?: string; size?: number }>;
    };
    const files = (body.tree ?? [])
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .filter((entry) => isRenderable(entry.path as string))
      .filter((entry) => (entry.size ?? 0) <= MAX_FILE_BYTES)
      .slice(0, MAX_FILES)
      .map((entry) => ({ path: entry.path as string, size: entry.size ?? 0 }));
    return remember(key, files);
  } catch {
    return [];
  }
}

/**
 * One file's text, or `null` when it is not part of this template.
 *
 * The path is checked against the LISTING rather than sanitized, which is the
 * stronger guarantee: a caller can only read a path this template actually
 * publishes, so traversal, absolute paths and "any file in any repo" are all
 * answered by the same check, and a caller cannot use us to probe a repo.
 */
export async function readTemplateFile(
  template: TemplateCatalogEntry,
  path: string,
): Promise<string | null> {
  const files = await listTemplateFiles(template);
  if (!files.some((file) => file.path === path)) return null;

  const key = `file:${pinOf(template)}:${path}`;
  const hit = memo.get(key);
  if (typeof hit === 'string') return hit;

  const url = `https://raw.githubusercontent.com/${template.repo}/${template.resolved_sha}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  try {
    const response = await githubFetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_FILE_BYTES) return null;
    // A NUL byte means the extension lied about being text. Backstop only —
    // `isRenderable` already keeps the known binaries out of the listing.
    if (text.includes('\0')) return null;
    return remember(key, text);
  } catch {
    return null;
  }
}

/**
 * The file a template's page opens on: its README, else the manifest, else the
 * first file. Named separately from the route so the web app and the tests
 * agree on "the default doc" without duplicating the rule.
 */
export function defaultTemplateFile(files: TemplateFile[]): string | undefined {
  const paths = files.map((file) => file.path);
  return (
    paths.find((path) => /^readme\.mdx?$/i.test(path)) ??
    paths.find((path) => /readme\.mdx?$/i.test(path)) ??
    paths.find((path) => /^kortix\.ya?ml$/i.test(path)) ??
    paths[0]
  );
}

/** Test seam: the memo is process-wide and immutable-by-key, so only tests clear it. */
export function __clearTemplateFileMemo(): void {
  memo.clear();
}
