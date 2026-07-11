/**
 * Install service — resolve a catalog entry (inline for the starter pack,
 * fetched-from-source for external registries), plan its install with
 * transitive bundle deps, and produce the exact files to commit (item files +
 * updated registry-lock.json). Pure: no git, no disk; the caller commits.
 */

import {
  type BlueprintProposedTrigger,
  type InstallPlan,
  type InstalledFile,
  REGISTRY_LOCK_FILENAME,
  type ResolvedItem,
  loadItem,
  parseLockContent,
  planInstall,
  recordPlanInLock,
  serializeLock,
} from '@kortix/registry';
import {
  type GitTriggerSpec,
  extractTriggers,
  parseManifestString,
  serializeManifest,
  triggerSpecToTomlEntry,
} from '../projects/triggers';
import {
  type CatalogEntry,
  type ItemCapabilities,
  findCatalogEntryByName,
  getCatalogEntry,
  githubLoaderOptions,
} from './catalog';

/** Inline-content ResolvedItem for a base (starter/bundle) entry. */
function inlineResolvedItem(entry: CatalogEntry): ResolvedItem {
  const map = new Map<string, string>();
  for (const f of entry.item.files ?? [])
    if (typeof f.content === 'string') map.set(f.path, f.content);
  return {
    ref: { kind: 'local', path: entry.registry },
    item: entry.item,
    readFile: async (p) => {
      const c = map.get(p);
      if (c == null) throw new Error(`no inline content for ${p}`);
      return c;
    },
  };
}

/** Resolve an entry to a ResolvedItem — inline for base, fetched for external. */
function resolveEntry(entry: CatalogEntry, raw: string): Promise<ResolvedItem> {
  if (entry.external)
    return loadItem({ registry: entry.external, item: entry.item.name, raw }, githubLoaderOptions);
  return Promise.resolve(inlineResolvedItem(entry));
}

function unionCapabilities(into: ItemCapabilities, from: ItemCapabilities): void {
  into.secrets.push(...from.secrets);
  into.connectors.push(...from.connectors);
  into.tools.push(...from.tools);
  into.network.push(...from.network);
}

export interface InstallBuildInput {
  id: string;
  configDir: string;
  existingLockRaw: string | null;
  legacyLockRaw: string | null;
  now: string;
  /**
   * The project's current kortix.yaml/kortix.toml text. Only used when a
   * blueprint is installed — its proposed trigger is appended (disabled) to
   * this manifest. Omit (or null) and a blueprint installs its skill(s) only.
   */
  existingManifestRaw?: string | null;
  /** Manifest path (e.g. "kortix.yaml") — decides the serialization format. */
  manifestPath?: string;
  /** Slot values substituted into a blueprint's proposed-trigger prompt. */
  slotValues?: Record<string, string>;
}

export interface ProposedTriggerInfo {
  slug: string;
  manifestPath: string;
}

export interface InstallBuildResult {
  files: Array<{ path: string; content: string }>;
  plan: InstallPlan;
  installed: Array<{ name: string; type: string }>;
  capabilities: ItemCapabilities;
  /** Set when a blueprint appended a disabled trigger to the manifest. */
  proposedTrigger?: ProposedTriggerInfo;
}

