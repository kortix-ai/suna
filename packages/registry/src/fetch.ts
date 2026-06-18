/**
 * Resolve + fetch registries and items from GitHub, plain URLs, or disk.
 *
 * Everything is injectable (`fetchImpl`, `readFile`) so the engine is testable
 * without network or filesystem, and so the API can reuse it with a git-backed
 * file reader instead of `node:fs`.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import {
  describeRegistry,
  parseItemAddress,
  rawGithubUrl,
  type GithubRegistryRef,
  type ItemAddress,
  type LocalRegistryRef,
  type RegistryRef,
  type UrlRegistryRef,
} from './address';
import { parseFrontmatter } from './manifest';
import { groupSkillFiles } from './skills';
import type { RegistryItem, RegistryJson } from './schema';

export interface RegistryLoaderOptions {
  /** HTTP fetch. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Read a local file as UTF-8. Defaults to node:fs/promises. */
  readFile?: (path: string) => Promise<string>;
  /** Git refs to try for an unpinned GitHub registry. Default: main, master. */
  defaultRefs?: string[];
  /** Namespace → item URL template, e.g. "@kortix" → "https://h/r/{name}.json". */
  namespaces?: Record<string, string>;
  /** Resolve a bare item name against this registry. */
  defaultRegistry?: RegistryRef;
  /** Synthesize `registry:bundle`s from a `.claude-plugin/marketplace.json`. Off
   *  by default — the marketplace is skills-first; plugin grouping is opt-in. */
  includeBundles?: boolean;
}

export interface ResolvedRegistry {
  ref: RegistryRef;
  /** Merged registry (items flattened across `include`). */
  registry: RegistryJson;
  /** Read a file by its path relative to the item that declares it. */
  readItemFile: (itemName: string, filePath: string) => Promise<string>;
}

export interface ResolvedItem {
  ref: RegistryRef;
  item: RegistryItem;
  /** Read one of the item's files (honors inline `content`). */
  readFile: (filePath: string) => Promise<string>;
}

