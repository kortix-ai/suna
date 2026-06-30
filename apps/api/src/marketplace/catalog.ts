/**
 * The marketplace catalog — the "index" in the index-not-host model.
 *
 *   • Base (sync, offline): the bundled starter pack (skills, agents, tools,
 *     inline content) + curated `registry:bundle`s. Always available.
 *   • External (async, cached): registries configured via
 *     `KORTIX_MARKETPLACE_REGISTRIES` (GitHub repos / registry.json URLs / repos
 *     that just have SKILL.md files). Their items merge in; content is fetched
 *     from source at install time. Failures degrade to the base catalog.
 *
 * This module owns catalog *construction + read*. The install path (resolve a
 * catalog entry → plan → files to commit) lives in `install-service.ts`.
 */

import {
  getMarketplaceFiles,
  getStarterFiles,
  isKortixManagedSkillName,
} from "@kortix/starter";
import {
  buildRegistry,
  describeRegistry,
  loadItem,
  loadRegistry,
  parseRegistryAddress,
  rawGithubUrl,
  resolveOpencodeDir,
  type BuildSource,
  type RegistryItem,
  type RegistryJson,
  type RegistryRef,
} from "@kortix/registry";
import type { MarketplaceSource } from "./sources-store";

export interface ItemCapabilities {
  secrets: string[];
  connectors: string[];
  tools: string[];
  network: string[];
}

export interface CatalogItem {
  /** Stable, URL-safe-ish id: `${registry}:${name}`. */
  id: string;
  registry: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
  categories: string[];
  capabilities: ItemCapabilities;
  dependencies: string[];
  fileCount: number;
  external: boolean;
  sourceUrl?: string;
  /** Canonical marketplace identity (computed server-side — the web never re-derives it). */
  marketplaceId: string;
  marketplaceLabel: string;
  owner?: string;
  /** The user-added source row this came from (for exact Remove matching); absent for base/env. */
  sourceId?: string;
  /** First-party runtime skill managed by Kortix, not an ordinary optional install. */
  managedBy?: "kortix";
  updatePolicy?: "kortix-managed";
  defaultProjectInstall?: boolean;
  defaultProjectInstallOrder?: number;
  hidden?: boolean;
}

export interface DependencyItem {
  id: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
}

export interface CatalogItemDetail extends CatalogItem {
  files: Array<{ target: string; type: string }>;
  readme: string | null;
  dependencyItems: DependencyItem[];
}

/** A catalog item + its provenance + precomputed capabilities (no magic fields). */
export interface CatalogEntry {
  item: RegistryItem;
  registry: string;
  /** Set when the item comes from an external registry (fetched on install). */
  external?: RegistryRef;
  sourceUrl?: string;
  sourceId?: string;
  capabilities: ItemCapabilities;
}

interface Catalog {
  items: CatalogItem[];
  byId: Map<string, CatalogEntry>;
  /** name → entry (first writer wins) — O(1) dependency/name lookup. Built lazily. */
  byName?: Map<string, CatalogEntry>;
}

// ── capability hints ───────────────────────────────────────────────────────
const CAPABILITY_HINTS: Record<string, Partial<ItemCapabilities>> = {
  elevenlabs: {
    secrets: ["ELEVENLABS_API_KEY"],
    network: ["api.elevenlabs.io"],
  },
  replicate: {
    secrets: ["REPLICATE_API_TOKEN"],
    network: ["api.replicate.com"],
  },
  whisper: { secrets: ["GROQ_API_KEY"], network: ["api.groq.com"] },
  "deep-research": { tools: ["web_search"] },
  "research-assistant": { tools: ["web_search"] },
  "research-report": { tools: ["web_search"] },
  "account-research": { tools: ["web_search"] },
  "customer-research": { tools: ["web_search"] },
  "competitive-intelligence": { tools: ["web_search"] },
  "draft-outreach": { tools: ["web_search"] },
  "domain-research": { network: ["rdap.org", "whois"] },
  "agent-browser": { tools: ["agent-browser"] },
  media: { tools: ["media"] },
};

export function capabilitiesOf(item: RegistryItem): ItemCapabilities {
  const meta = (item.meta?.capabilities ?? {}) as Partial<ItemCapabilities>;
  const hint = CAPABILITY_HINTS[item.name] ?? {};
  const merge = (...lists: Array<string[] | undefined>) => [
    ...new Set(lists.flatMap((l) => l ?? [])),
  ];
  return {
    secrets: merge(Object.keys(item.envVars ?? {}), meta.secrets, hint.secrets),
    connectors: merge(meta.connectors, hint.connectors),
    tools: merge(meta.tools, hint.tools),
    network: merge(meta.network, hint.network),
  };
}

// ── shaping ────────────────────────────────────────────────────────────────
function makeEntry(
  item: RegistryItem,
  registry: string,
  external?: RegistryRef,
  sourceUrl?: string,
  sourceId?: string,
): CatalogEntry {
  return {
    item,
    registry,
    external,
    sourceUrl,
    sourceId,
    capabilities: capabilitiesOf(item),
  };
}

/** Known display labels for built-in + featured marketplaces (address → label). */
let marketplaceLabelsCache: Map<string, string> | null = null;

function marketplaceLabels(): Map<string, string> {
  if (marketplaceLabelsCache) return marketplaceLabelsCache;
  const labels = new Map<string, string>([
    ["kortix", "Kortix"],
    ["anthropics/skills", "Anthropic Skills"],
    ["anthropics/knowledge-work-plugins", "Anthropic Knowledge Work"],
  ]);
  for (const f of FEATURED_MARKETPLACES) labels.set(f.address, f.label);
  marketplaceLabelsCache = labels;
  return labels;
}

/** Display label for a registry/marketplace (base → "Kortix", external → curated name). */
export function marketplaceLabelOf(registry: string): string {
  const id = marketplaceIdOf(registry);
  return marketplaceLabels().get(id) ?? (id === "kortix" ? "Kortix" : id);
}

/** GitHub owner from a marketplace id, when it looks like `owner/repo` (for avatars). */
function ownerOf(marketplaceId: string): string | undefined {
  return marketplaceId !== "kortix" &&
    marketplaceId.includes("/") &&
    !marketplaceId.includes("://")
    ? marketplaceId.split("/")[0]
    : undefined;
}

