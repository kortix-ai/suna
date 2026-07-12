/**
 * Parse the address forms accepted by marketplace installs and legacy registry
 * developer commands.
 *
 * Registry addresses (point at a whole registry):
 *   kortix-ai/skills                      GitHub repo (registry.json at root)
 *   github:kortix-ai/skills               explicit github: scheme
 *   kortix-ai/skills@v1                   pinned to a git ref
 *   @kortix                               a namespace (resolved via a map)
 *   https://host/r/registry.json          a registry served over HTTP
 *   ./path/to/registry.json | ./dir       a local registry (dir or file)
 *
 * Item addresses (point at a single item inside a registry):
 *   kortix-ai/skills/pdf                  item "pdf" in GitHub repo
 *   github:kortix-ai/skills@v1/pdf        pinned ref + item
 *   @kortix/pdf                           item "pdf" in the @kortix namespace
 *   https://host/r/pdf.json               a direct item URL
 *   ./dir#pdf | ./registry.json#pdf       item "pdf" in a local registry
 *   pdf                                   bare item (needs a default registry)
 */

export interface GithubRegistryRef {
  kind: 'github';
  owner: string;
  repo: string;
  /** Git ref (branch/tag/sha). Undefined → resolver tries main then master. */
  ref?: string;
  /** Sub-directory holding registry.json, if not the repo root. */
  subdir?: string;
}

export interface UrlRegistryRef {
  kind: 'url';
  /** URL of the registry.json (or the dir base used to resolve item.json). */
  url: string;
}

export interface LocalRegistryRef {
  kind: 'local';
  /** Path to a registry.json file or a directory containing one. */
  path: string;
}

export interface NamespaceRegistryRef {
  kind: 'namespace';
  /** Includes the leading `@`, e.g. "@kortix". */
  namespace: string;
}

export type RegistryRef =
  | GithubRegistryRef
  | UrlRegistryRef
  | LocalRegistryRef
  | NamespaceRegistryRef;

export interface ItemAddress {
  /** The registry the item lives in, or null for a bare name. */
  registry: RegistryRef | null;
  /** Item slug. For a direct item URL this is the basename without `.json`. */
  item: string;
  /** For a direct item URL, the URL of the item JSON itself. */
  directItemUrl?: string;
  /** Original string, for diagnostics. */
  raw: string;
}

function stripScheme(input: string): { value: string; github: boolean } {
  if (input.startsWith('github:')) return { value: input.slice('github:'.length), github: true };
  return { value: input, github: false };
}

function splitRef(repoSegment: string): { repo: string; ref?: string } {
  const at = repoSegment.indexOf('@');
  if (at === -1) return { repo: repoSegment };
  return { repo: repoSegment.slice(0, at), ref: repoSegment.slice(at + 1) || undefined };
}

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

function looksLocal(s: string): boolean {
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s === '.' || s.startsWith('.\\');
}

/** Parse an address that names a whole registry (no item component). */
export function parseRegistryAddress(raw: string): RegistryRef {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty registry address');

  if (isUrl(trimmed)) return { kind: 'url', url: trimmed };
  if (looksLocal(trimmed)) return { kind: 'local', path: trimmed };

  if (trimmed.startsWith('@')) {
    // @namespace  or  @namespace/sub (rare) — treat the first segment as ns.
    const ns = trimmed.split('/')[0];
    return { kind: 'namespace', namespace: ns };
  }

  const { value } = stripScheme(trimmed);
  const segments = value.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`"${raw}" is not a valid registry address (expected owner/repo)`);
  }
  const owner = segments[0];
  const { repo, ref } = splitRef(segments[1]);
  const subdir = segments.length > 2 ? segments.slice(2).join('/') : undefined;
  return { kind: 'github', owner, repo, ref, subdir };
}

/** Parse an address that names a single item inside a registry. */
export function parseItemAddress(raw: string): ItemAddress {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty item address');

  // Direct item URL: https://host/r/pdf.json
  if (isUrl(trimmed)) {
    const url = trimmed;
    const base = url.slice(0, url.lastIndexOf('/'));
    const file = url.slice(url.lastIndexOf('/') + 1);
    const item = file.replace(/\.json$/i, '');
    return {
      registry: { kind: 'url', url: `${base}/registry.json` },
      item,
      directItemUrl: url,
      raw,
    };
  }

  // Local: ./dir#item  |  ./registry.json#item
  if (looksLocal(trimmed)) {
    const hash = trimmed.indexOf('#');
    if (hash === -1) {
      throw new Error(
        `"${raw}" names a local registry but not an item — use "<path>#<item>"`,
      );
    }
    return {
      registry: { kind: 'local', path: trimmed.slice(0, hash) },
      item: trimmed.slice(hash + 1),
      raw,
    };
  }

  // Namespace: @kortix/pdf
  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash === -1) throw new Error(`"${raw}" is missing an item (use @namespace/item)`);
    return {
      registry: { kind: 'namespace', namespace: trimmed.slice(0, slash) },
      item: trimmed.slice(slash + 1),
      raw,
    };
  }

  const { value } = stripScheme(trimmed);
  const segments = value.split('/').filter(Boolean);

  // Bare item name (resolve against a default registry the caller supplies).
  if (segments.length === 1) {
    return { registry: null, item: segments[0], raw };
  }

  if (segments.length < 3) {
    throw new Error(
      `"${raw}" is a registry, not an item — append the item: ${value}/<item>`,
    );
  }

  const owner = segments[0];
  const { repo, ref } = splitRef(segments[1]);
  const item = segments[segments.length - 1];
  const subdir = segments.length > 3 ? segments.slice(2, -1).join('/') : undefined;
  return { registry: { kind: 'github', owner, repo, ref, subdir }, item, raw };
}

// ── SSRF guard ───────────────────────────────────────────────────────────
// User-supplied `url` registry/item addresses are fetched by this package
// (loadRegistry/loadItem in fetch.ts) from contexts (hosted API, sandboxes)
// where the target may be internal. Block loopback/link-local/RFC1918/
// metadata hosts and anything not https. Mirrors `isPrivateHost` in
// apps/api/src/marketplace/catalog.ts (kept in sync by hand — this package
// cannot import across the package boundary).
function isPrivateRegistryHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

/** Throw unless `url` is safe to fetch: https on a non-private host. Every
 *  user-supplied registry/item URL must pass this before it's fetched. */
export function assertFetchableUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (u.protocol !== 'https:' || isPrivateRegistryHost(u.hostname)) {
    throw new Error(`refusing to fetch "${url}" — only https:// URLs on public hosts are allowed`);
  }
}

/** Build a raw.githubusercontent.com URL for a file at a ref. */
export function rawGithubUrl(owner: string, repo: string, ref: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${clean}`;
}

/** Human-readable one-liner for a registry ref. */
export function describeRegistry(ref: RegistryRef): string {
  switch (ref.kind) {
    case 'github':
      return `${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ''}${ref.subdir ? `/${ref.subdir}` : ''}`;
    case 'url':
      return ref.url;
    case 'local':
      return ref.path;
    case 'namespace':
      return ref.namespace;
  }
}

// Exported only so the test suite can assert the helpers directly.
export const _internal = { isUrl, looksLocal, splitRef };
