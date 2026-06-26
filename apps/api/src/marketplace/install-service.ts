/**
 * Install service — resolve a catalog entry (inline for the starter pack,
 * fetched-from-source for external registries), plan its install with
 * transitive bundle deps, and produce the exact files to commit (item files +
 * updated registry-lock.json). Pure: no git, no disk; the caller commits.
 */

import {
  loadItem,
  parseLockContent,
  planInstall,
  recordPlanInLock,
  serializeLock,
  REGISTRY_LOCK_FILENAME,
  type InstallPlan,
  type InstalledFile,
  type ResolvedItem,
} from '@kortix/registry';
import {
  findCatalogEntryByName,
  getCatalogEntry,
  githubLoaderOptions,
  type CatalogEntry,
  type ItemCapabilities,
} from './catalog';

/** Inline-content ResolvedItem for a base (starter/bundle) entry. */
function inlineResolvedItem(entry: CatalogEntry): ResolvedItem {
  const map = new Map<string, string>();
  for (const f of entry.item.files ?? []) if (typeof f.content === 'string') map.set(f.path, f.content);
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
  if (entry.external) return loadItem({ registry: entry.external, item: entry.item.name, raw }, githubLoaderOptions);
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
}

export interface InstallBuildResult {
  files: Array<{ path: string; content: string }>;
  plan: InstallPlan;
  installed: Array<{ name: string; type: string }>;
  capabilities: ItemCapabilities;
}

export async function buildInstall(input: InstallBuildInput): Promise<InstallBuildResult> {
  const entry = await getCatalogEntry(input.id);
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
  for (const unit of plan.units) {
    const e = await findCatalogEntryByName(unit.name);
    if (e) unionCapabilities(caps, e.capabilities);
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
  };
}

/**
 * Resolve an installed item's OWN fresh files (no dependency expansion) from
 * its current source, with content hashes — for update detection against the
 * lock. Returns null when the item no longer resolves in the catalog (orphaned).
 * `configDir` must match the project's so targets line up with the lock.
 */
export async function resolveItemFiles(name: string, configDir: string): Promise<InstalledFile[] | null> {
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