function entryToCatalogItem(e: CatalogEntry): CatalogItem {
  const marketplaceId = marketplaceIdOf(e.registry);
  const defaultProjectInstallOrder =
    typeof e.item.meta?.defaultProjectInstallOrder === "number"
      ? e.item.meta.defaultProjectInstallOrder
      : undefined;
  return {
    id: `${e.registry}:${e.item.name}`,
    registry: e.registry,
    name: e.item.name,
    type: e.item.type,
    title: e.item.title ?? e.item.name,
    description: e.item.description ?? null,
    categories: e.item.categories ?? [],
    capabilities: e.capabilities,
    dependencies: e.item.registryDependencies ?? [],
    fileCount: e.item.files?.length ?? 0,
    external: !!e.external,
    sourceUrl: e.sourceUrl,
    marketplaceId,
    marketplaceLabel: marketplaceLabelOf(e.registry),
    owner: ownerOf(marketplaceId),
    sourceId: e.sourceId,
    managedBy: e.item.meta?.managedBy === "kortix" ? "kortix" : undefined,
    updatePolicy:
      e.item.meta?.updatePolicy === "kortix-managed"
        ? "kortix-managed"
        : undefined,
    defaultProjectInstall: e.item.meta?.defaultProjectInstall === true,
    defaultProjectInstallOrder,
    hidden: e.item.meta?.hidden === true,
  };
}

function bundlesFirst(a: CatalogItem, b: CatalogItem): number {
  if (a.type === "registry:bundle" && b.type !== "registry:bundle") return -1;
  if (b.type === "registry:bundle" && a.type !== "registry:bundle") return 1;
  return a.name.localeCompare(b.name);
}

function readmeOf(item: RegistryItem): string | null {
  const skill = item.files?.find((f) => /SKILL\.md$/.test(f.target ?? f.path));
  return typeof skill?.content === "string" ? skill.content : null;
}

// ── base catalog (sync, starter + curated bundles) ─────────────────────────
function memSource(map: Map<string, string>): BuildSource {
  const keys = [...map.keys()];
  return {
    listFiles: () => keys,
    readFile: (p) => {
      const c = map.get(p);
      if (c == null) throw new Error(`no such file ${p}`);
      return c;
    },
    isDirectory: (p) => {
      const clean = p.replace(/\/+$/, "");
      return keys.some((k) => k.startsWith(`${clean}/`)) && !map.has(p);
    },
  };
}

function buildStarterRegistry(): RegistryJson {
  const files = [
    ...getStarterFiles({
      projectName: "Kortix Starter",
      template: "general-knowledge-worker",
    }),
    ...getMarketplaceFiles(),
  ];
  const map = new Map(files.map((f) => [f.path, f.content] as const));
  const { registry } = buildRegistry({
    name: "kortix-starter",
    source: memSource(map),
  });
  for (const item of registry.items ?? []) {
    if (item.type === "registry:skill" && isKortixManagedSkillName(item.name)) {
      item.categories = [
        ...new Set([...(item.categories ?? []), "kortix-managed"]),
      ];
      item.meta = {
        ...(item.meta ?? {}),
        managedBy: "kortix",
        updatePolicy: "kortix-managed",
      };
    }
    for (const f of item.files ?? []) {
      const content = map.get(f.path);
      if (content != null) f.content = content;
    }
  }
  return registry;
}

const CURATED_BUNDLES: RegistryItem[] = [
  {
    name: "research-pack",
    type: "registry:bundle",
    title: "Research Pack",
    description:
      "Everything for evidence-based research: deep research, cited reports, and academic paper search.",
    categories: ["bundle", "research"],
    registryDependencies: [
      "deep-research",
      "research-report",
      "openalex-paper-search",
    ],
    meta: { source: "kortix" },
  },
  {
    name: "sales-pack",
    type: "registry:bundle",
    title: "Sales Pack",
    description:
      "Outbound-ready: account research, outreach drafting, call prep, and competitive analysis.",
    categories: ["bundle", "sales"],
    registryDependencies: [
      "account-research",
      "draft-outreach",
      "call-prep",
      "competitive-analysis",
    ],
    meta: { source: "kortix" },
  },
  {
    name: "documents-pack",
    type: "registry:bundle",
    title: "Documents Pack",
    description:
      "Read and write real office files: PDF, Word, Excel, and presentations.",
    categories: ["bundle", "documents"],
    registryDependencies: ["pdf", "docx", "xlsx", "presentations"],
    meta: { source: "kortix" },
  },
];

let BASE: Catalog | null = null;

function getBaseCatalog(): Catalog {
  if (BASE) return BASE;
  const registries: Array<{ name: string; items: RegistryItem[] }> = [
    { name: "kortix", items: CURATED_BUNDLES },
    { name: "kortix-starter", items: buildStarterRegistry().items ?? [] },
  ];
  const items: CatalogItem[] = [];
  const byId = new Map<string, CatalogEntry>();
  for (const reg of registries) {
    for (const item of reg.items) {
      const id = `${reg.name}:${item.name}`;
      if (byId.has(id)) continue;
      const entry = makeEntry(item, reg.name);
      byId.set(id, entry);
      items.push(entryToCatalogItem(entry));
    }
  }
  items.sort(bundlesFirst);
  BASE = { items, byId };
  return BASE;
}

// ── external catalog (async, cached, progressive) ──────────────────────────
const EXTERNAL_TTL_MS = 24 * 60 * 60 * 1000; // 24h — sources rarely change; refresh lazily

// The cache lives on globalThis so it survives `bun --hot` reloads in dev
// (otherwise every edit re-scans every source → the "so slow"). External sources
// resolve PROGRESSIVELY: the base (Kortix) shows instantly and each source is
// folded into `partial` as it arrives, so the list never blocks on the slowest.
/** Per-source resolution state — drives the UI's spinner-per-source. */
export interface SourceStatus {
  id: string;
  label: string;
  owner?: string;
  sourceUrl?: string;
  status: "pending" | "ready" | "error";
}
interface MarketplaceCache {
  external: Catalog | null; // last fully-resolved external catalog (the 24h cache)
  externalAt: number;
  partial: Catalog | null; // in-progress accumulator on a COLD build (grows per source)
  pending: number; // sources still resolving this round
  building: boolean;
  gen: number; // bumps on build start + each source completion (memo key)
  sourceStatus: SourceStatus[]; // per-source state for the current build round
  inflight: Promise<Catalog> | null;
  merged: Catalog | null; // memoized base+external merge
  mergedGen: number;
}
const CACHE: MarketplaceCache = ((
  globalThis as unknown as {
    __kortixMarketplaceCache2?: MarketplaceCache;
  }
).__kortixMarketplaceCache2 ??= {
  external: null,
  externalAt: 0,
  partial: null,
  pending: 0,
  building: false,
  gen: 0,
  sourceStatus: [],
  inflight: null,
  merged: null,
  mergedGen: -1,
});