function posixJoin(...parts: string[]): string {
  return parts
    .filter((p) => p && p !== '.')
    .join('/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '');
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return res.text();
}

/** A reader bound to a registry root: `read(relPath)` relative to that root. */
type RootReader = (relPath: string) => Promise<string>;

/** Fold a namespace ref into a URL ref using the caller-supplied template. */
function resolveNamespace(
  ref: RegistryRef,
  opts: RegistryLoaderOptions,
): GithubRegistryRef | UrlRegistryRef | LocalRegistryRef {
  if (ref.kind !== 'namespace') return ref;
  const template = opts.namespaces?.[ref.namespace];
  if (!template) {
    throw new Error(`unknown namespace "${ref.namespace}" — register it first`);
  }
  const base = template.slice(0, template.lastIndexOf('/'));
  return { kind: 'url', url: `${base}/registry.json` };
}

async function makeRootReader(
  refIn: RegistryRef,
  opts: RegistryLoaderOptions,
): Promise<{ ref: RegistryRef; read: RootReader }> {
  const ref = resolveNamespace(refIn, opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readFile = opts.readFile ?? fsReadFile.bind(null);

  if (ref.kind === 'github') {
    const subdir = ref.subdir ?? '';
    const refsToTry = ref.ref ? [ref.ref] : opts.defaultRefs ?? ['main', 'master'];
    let goodRef: string | null = ref.ref ?? null;
    if (!goodRef) {
      for (const candidate of refsToTry) {
        try {
          await fetchText(rawGithubUrl(ref.owner, ref.repo, candidate, posixJoin(subdir, 'registry.json')), fetchImpl);
          goodRef = candidate;
          break;
        } catch {
          // try the next ref
        }
      }
    }
    const resolvedRef = goodRef ?? refsToTry[0];
    const resolved: RegistryRef = { ...ref, ref: resolvedRef };
    const read: RootReader = (relPath) =>
      fetchText(rawGithubUrl(ref.owner, ref.repo, resolvedRef, posixJoin(subdir, relPath)), fetchImpl);
    return { ref: resolved, read };
  }

  if (ref.kind === 'url') {
    const base = posixDirname(ref.url);
    const read: RootReader = (relPath) => fetchText(`${base}/${relPath}`, fetchImpl);
    return { ref, read };
  }

  // local
  const dir = ref.path.endsWith('.json') ? posixDirname(ref.path) || '.' : ref.path;
  const read: RootReader = (relPath) =>
    readFile(`${dir}/${relPath}`.replace(/\/{2,}/g, '/')) as Promise<string>;
  return { ref, read };
}

async function collectItems(
  read: RootReader,
  registry: RegistryJson,
  baseDir: string,
  into: RegistryItem[],
  itemBase: Map<string, string>,
  seenIncludes: Set<string>,
): Promise<void> {
  for (const item of registry.items ?? []) {
    into.push(item);
    if (!itemBase.has(item.name)) itemBase.set(item.name, baseDir);
  }
  for (const inc of registry.include ?? []) {
    const incPath = posixJoin(baseDir, inc);
    if (seenIncludes.has(incPath)) continue;
    seenIncludes.add(incPath);
    const nested = JSON.parse(await read(incPath)) as RegistryJson;
    await collectItems(read, nested, posixDirname(incPath), into, itemBase, seenIncludes);
  }
}

/** List a GitHub repo's tree (recursive) at a ref — via the Git Trees API. */
async function listGithubTree(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`tree ${url} → HTTP ${res.status}`);
  const json = JSON.parse(await res.text()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
  // The Git Trees API clips at 100k entries / 7MB and flags `truncated`. Returning
  // a partial list would silently drop skills + make drift-detection flap — refuse.
  if (json.truncated) {
    throw new Error(`tree ${owner}/${repo}@${ref} is truncated (>100k entries) — narrow it with a sparse subpath`);
  }
  return (json.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path);
}

/** Map with bounded concurrency (no external dep) — caps simultaneous fetches. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Fallback resolver for a GitHub repo with NO registry.json — make it
 * installable anyway. Scans `**​/SKILL.md` into `registry:skill` items (the
 * agentskills.io standard that Anthropic Agent Skills, skills.sh, and Codex
 * skill dirs all use), then layers `registry:bundle`s from a Claude-Code /
 * Codex `marketplace.json` if present. Content is fetched from source at
 * install time, like any external item.
 */
async function scanGithubRepo(
  ref: GithubRegistryRef,
  opts: RegistryLoaderOptions,
): Promise<ResolvedRegistry | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const subdir = (ref.subdir ?? '').replace(/\/+$/, '');
  const prefix = subdir ? `${subdir}/` : '';
  const refsToTry = [...new Set([ref.ref, ...(opts.defaultRefs ?? ['main', 'master'])].filter(Boolean))] as string[];

  let paths: string[] | null = null;
  let goodRef = refsToTry[0];
  for (const candidate of refsToTry) {
    try {
      paths = await listGithubTree(ref.owner, ref.repo, candidate, fetchImpl);
      goodRef = candidate;
      break;
    } catch {
      // try the next ref
    }
  }
  if (!paths) return null;

  const readAt = (relPath: string) =>
    fetchText(rawGithubUrl(ref.owner, ref.repo, goodRef, posixJoin(subdir, relPath)), fetchImpl);

  // Skills — the SKILL.md standard. Bounded concurrency so an 800-skill repo
  // doesn't fire 800 simultaneous frontmatter fetches (rate-limit / socket burst).
  // 16 keeps a big source (e.g. hermes' 174 skills) snappy without tripping
  // GitHub's abuse detection when a token is configured.
  const skillItems: RegistryItem[] = await mapLimit(
    groupSkillFiles(paths, subdir),
    16,
    async (sk): Promise<RegistryItem> => {
      const name = (sk.name || ref.repo).toLowerCase();
      let meta: Record<string, string> = {};
      try {
        meta = parseFrontmatter(await readAt(sk.skillMd.slice(prefix.length)));
      } catch {
        // no/invalid frontmatter — fall back to a name-only item
      }
      return {
        name: meta.name && /^[a-z0-9][a-z0-9-_.]*$/i.test(meta.name) ? meta.name : name,
        type: 'registry:skill',
        title: meta.name || name,
        description: meta.description || undefined,
        files: sk.files.map((f) => ({
          path: f.path.slice(prefix.length),
          type: 'registry:file' as const,
          target: `@skills/${name}/${f.rel}`,
        })),
        meta: { source: `${ref.owner}/${ref.repo}`, primitive: 'skill', scanned: true },
      };
    },
  );

  // Bundles — from a Claude-Code / Codex marketplace.json, if present. Opt-in:
  // by default the marketplace is skills-only (plugin grouping breaks up oddly).
  const skillNames = new Set(skillItems.map((i) => i.name));
  const bundleItems = opts.includeBundles
    ? await marketplaceBundles(paths, prefix, readAt, skillNames)
    : [];

  const items = [...bundleItems, ...skillItems];
  if (items.length === 0) return null;
  items.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ref: { ...ref, ref: goodRef },
    registry: { name: `${ref.owner}/${ref.repo}`, items },
    readItemFile: (_itemName, filePath) => readAt(filePath),
  };
}

/**
 * Expand a Claude-Code / Codex `marketplace.json` (Codex reuses the Claude
 * format) into `registry:bundle`s — one per plugin, pulling the repo's scanned
 * skills it lists. We only bundle skills we actually resolved, so deps always
 * install. (Cross-repo plugin sources + commands/agents/MCP are not pulled yet.)
 */