/** First unused slug, appending -2, -3, … — never overwrites an existing trigger. */
function uniqueTriggerSlug(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * A blueprint's proposed trigger → a GitTriggerSpec with slots substituted and
 * `enabled` FORCED false. This is the safety guarantee: a blueprint's trigger
 * can never install as live, no matter what the blueprint declares.
 */
function blueprintTriggerToSpec(
  pt: BlueprintProposedTrigger,
  slug: string,
  manifestPath: string,
  slotValues: Record<string, string>,
): GitTriggerSpec {
  const prompt = pt.promptTemplate.replace(
    /\{\{\s*slots\.([a-zA-Z0-9_-]+)\s*\}\}/g,
    (_m, key: string) => slotValues[key] ?? '',
  );
  return {
    slug,
    path: `${manifestPath}#triggers.${slug}`,
    name: pt.name,
    type: pt.type,
    agent: pt.agent ?? 'default',
    model: null,
    enabled: false, // never auto-runs, regardless of blueprint content
    promptTemplate: prompt,
    cron: pt.type === 'cron' && !pt.runAt ? (pt.cron ?? null) : null,
    runAt: pt.type === 'cron' ? (pt.runAt ?? null) : null,
    timezone: pt.timezone ?? 'UTC',
    secretEnv: pt.type === 'webhook' ? (pt.secretEnv ?? null) : null,
    sessionMode: 'fresh',
  };
}

export interface InstallBatchBuildInput extends Omit<InstallBuildInput, 'id'> {
  ids: string[];
}

export interface InstallBatchBuildResult {
  files: Array<{ path: string; content: string }>;
  installed: Array<{ name: string; type: string }>;
  capabilities: ItemCapabilities;
}

export async function buildInstall(input: InstallBuildInput): Promise<InstallBuildResult> {
  const entry = (await getCatalogEntry(input.id)) ?? (await findCatalogEntryByName(input.id));
  if (!entry) throw new Error(`unknown item "${input.id}"`);

  const root = await resolveEntry(entry, input.id);
  const plan = await planInstall(root, {
    configDir: input.configDir,
    exists: () => false,
    resolveDependency: async (address) => {
      const dep = await findCatalogEntryByName(address);
      if (!dep) throw new Error(`dependency "${address}" not found in catalog`);
      return resolveEntry(dep, address);
    },
  });

  const lock = parseLockContent(input.existingLockRaw, input.legacyLockRaw);
  recordPlanInLock(lock, plan, input.now);

  const files = plan.writes.map((w) => ({ path: w.target, content: w.content }));
  files.push({ path: REGISTRY_LOCK_FILENAME, content: serializeLock(lock) });

  const caps: ItemCapabilities = { secrets: [], connectors: [], tools: [], network: [] };
  let proposedTrigger: ProposedTriggerInfo | undefined;
  for (const unit of plan.units) {
    const e = await findCatalogEntryByName(unit.name);
    if (!e) continue;
    unionCapabilities(caps, e.capabilities);

    // A blueprint appends its proposed trigger (DISABLED) to the project's
    // manifest. Append-only + forced enabled:false: it never overwrites an
    // existing trigger and can never install as a live automation.
    const pt = e.item.type === 'registry:blueprint' ? e.item.proposedTrigger : undefined;
    if (pt && !proposedTrigger && input.existingManifestRaw) {
      const manifestPath = input.manifestPath || 'kortix.yaml';
      const format = manifestPath.endsWith('.toml') ? 'toml' : 'yaml';
      const manifest = parseManifestString(input.existingManifestRaw, format, manifestPath);
      const { specs } = extractTriggers(manifest);
      const slug = uniqueTriggerSlug(
        pt.slug,
        specs.map((s) => s.slug),
      );
      const spec = blueprintTriggerToSpec(pt, slug, manifestPath, input.slotValues ?? {});
      const nextTriggers = [
        ...specs.map((s) => triggerSpecToTomlEntry(s)),
        triggerSpecToTomlEntry(spec),
      ];
      const nextManifest = serializeManifest({
        ...manifest,
        raw: { ...manifest.raw, triggers: nextTriggers },
      });
      files.push({ path: manifestPath, content: nextManifest });
      proposedTrigger = { slug, manifestPath };
    }
  }

  return {
    files,
    plan,
    installed: plan.units.map((u) => ({ name: u.name, type: u.type })),
    capabilities: {
      secrets: [...new Set(caps.secrets)],
      connectors: [...new Set(caps.connectors)],
      tools: [...new Set(caps.tools)],
      network: [...new Set(caps.network)],
    },
    proposedTrigger,
  };
}

export async function buildInstallBatch(
  input: InstallBatchBuildInput,
): Promise<InstallBatchBuildResult> {
  const files = new Map<string, string>();
  const installed = new Map<string, { name: string; type: string }>();
  const caps: ItemCapabilities = { secrets: [], connectors: [], tools: [], network: [] };
  let lockRaw = input.existingLockRaw;

  for (const id of input.ids) {
    const built = await buildInstall({
      id,
      configDir: input.configDir,
      existingLockRaw: lockRaw,
      legacyLockRaw: input.legacyLockRaw,
      now: input.now,
    });
    for (const file of built.files) {
      files.set(file.path, file.content);
      if (file.path === REGISTRY_LOCK_FILENAME) lockRaw = file.content;
    }
    for (const item of built.installed) installed.set(item.name, item);
    unionCapabilities(caps, built.capabilities);
  }

  return {
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    installed: [...installed.values()],
    capabilities: {
      secrets: [...new Set(caps.secrets)],
      connectors: [...new Set(caps.connectors)],
      tools: [...new Set(caps.tools)],
      network: [...new Set(caps.network)],
    },
  };
}

/**
 * Resolve an installed item's OWN fresh files (no dependency expansion) from
 * its current source, with content hashes — for update detection against the
 * lock. Returns null when the item no longer resolves in the catalog (orphaned).
 * `configDir` must match the project's so targets line up with the lock.
 */
export async function resolveItemFiles(
  name: string,
  configDir: string,
): Promise<InstalledFile[] | null> {
  const entry = await findCatalogEntryByName(name);
  if (!entry) return null;
  const root = await resolveEntry(entry, entry.item.name);
  // No resolveDependency → plan only this item's files, not its bundle members
  // (each member is tracked + update-checked as its own lock entry).
  const plan = await planInstall(root, { configDir, exists: () => false });
  return plan.writes.map((w) => ({ target: w.target, hash: w.hash }));
}

/** The catalog id for an installed item name, or null if it's not in the catalog. */
export async function catalogIdForName(name: string): Promise<string | null> {
  const entry = await findCatalogEntryByName(name);
  return entry ? `${entry.registry}:${entry.item.name}` : null;
}