// DB-persisted "Add marketplace" sources are injected at boot (see
// marketplace/index.ts), so this module stays import-pure for unit tests — no
// config/db pulled into its graph. Defaults to none until registered.
let loadDbSources: () => Promise<MarketplaceSource[]> = async () => [];

export function registerMarketplaceSourceProvider(
  fn: () => Promise<MarketplaceSource[]>,
): void {
  loadDbSources = fn;
}

/** Static registries from config (comma-separated addresses). */
function envSources(): string[] {
  return (process.env.KORTIX_MARKETPLACE_REGISTRIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Marketplaces that ship ENABLED by default — loaded like the Kortix base (not
 * removable), so the catalog is full on day one. Kept to a sane size + clean
 * licenses; the long tail lives in FEATURED_MARKETPLACES (one-click add). Can be
 * overridden by `KORTIX_DEFAULT_MARKETPLACES` (comma-separated).
 */
export const DEFAULT_MARKETPLACES: string[] = [
  "anthropics/skills", // official Anthropic Agent Skills (the anchor)
  "anthropics/knowledge-work-plugins", // official Anthropic knowledge-work skills
];

/** The defaults actually loaded — `KORTIX_DEFAULT_MARKETPLACES` overrides (set it
 *  to "" to disable, e.g. for hermetic tests). Read at call-time, not import. */
function activeDefaultMarketplaces(): string[] {
  const env = process.env.KORTIX_DEFAULT_MARKETPLACES;
  if (env === undefined) return DEFAULT_MARKETPLACES;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expand a stored "Add marketplace" source into one ref per sparse path. */
function refsFromSource(src: MarketplaceSource): RegistryRef[] {
  const base = parseRegistryAddress(src.address);
  const paths = src.sparsePaths?.length ? src.sparsePaths : [undefined];
  if (base.kind === "github") {
    return paths.map((p) => ({
      ...base,
      ref: src.gitRef || base.ref,
      subdir: p ?? base.subdir,
    }));
  }
  if (base.kind === "local") {
    return paths.map((p) => ({
      ...base,
      path: p ? `${base.path.replace(/\/+$/, "")}/${p}` : base.path,
    }));
  }
  return [base]; // url / namespace — git ref + sparse paths don't apply
}

/** A registry ref plus the user-added source it came from (for Remove + provenance). */
interface ExternalRef {
  ref: RegistryRef;
  sourceId?: string;
}

/** Env-configured + DB-persisted registries, as safety-filtered refs. */
async function externalRefs(): Promise<ExternalRef[]> {
  const out: ExternalRef[] = [];
  const seen = new Set<string>(); // dedup so a default + user-added dupe isn't scanned twice
  const push = (ref: RegistryRef, sourceId?: string) => {
    if (!isAllowedSourceRef(ref)) return;
    const key = describeRegistry(ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref, sourceId });
  };

  // Built-in defaults + env config (no sourceId → not removable).
  for (const addr of [...activeDefaultMarketplaces(), ...envSources()]) {
    try {
      push(parseRegistryAddress(addr));
    } catch {
      // skip an unparseable address
    }
  }
  // User-added sources (removable via their source id).
  for (const src of await loadDbSources().catch(
    () => [] as MarketplaceSource[],
  )) {
    try {
      for (const ref of refsFromSource(src)) push(ref, src.id);
    } catch {
      // skip an unparseable stored source
    }
  }
  return out;
}

// Authenticate GitHub API/raw calls when a token is configured — lifts the
// unauthenticated 60 req/hr scan ceiling to 5,000/hr so many marketplaces can be
// browsed + installed without rate-limiting. Kept out of @kortix/registry (which
// stays pure) — injected here as a fetch wrapper via the loader's fetchImpl.
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.MANAGED_GIT_GITHUB_TOKEN || "";
const GITHUB_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);
const githubFetch: typeof fetch = !GITHUB_TOKEN
  ? fetch
  : (((
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      // Exact hostname match — NOT substring — so the token is never sent to a
      // look-alike host like `api.github.com.evil.com` or `evil.com?x=api.github.com`.
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        // unparseable URL → no auth
      }
      if (GITHUB_HOSTS.has(host)) {
        const headers = new Headers(init?.headers);
        if (!headers.has("authorization"))
          headers.set("authorization", `Bearer ${GITHUB_TOKEN}`);
        return fetch(input, { ...init, headers });
      }
      return fetch(input, init);
    }) as typeof fetch);

/** Loader options that authenticate GitHub calls (shared by catalog + install). */
export const githubLoaderOptions: { fetchImpl: typeof fetch } = {
  fetchImpl: githubFetch,
};

// ── source safety (LFI / SSRF) ──────────────────────────────────────────────
// A source address is user-supplied + global, so in the hosted API it must not
// read the server's disk (`local`) or fetch internal URLs (`url` → cloud
// metadata, localhost, RFC-1918). `local` is dev-only behind an opt-in flag.
const ALLOW_LOCAL_SOURCES = process.env.KORTIX_MARKETPLACE_ALLOW_LOCAL === "1";

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h.startsWith("127.")
  )
    return true;
  if (h.startsWith("169.254.")) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
    return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  return false;
}