async function marketplaceBundles(
  paths: string[],
  prefix: string,
  readAt: (relPath: string) => Promise<string>,
  skillNames: Set<string>,
): Promise<RegistryItem[]> {
  const candidate = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'].find((c) =>
    paths.includes(prefix + c),
  );
  if (!candidate) return [];
  let mp: { plugins?: Array<{ name?: string; description?: string; skills?: unknown[] }> };
  try {
    mp = JSON.parse(await readAt(candidate));
  } catch {
    return [];
  }

  const out: RegistryItem[] = [];
  for (const p of mp.plugins ?? []) {
    if (!p?.name) continue;
    const deps = [
      ...new Set(
        (Array.isArray(p.skills) ? p.skills : [])
          .map((s) => String(s).split('/').pop()?.toLowerCase() ?? '')
          .filter((n) => skillNames.has(n)),
      ),
    ];
    if (deps.length === 0) continue;
    out.push({
      name: String(p.name).toLowerCase(),
      type: 'registry:bundle',
      title: String(p.name),
      description: typeof p.description === 'string' ? p.description : undefined,
      registryDependencies: deps,
      meta: { source: 'marketplace.json', scanned: true },
    });
  }
  return out;
}

/** Load and flatten a registry (resolving `include`). */
export async function loadRegistry(
  refIn: RegistryRef,
  opts: RegistryLoaderOptions = {},
): Promise<ResolvedRegistry> {
  const { ref, read } = await makeRootReader(refIn, opts);
  let rootJson: RegistryJson;
  try {
    rootJson = JSON.parse(await read('registry.json')) as RegistryJson;
  } catch (err) {
    // No registry.json — fall back to scanning a GitHub repo for SKILL.md files
    // (Anthropic skills / skills.sh / Codex skill dirs — the SKILL.md standard).
    if (ref.kind === 'github') {
      const scanned = await scanGithubRepo(ref, opts).catch(() => null);
      if (scanned) return scanned;
    }
    throw new Error(`could not load registry "${describeRegistry(ref)}": ${(err as Error).message}`);
  }

  const items: RegistryItem[] = [];
  const itemBase = new Map<string, string>();
  await collectItems(read, rootJson, '', items, itemBase, new Set());

  const registry: RegistryJson = {
    name: rootJson.name,
    homepage: rootJson.homepage,
    items,
  };

  const readItemFile = (itemName: string, filePath: string) =>
    read(posixJoin(itemBase.get(itemName) ?? '', filePath));

  return { ref, registry, readItemFile };
}

/** Resolve a single item address to the item + a file reader. */
export async function loadItem(
  address: ItemAddress,
  opts: RegistryLoaderOptions = {},
): Promise<ResolvedItem> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // A direct item URL (https://host/r/pdf.json) — fetch the item JSON itself.
  if (address.directItemUrl) {
    const item = JSON.parse(await fetchText(address.directItemUrl, fetchImpl)) as RegistryItem;
    const base = posixDirname(address.directItemUrl);
    const readFile = bindFileReader(item, (p) => fetchText(`${base}/${p}`, fetchImpl));
    return { ref: { kind: 'url', url: address.directItemUrl }, item, readFile };
  }

  const ref = address.registry ?? opts.defaultRegistry;
  if (!ref) {
    throw new Error(
      `"${address.raw}" is a bare item name — pass a registry (e.g. owner/repo/${address.item}) or configure a default`,
    );
  }

  const resolved = await loadRegistry(ref, opts);
  const item = resolved.registry.items?.find((i) => i.name === address.item);
  if (!item) {
    const available = (resolved.registry.items ?? []).map((i) => i.name).slice(0, 12).join(', ');
    throw new Error(
      `item "${address.item}" not found in ${describeRegistry(resolved.ref)}${available ? ` (have: ${available}…)` : ''}`,
    );
  }
  const readFile = bindFileReader(item, (p) => resolved.readItemFile(item.name, p));
  return { ref: resolved.ref, item, readFile };
}

/** Returns a reader that prefers a file's inline `content` over fetching. */
function bindFileReader(
  item: RegistryItem,
  fetchByPath: (path: string) => Promise<string>,
): (filePath: string) => Promise<string> {
  const inline = new Map<string, string>();
  for (const f of item.files ?? []) {
    if (typeof f.content === 'string') inline.set(f.path, f.content);
  }
  return (filePath: string) => {
    const hit = inline.get(filePath);
    if (hit !== undefined) return Promise.resolve(hit);
    return fetchByPath(filePath);
  };
}

/** Convenience: parse a string and resolve it to an item in one call. */
export function loadItemAddress(raw: string, opts?: RegistryLoaderOptions): Promise<ResolvedItem> {
  return loadItem(parseItemAddress(raw), opts);
}