function isAllowedSourceRef(ref: RegistryRef): boolean {
  if (ref.kind === "github" || ref.kind === "namespace") return true;
  if (ref.kind === "local") return ALLOW_LOCAL_SOURCES;
  if (ref.kind === "url") {
    try {
      const u = new URL(ref.url);
      return u.protocol === "https:" && !isPrivateHost(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/** Throw with a clear reason if an address isn't a safe source to add (LFI/SSRF guard). */
export function assertAllowedSourceAddress(address: string): void {
  let ref: RegistryRef;
  try {
    ref = parseRegistryAddress(address);
  } catch (err) {
    throw new Error(`Unrecognized source address: ${(err as Error).message}`);
  }
  if (isAllowedSourceRef(ref)) return;
  if (ref.kind === "local")
    throw new Error("Local-folder sources are not allowed on this server.");
  if (ref.kind === "url")
    throw new Error("Only https registry URLs on public hosts are allowed.");
  throw new Error("This source type is not allowed.");
}

/** Start (or join) a build of the external catalog — resolves when every source
 *  is in. Sets `building`/`partial` SYNCHRONOUSLY so progressive readers see the
 *  loading state on the very first call. */
function startExternalBuild(): Promise<Catalog> {
  if (CACHE.external && Date.now() - CACHE.externalAt < EXTERNAL_TTL_MS)
    return Promise.resolve(CACHE.external);
  // Coalesce concurrent cold callers onto ONE build (no re-scan stampede).
  if (CACHE.inflight) return CACHE.inflight;
  // Cold (nothing cached yet) → fold each source into a live `partial` the list
  // can read as it grows. Refresh (stale cache) → build silently into a temp and
  // swap at the end, so the visible catalog stays put with no flicker.
  if (!CACHE.external) CACHE.partial = { items: [], byId: new Map() };
  CACHE.building = true;
  CACHE.gen++;
  CACHE.inflight = buildExternalCatalog().finally(() => {
    CACHE.inflight = null;
    CACHE.building = false;
    CACHE.gen++;
  });
  return CACHE.inflight;
}

type LoadedRegistry = Awaited<ReturnType<typeof loadRegistry>>;

async function buildExternalCatalog(): Promise<Catalog> {
  const refs = await externalRefs();
  CACHE.pending = refs.length;
  // Seed per-source status so the UI can show a spinner pill for each source
  // that's still resolving (and flip it to a count when it lands).
  CACHE.sourceStatus = refs.map(({ ref }) => {
    const id = describeRegistry(ref);
    return {
      id,
      label: marketplaceLabelOf(id),
      owner: ownerOf(id),
      sourceUrl:
        ref.kind === "github"
          ? `https://github.com/${ref.owner}/${ref.repo}`
          : undefined,
      status: "pending" as const,
    };
  });
  CACHE.gen++;
  const acc: Catalog = CACHE.external
    ? { items: [], byId: new Map() }
    : (CACHE.partial ??= { items: [], byId: new Map() });
  // Resolve sources concurrently with isolation — one slow/huge/dead source
  // neither blocks the others nor sinks the catalog; each folds in the instant
  // it arrives so the list streams Kortix-first, then source-by-source.
  await Promise.allSettled(
    refs.map(async ({ ref, sourceId }, i) => {
      try {
        addRegistryToCatalog(
          acc,
          await loadRegistry(ref, githubLoaderOptions),
          ref,
          sourceId,
        );
        if (CACHE.sourceStatus[i]) CACHE.sourceStatus[i].status = "ready";
      } catch (err) {
        console.warn(
          `[marketplace] skipping external registry: ${(err as Error)?.message}`,
        );
        if (CACHE.sourceStatus[i]) CACHE.sourceStatus[i].status = "error";
      } finally {
        CACHE.pending = Math.max(0, CACHE.pending - 1);
        CACHE.gen++; // a source landed → next read re-merges and streams it in
      }
    }),
  );
  CACHE.external = acc;
  CACHE.externalAt = Date.now();
  return acc;
}

/** Fold one resolved registry's items into an accumulator (de-duped by id). */
function addRegistryToCatalog(
  acc: Catalog,
  registry: LoadedRegistry,
  ref: RegistryRef,
  sourceId?: string,
): void {
  const registryName = registry.registry.name || describeRegistry(ref);
  const sourceUrl =
    ref.kind === "github"
      ? `https://github.com/${ref.owner}/${ref.repo}`
      : undefined;
  for (const item of registry.registry.items ?? []) {
    const id = `${registryName}:${item.name}`;
    if (acc.byId.has(id)) continue;
    const entry = makeEntry(item, registryName, ref, sourceUrl, sourceId);
    acc.byId.set(id, entry);
    acc.items.push(entryToCatalogItem(entry));
  }
}

/** Best external catalog right now: the fresh complete one, else the growing
 *  partial, else empty. */
function currentExternal(): Catalog {
  return CACHE.external ?? CACHE.partial ?? { items: [], byId: new Map() };
}

// Memoize the merged snapshot (clone + merge + sort is too costly per request),
// keyed on the build generation so it re-merges as sources stream in.
function progressiveMerge(): Catalog {
  if (CACHE.merged && CACHE.mergedGen === CACHE.gen) return CACHE.merged;
  const base = getBaseCatalog();
  const ext = currentExternal();
  const byId = new Map(base.byId);
  const byName = new Map<string, CatalogEntry>();
  const items = [...base.items];
  for (const e of base.byId.values())
    if (!byName.has(e.item.name)) byName.set(e.item.name, e);
  for (const it of ext.items) {
    if (byId.has(it.id)) continue;
    const e = ext.byId.get(it.id)!;
    byId.set(it.id, e);
    if (!byName.has(it.name)) byName.set(it.name, e);
    items.push(it);
  }
  items.sort(bundlesFirst);
  CACHE.merged = { items, byId, byName };
  CACHE.mergedGen = CACHE.gen;
  return CACHE.merged;
}

/** Non-blocking merged catalog — kicks the build and returns base + whatever
 *  sources are ready. Used by the list endpoints (progressive). */
async function mergedCatalog(): Promise<Catalog> {
  void startExternalBuild();
  return progressiveMerge();
}

/** Blocking merged catalog — waits for every source. Used where completeness
 *  matters (item detail / file lookup). */
async function mergedCatalogComplete(): Promise<Catalog> {
  await startExternalBuild();
  return progressiveMerge();
}

/** Whether the cold first-load is still streaming sources in (drives the UI's
 *  poll + per-source spinner). `sources` lists the still-pending sources only
 *  during a cold load — a background refresh stays silent. */
export function catalogStatus(): {
  loading: boolean;
  pending: number;
  sources: SourceStatus[];
} {
  const cold = CACHE.building && !CACHE.external;
  return {
    loading: cold,
    pending: CACHE.pending,
    sources: cold
      ? CACHE.sourceStatus.filter((s) => s.status === "pending")
      : [],
  };
}

/**
 * Group the base registries (kortix bundles + kortix-starter skills) under one
 * "Kortix" marketplace; every external registry is its own marketplace keyed by
 * its `owner/repo`. This is the id the "browse by marketplace" filter uses.
 */
export function marketplaceIdOf(registry: string): string {
  return registry === "kortix-starter" ? "kortix" : registry;
}

export interface MarketplaceFacet {
  id: string;
  label: string;
  owner?: string;
  count: number;
  /** Per-type item counts, e.g. { skill: 17, bundle: 3 }. */
  types: Record<string, number>;
  external: boolean;
  sourceUrl?: string;
  /** The user-added source row (for exact Remove); absent for base/env marketplaces. */
  sourceId?: string;
}

/** Distinct marketplaces in the merged catalog, with item + type counts (browse facets). */
export async function listMarketplaces(): Promise<MarketplaceFacet[]> {
  const { items } = await mergedCatalog();
  const by = new Map<string, MarketplaceFacet>();
  for (const it of items) {
    if (!isBrowseableCatalogItem(it)) continue;
    const id = it.marketplaceId;
    let m = by.get(id);
    if (!m) {
      m = {
        id,
        label: it.marketplaceLabel,
        owner: it.owner,
        count: 0,
        types: {},
        external: it.external,
        sourceUrl: it.sourceUrl,
        sourceId: it.sourceId,
      };
      by.set(id, m);
    }
    m.count += 1;
    const short = it.type.replace("registry:", "");
    m.types[short] = (m.types[short] ?? 0) + 1;
    if (!m.sourceUrl && it.sourceUrl) m.sourceUrl = it.sourceUrl;
    if (!m.sourceId && it.sourceId) m.sourceId = it.sourceId;
  }
  // Kortix first, then external alphabetically.
  return [...by.values()].sort((a, b) =>
    a.id === "kortix"
      ? -1
      : b.id === "kortix"
        ? 1
        : a.label.localeCompare(b.label),
  );
}

// ── featured marketplaces (the curated "discover" list) ─────────────────────
export interface FeaturedMarketplace {
  address: string;
  label: string;
  owner: string;
  description: string;
  license: string;
}

/**
 * Curated, git-hosted sources — the aggregator's front page. Every entry is a
 * real repo that resolves out of the box (SKILL.md and/or marketplace.json),
 * verified 2026-06-16. Adding more is just appending here.
 */
export const FEATURED_MARKETPLACES: FeaturedMarketplace[] = [
  // Official / first-party (off by default, one-click to enable)
  {
    address: "anthropics/knowledge-work-plugins",
    label: "Anthropic Knowledge Work",
    owner: "anthropics",
    description: "Official Anthropic — ~212 knowledge-work skills",
    license: "Apache-2.0",
  },
  {
    address: "openai/role-specific-plugins",
    label: "OpenAI Role Plugins",
    owner: "openai",
    description: "Official Codex role-specific plugins",
    license: "MIT",
  },
  {
    address: "wshobson/agents",
    label: "wshobson Agents",
    owner: "wshobson",
    description: "156 skills · 192 agents · 102 commands",
    license: "MIT",
  },
  // Big, permissive, reputable (verified counts, 2026-06-16)
  {
    address: "davila7/claude-code-templates",
    label: "aitmpl Templates",
    owner: "davila7",
    description: "871 skills · 449 agents · 388 commands",
    license: "MIT",
  },
  {
    address: "alirezarezvani/claude-skills",
    label: "Claude Skills",
    owner: "alirezarezvani",
    description: "767 skills + agents + commands",
    license: "MIT",
  },
  {
    address: "github/awesome-copilot",
    label: "Awesome Copilot",
    owner: "github",
    description: "GitHub/Microsoft official — 526 skills, 115 agents",
    license: "MIT",
  },
  {
    address: "microsoft/azure-skills",
    label: "Azure Skills",
    owner: "microsoft",
    description: "Microsoft official Azure skills (68)",
    license: "MIT",
  },
  {
    address: "mattpocock/skills",
    label: "Matt Pocock Skills",
    owner: "mattpocock",
    description: "TypeScript & web skills (skills.sh top author)",
    license: "MIT",
  },
  {
    address: "davepoon/buildwithclaude",
    label: "Build with Claude",
    owner: "davepoon",
    description: "334 skills · 363 agents · 414 commands",
    license: "MIT",
  },
  {
    address: "secondsky/claude-skills",
    label: "Claude Skills (secondsky)",
    owner: "secondsky",
    description: "212 skills · 53 agents · 65 commands",
    license: "MIT",
  },
  {
    address: "K-Dense-AI/scientific-agent-skills",
    label: "Scientific Agent Skills",
    owner: "K-Dense-AI",
    description: "147 science skills",
    license: "MIT",
  },
  {
    address: "anthropics/claude-plugins-official",
    label: "Anthropic Official Plugins",
    owner: "anthropics",
    description: "28 curated first-party plugins",
    license: "Apache-2.0",
  },
  {
    address: "obra/superpowers",
    label: "Superpowers",
    owner: "obra",
    description: "Brainstorming, debugging, TDD (Jesse Vincent)",
    license: "MIT",
  },
  {
    address: "garrytan/gstack",
    label: "gstack",
    owner: "garrytan",
    description: "Garry Tan's Claude Code setup — 62 skills",
    license: "MIT",
  },
  {
    address: "SuperClaude-Org/SuperClaude_Framework",
    label: "SuperClaude Framework",
    owner: "SuperClaude-Org",
    description: "35 personas, commands & skills + MCP",
    license: "MIT",
  },
  // Verticals
  {
    address: "kostja94/marketing-skills",
    label: "Marketing Skills",
    owner: "kostja94",
    description: "172 marketing skills — SEO, social, ads",
    license: "MIT",
  },
  {
    address: "AgricIDaniel/claude-seo",
    label: "Claude SEO",
    owner: "AgricIDaniel",
    description: "Technical SEO, schema, GEO/AEO",
    license: "MIT",
  },
  {
    address: "transilienceai/communitytools",
    label: "Security Community Tools",
    owner: "transilienceai",
    description: "Security, pentest & bug-bounty skills",
    license: "MIT",
  },
  {
    address: "cloudflare/skills",
    label: "Cloudflare Skills",
    owner: "cloudflare",
    description: "Workers & Agents SDK (official)",
    license: "Apache-2.0",
  },
  // Large / vendor — license caveats (all-rights-reserved; we fetch at install, never re-host)
  {
    address: "ComposioHQ/awesome-claude-skills",
    label: "Composio Awesome Skills",
    owner: "ComposioHQ",
    description: "864 community skills (Composio)",
    license: "",
  },
  {
    address: "openai/plugins",
    label: "OpenAI Codex Plugins",
    owner: "openai",
    description: "551 official Codex skills — per-plugin terms",
    license: "",
  },
  {
    address: "vercel-labs/agent-skills",
    label: "Vercel Agent Skills",
    owner: "vercel-labs",
    description: "React, web design & more",
    license: "",
  },
  // Official vendor sources (indexed by skills.sh — recognizable brands)
  {
    address: "google/skills",
    label: "Google Skills",
    owner: "google",
    description: "Agent skills for Google products",
    license: "Apache-2.0",
  },
  {
    address: "huggingface/skills",
    label: "Hugging Face Skills",
    owner: "huggingface",
    description: "The Hugging Face ecosystem for agents",
    license: "Apache-2.0",
  },
  {
    address: "stripe/ai",
    label: "Stripe AI",
    owner: "stripe",
    description: "Build AI products with Stripe",
    license: "MIT",
  },
  {
    address: "supabase/agent-skills",
    label: "Supabase Agent Skills",
    owner: "supabase",
    description: "Agent skills for Supabase",
    license: "MIT",
  },
  {
    address: "firebase/agent-skills",
    label: "Firebase Agent Skills",
    owner: "firebase",
    description: "Agent skills for Firebase",
    license: "Apache-2.0",
  },
  {
    address: "dotnet/skills",
    label: ".NET Skills",
    owner: "dotnet",
    description: "Skills for .NET & C# coding agents (105)",
    license: "MIT",
  },
  {
    address: "flutter/skills",
    label: "Flutter Skills",
    owner: "flutter",
    description: "Agent skills for Flutter",
    license: "BSD-3-Clause",
  },
  {
    address: "googleworkspace/cli",
    label: "Google Workspace CLI",
    owner: "googleworkspace",
    description: "Workspace CLI + 95 agent skills",
    license: "Apache-2.0",
  },
  {
    address: "forcedotcom/sf-skills",
    label: "Salesforce Skills",
    owner: "forcedotcom",
    description: "Agentforce / Salesforce skills (69)",
    license: "",
  },
  {
    address: "oracle/skills",
    label: "Oracle Skills",
    owner: "oracle",
    description: "Curated skills for Oracle tech",
    license: "UPL-1.0",
  },
  {
    address: "dbt-labs/dbt-agent-skills",
    label: "dbt Agent Skills",
    owner: "dbt-labs",
    description: "Agent skills for dbt workflows",
    license: "Apache-2.0",
  },
  {
    address: "duckdb/duckdb-skills",
    label: "DuckDB Skills",
    owner: "duckdb",
    description: "Agent skills for DuckDB",
    license: "MIT",
  },
  {
    address: "langchain-ai/langchain-skills",
    label: "LangChain Skills",
    owner: "langchain-ai",
    description: "Agent skills for LangChain",
    license: "",
  },
  {
    address: "trailofbits/skills",
    label: "Trail of Bits Skills",
    owner: "trailofbits",
    description: "Security research & audit skills (74)",
    license: "CC-BY-SA-4.0",
  },
  {
    address: "tavily-ai/skills",
    label: "Tavily Skills",
    owner: "tavily-ai",
    description: "Agent skills for Tavily search",
    license: "MIT",
  },
  {
    address: "brightdata/skills",
    label: "Bright Data Skills",
    owner: "brightdata",
    description: "Web-data & scraping skills",
    license: "MIT",
  },
  {
    address: "posit-dev/skills",
    label: "Posit Skills",
    owner: "posit-dev",
    description: "R & Python skills from Posit",
    license: "MIT",
  },
  {
    address: "callstackincubator/agent-skills",
    label: "React Native Skills",
    owner: "callstackincubator",
    description: "Agent-optimized React Native skills",
    license: "MIT",
  },
  {
    address: "vuejs-ai/skills",
    label: "Vue Skills",
    owner: "vuejs-ai",
    description: "Agent skills for Vue 3",
    license: "MIT",
  },
  {
    address: "analogjs/angular-skills",
    label: "Angular Skills",
    owner: "analogjs",
    description: "Agent skills for Angular (AnalogJS)",
    license: "MIT",
  },
  // Notable authors & big collections
  {
    address: "antfu/skills",
    label: "Anthony Fu's Skills",
    owner: "antfu",
    description: "Curated agent skills (Anthony Fu)",
    license: "MIT",
  },
  {
    address: "mitsuhiko/agent-stuff",
    label: "Agent Stuff",
    owner: "mitsuhiko",
    description: "Armin Ronacher's commands & skills",
    license: "Apache-2.0",
  },
  {
    address: "addyosmani/web-quality-skills",
    label: "Web Quality Skills",
    owner: "addyosmani",
    description: "Web performance & quality (Addy Osmani)",
    license: "MIT",
  },
  {
    address: "danielmiessler/Personal_AI_Infrastructure",
    label: "Personal AI Infrastructure",
    owner: "danielmiessler",
    description: "458 skills — agentic AI infra (PAI)",
    license: "MIT",
  },
  {
    address: "HKUDS/CLI-Anything",
    label: "CLI-Anything",
    owner: "HKUDS",
    description: "Make any software agent-native (150)",
    license: "Apache-2.0",
  },
  // More vendor/brand sources from skills.sh
  {
    address: "google/agents-cli",
    label: "Agents CLI",
    owner: "google",
    description: "CLI + skills for any coding agent (Google)",
    license: "Apache-2.0",
  },
  {
    address: "google-gemini/gemini-skills",
    label: "Gemini Skills",
    owner: "google-gemini",
    description: "Skills for the Gemini API & models",
    license: "Apache-2.0",
  },
  {
    address: "google-labs-code/stitch-skills",
    label: "Stitch Skills",
    owner: "google-labs-code",
    description: "Agent skills for Google Stitch",
    license: "Apache-2.0",
  },
  {
    address: "greensock/gsap-skills",
    label: "GSAP Skills",
    owner: "greensock",
    description: "Official AI skills for GSAP",
    license: "MIT",
  },
  {
    address: "larksuite/cli",
    label: "Lark / Feishu CLI",
    owner: "larksuite",
    description: "Official Lark/Feishu CLI + skills",
    license: "MIT",
  },
  {
    address: "heygen-com/hyperframes",
    label: "HyperFrames",
    owner: "heygen-com",
    description: "Write HTML, render video (HeyGen)",
    license: "Apache-2.0",
  },
  {
    address: "vercel-labs/json-render",
    label: "JSON Render",
    owner: "vercel-labs",
    description: "Generative UI framework (Vercel)",
    license: "Apache-2.0",
  },
  {
    address: "millionco/react-doctor",
    label: "React Doctor",
    owner: "millionco",
    description: "Catches your agent's bad React",
    license: "MIT",
  },
  {
    address: "firecrawl/cli",
    label: "Firecrawl CLI",
    owner: "firecrawl",
    description: "CLI + skill for Firecrawl scraping",
    license: "",
  },
  {
    address: "apify/agent-skills",
    label: "Apify Agent Skills",
    owner: "apify",
    description: "Web scraping & automation (Apify)",
    license: "",
  },
  {
    address: "better-auth/skills",
    label: "Better Auth Skills",
    owner: "better-auth",
    description: "Agent skills for Better Auth",
    license: "",
  },
  // Famous authors
  {
    address: "twostraws/SwiftUI-Agent-Skill",
    label: "SwiftUI Skill (Paul Hudson)",
    owner: "twostraws",
    description: "SwiftUI agent skill — Hacking with Swift",
    license: "MIT",
  },
  {
    address: "AvdLee/SwiftUI-Agent-Skill",
    label: "SwiftUI Best Practices",
    owner: "AvdLee",
    description: "Expert SwiftUI skill (Antoine van der Lee)",
    license: "MIT",
  },
  {
    address: "Dimillian/Skills",
    label: "Dimillian's Skills",
    owner: "Dimillian",
    description: "Codex skills (Thomas Ricouard)",
    license: "MIT",
  },
  {
    address: "Nutlope/hallmark",
    label: "Hallmark",
    owner: "Nutlope",
    description: "Anti-AI-slop design skill (Hassan)",
    license: "MIT",
  },
  {
    address: "ibelick/ui-skills",
    label: "UI Skills",
    owner: "ibelick",
    description: "Skills for design engineers (ibelick)",
    license: "MIT",
  },
  {
    address: "chrisbanes/skills",
    label: "Chris Banes' Skills",
    owner: "chrisbanes",
    description: "Kotlin, Compose & Android skills",
    license: "Apache-2.0",
  },
  {
    address: "hamelsmu/evals-skills",
    label: "Evals Skills",
    owner: "hamelsmu",
    description: "Skills for AI evals (Hamel Husain)",
    license: "MIT",
  },
  {
    address: "mrgoonie/claudekit-skills",
    label: "ClaudeKit Skills",
    owner: "mrgoonie",
    description: "All ClaudeKit.cc skills (45)",
    license: "",
  },
  {
    address: "JimLiu/baoyu-skills",
    label: "Baoyu Skills",
    owner: "JimLiu",
    description: "Baoyu's agent skills collection",
    license: "",
  },
  {
    address: "nuxt-content/docus",
    label: "Docus",
    owner: "nuxt-content",
    description: "Docs skills with Nuxt Content",
    license: "MIT",
  },
  // Big / hyped collections (high install counts on skills.sh)
  {
    address: "nexu-io/open-design",
    label: "Open Design",
    owner: "nexu-io",
    description: "513 skills — local-first design system",
    license: "Apache-2.0",
  },
  {
    address: "ruvnet/ruflo",
    label: "ruFlo",
    owner: "ruvnet",
    description: "Agent meta-harness + swarms (328)",
    license: "MIT",
  },
  {
    address: "parcadei/Continuous-Claude-v3",
    label: "Continuous Claude",
    owner: "parcadei",
    description: "160 skills — context management",
    license: "MIT",
  },
  {
    address: "Orchestra-Research/AI-Research-SKILLs",
    label: "AI Research Skills",
    owner: "Orchestra-Research",
    description: "AI research & engineering library (98)",
    license: "MIT",
  },
  {
    address: "tradermonty/claude-trading-skills",
    label: "Trading Skills",
    owner: "tradermonty",
    description: "76 skills for equity investors",
    license: "MIT",
  },
  {
    address: "browser-act/skills",
    label: "Browser-Act Skills",
    owner: "browser-act",
    description: "Browser automation for agents (71)",
    license: "MIT",
  },
  {
    address: "Jeffallan/claude-skills",
    label: "Full-Stack Skills",
    owner: "Jeffallan",
    description: "66 full-stack developer skills",
    license: "MIT",
  },
  {
    address: "coreyhaines31/marketingskills",
    label: "Marketing Skills (Corey Haines)",
    owner: "coreyhaines31",
    description: "44 marketing skills",
    license: "MIT",
  },
  {
    address: "EveryInc/compound-engineering-plugin",
    label: "Compound Engineering",
    owner: "EveryInc",
    description: "Compound engineering skills (Every)",
    license: "MIT",
  },
  {
    address: "Yeachan-Heo/oh-my-claudecode",
    label: "Oh My ClaudeCode",
    owner: "Yeachan-Heo",
    description: "Multi-agent orchestration (40)",
    license: "MIT",
  },
  {
    address: "kepano/obsidian-skills",
    label: "Obsidian Skills",
    owner: "kepano",
    description: "Agent skills for Obsidian (kepano)",
    license: "MIT",
  },
  {
    address: "pbakaus/impeccable",
    label: "Impeccable",
    owner: "pbakaus",
    description: "Design language for agent-built UIs",
    license: "Apache-2.0",
  },
  {
    address: "Leonxlnx/taste-skill",
    label: "Taste",
    owner: "Leonxlnx",
    description: "Gives your AI good design taste",
    license: "MIT",
  },
  {
    address: "nextlevelbuilder/ui-ux-pro-max-skill",
    label: "UI/UX Pro Max",
    owner: "nextlevelbuilder",
    description: "Design-intelligence skill",
    license: "MIT",
  },
  {
    address: "OthmanAdi/planning-with-files",
    label: "Planning With Files",
    owner: "OthmanAdi",
    description: "Persistent file-based planning",
    license: "MIT",
  },
];

/** Featured list annotated with whether each is already in the catalog. Deduped
 * by address so a stray duplicate in FEATURED_MARKETPLACES can never produce
 * repeated React keys / cards downstream. */
export async function listFeaturedMarketplaces(): Promise<
  Array<FeaturedMarketplace & { added: boolean }>
> {
  const present = new Set((await listMarketplaces()).map((m) => m.id));
  const seen = new Set<string>();
  return FEATURED_MARKETPLACES.filter((f) => {
    if (seen.has(f.address)) return false;
    seen.add(f.address);
    return true;
  }).map((f) => ({ ...f, added: present.has(f.address) }));
}

// ── public read API ────────────────────────────────────────────────────────
type ItemQuery = { query?: string; type?: string; source?: string };

// Launch scope: the marketplace is the skill library. Agents, commands, tools,
// bundles, and support files may still exist in registries for compatibility
// and dependency resolution, but they are not browse/install choices.
const MARKETPLACE_VISIBLE_TYPES = new Set<string>(["registry:skill"]);

function isBrowseableCatalogItem(it: CatalogItem): boolean {
  return MARKETPLACE_VISIBLE_TYPES.has(it.type) && !it.hidden;
}

function filterCatalogItems(
  items: CatalogItem[],
  opts: ItemQuery,
): CatalogItem[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const type = opts.type?.trim();
  const source = opts.source?.trim();
  return items.filter((it) => {
    if (!isBrowseableCatalogItem(it)) return false;
    if (
      type &&
      type !== "all" &&
      it.type !== type &&
      it.type !== `registry:${type}`
    )
      return false;
    if (source && source !== "all" && marketplaceIdOf(it.registry) !== source)
      return false;
    if (!q) return true;
    return `${it.name} ${it.title} ${it.description ?? ""} ${it.categories.join(" ")}`
      .toLowerCase()
      .includes(q);
  });
}

/** Complete catalog (waits for every source). Use where the full set must be
 *  present — programmatic consumers, tests. */
export async function listCatalogItems(
  opts: ItemQuery = {},
): Promise<CatalogItem[]> {
  return filterCatalogItems((await mergedCatalogComplete()).items, opts);
}

/** Progressive catalog — base (Kortix) instantly, external sources as they land.
 *  Use for the browse list so the UI never blocks on the slowest source. */
export async function listCatalogItemsLive(
  opts: ItemQuery = {},
): Promise<CatalogItem[]> {
  return filterCatalogItems((await mergedCatalog()).items, opts);
}

export async function getCatalogEntry(
  id: string,
): Promise<CatalogEntry | null> {
  const base = getBaseCatalog();
  const baseEntry = base.byId.get(id);
  if (baseEntry) return baseEntry;
  // Install path — wait for the full catalog so an entry is never missed.
  return (await mergedCatalogComplete()).byId.get(id) ?? null;
}

export async function findCatalogEntryByName(
  name: string,
): Promise<CatalogEntry | null> {
  const slug = name.split("/").pop() ?? name;
  for (const entry of getBaseCatalog().byId.values()) {
    if (entry.item.name === slug) return entry;
  }
  return (await mergedCatalogComplete()).byName?.get(slug) ?? null;
}

/**
 * Fetch just an external item's SKILL.md for the preview. Fast path: one direct
 * raw GitHub request (no full repo re-scan — a 174-skill source previewed one
 * item in ~175 requests before). Falls back to a re-resolve for url/local or
 * registry.json repos.
 */
async function readExternalReadme(entry: CatalogEntry): Promise<string | null> {
  const ext = entry.external!;
  const skill = (entry.item.files ?? []).find((f) =>
    /SKILL\.md$/i.test(f.path ?? f.target ?? ""),
  );
  if (ext.kind === "github" && skill?.path) {
    const full = ext.subdir
      ? `${ext.subdir.replace(/\/+$/, "")}/${skill.path}`
      : skill.path;
    for (const ref of [ext.ref, "main", "master"].filter(Boolean) as string[]) {
      try {
        const res = await githubFetch(
          rawGithubUrl(ext.owner, ext.repo, ref, full),
        );
        if (res.ok) return await res.text();
      } catch {
        // try the next ref
      }
    }
  }
  try {
    const loaded = await loadItem(
      {
        registry: ext,
        item: entry.item.name,
        raw: `${entry.registry}:${entry.item.name}`,
      },
      githubLoaderOptions,
    );
    const sk = (loaded.item.files ?? []).find((f) =>
      /SKILL\.md$/i.test(f.target ?? f.path),
    );
    return sk ? await loaded.readFile(sk.path).catch(() => null) : null;
  } catch {
    return null;
  }
}

export async function getCatalogItemDetail(
  id: string,
): Promise<CatalogItemDetail | null> {
  const { byId, items } = await mergedCatalog();
  const entry = byId.get(id);
  if (!entry) return null;
  const base = items.find((i) => i.id === id)!;
  if (!isBrowseableCatalogItem(base)) return null;

  // Files come straight from the cached catalog entry — no re-fetch, so the full
  // file tree previews instantly even for a 174-skill source.
  const files = (entry.item.files ?? []).map((f) => ({
    target: f.target ?? f.path,
    type: f.type,
  }));
  let readme: string | null = readmeOf(entry.item);
  if (!readme && entry.external)
    readme = await readExternalReadme(entry).catch(() => null);

  const dependencyItems: DependencyItem[] = (base.dependencies ?? []).map(
    (name) => {
      const found = items.find((i) => i.name === name);
      return found
        ? {
            id: found.id,
            name: found.name,
            type: found.type,
            title: found.title,
            description: found.description,
          }
        : {
            id: name,
            name,
            type: "registry:skill",
            title: name,
            description: null,
          };
    },
  );

  return { ...base, files, readme, dependencyItems };
}

/** Fetch one file's raw content for the detail viewer, addressed by its install
 *  `target`. Base/bundle items carry inline content; external GitHub items are
 *  fetched raw by their source path (same fast path as the readme — one request,
 *  no full re-scan). Returns null when the item/file is unknown or unavailable. */
export async function getCatalogItemFile(
  id: string,
  target: string,
): Promise<{ target: string; content: string } | null> {
  const { byId } = await mergedCatalog();
  const entry = byId.get(id);
  if (!entry) return null;
  const file = (entry.item.files ?? []).find(
    (f) => (f.target ?? f.path) === target,
  );
  if (!file) return null;
  if (typeof file.content === "string")
    return { target, content: file.content };
  const sourcePath = file.path ?? file.target;
  if (!sourcePath) return null;
  const content = await readExternalFile(entry, sourcePath).catch(() => null);
  return content != null ? { target, content } : null;
}

/** Raw-fetch any file of an external entry by its source path (generalizes
 *  {@link readExternalReadme}). */
async function readExternalFile(
  entry: CatalogEntry,
  sourcePath: string,
): Promise<string | null> {
  const ext = entry.external;
  if (ext?.kind === "github") {
    const full = ext.subdir
      ? `${ext.subdir.replace(/\/+$/, "")}/${sourcePath}`
      : sourcePath;
    for (const ref of [ext.ref, "main", "master"].filter(Boolean) as string[]) {
      try {
        const res = await githubFetch(
          rawGithubUrl(ext.owner, ext.repo, ref, full),
        );
        if (res.ok) return await res.text();
      } catch {
        // try the next ref
      }
    }
  }
  if (!ext) return null;
  try {
    const loaded = await loadItem(
      {
        registry: ext,
        item: entry.item.name,
        raw: `${entry.registry}:${entry.item.name}`,
      },
      githubLoaderOptions,
    );
    return await loaded.readFile(sourcePath).catch(() => null);
  } catch {
    return null;
  }
}

/** Test seam: drop cached external results so a test can re-stub fetch. */
export function _resetExternalCache(): void {
  CACHE.external = null;
  CACHE.externalAt = 0;
  CACHE.partial = null;
  CACHE.pending = 0;
  CACHE.building = false;
  CACHE.gen++;
  CACHE.sourceStatus = [];
  CACHE.inflight = null;
  CACHE.merged = null;
  CACHE.mergedGen = -1;
}

/** Warm the catalog in the background (boot / after a source change) so the
 *  first marketplace open doesn't pay for the cold GitHub scan. No-op when the
 *  cache is already fresh. Fire-and-forget — never throws. */
export function warmMarketplaceCatalog(): void {
  void startExternalBuild().catch(() => undefined);
}

export { resolveOpencodeDir };
