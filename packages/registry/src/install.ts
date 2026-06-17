/**
 * Plan and apply an install: resolve every file's target, fetch its content,
 * pull `registryDependencies` transitively, and write into a project — while
 * recording everything in registry-lock.json.
 *
 * `planInstall` is pure (no disk writes) so callers can preview (`--dry-run`),
 * and so the API/web can reuse it to produce a set of files to **commit** into
 * a project repo instead of writing to a working tree.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describeRegistry, type RegistryRef } from './address';
import type { ResolvedItem } from './fetch';
import { buildTarget, expandTarget, type TargetContext } from './paths';
import { hashContent, readLock, upsertLockEntry, writeLock } from './lock';
import type {
  RegistryItem,
  RegistryItemType,
  RegistryLock,
  RegistryLockEntry,
  RegistryLockSourceType,
} from './schema';

export interface PlannedWrite {
  /** Repo-relative POSIX path in the consuming project. */
  target: string;
  content: string;
  hash: string;
  /** Whether something already exists at `target`. */
  exists: boolean;
  /** The item this write belongs to. */
  itemName: string;
}

export interface PlannedUnit {
  name: string;
  type: RegistryItemType;
  sourceLabel: string;
  sourceType: RegistryLockSourceType;
  writes: PlannedWrite[];
}

export interface InstallPlan {
  units: PlannedUnit[];
  writes: PlannedWrite[];
  envVars: Record<string, string>;
  docs: string[];
  /** Dependency addresses that were pulled in. */
  dependencies: string[];
  warnings: string[];
}

export interface PlanContext extends TargetContext {
  /** Returns true if a repo-relative target already exists in the project. */
  exists: (target: string) => boolean;
  /** Resolve a `registryDependencies` address. Omit to skip dependency pulls. */
  resolveDependency?: (rawAddress: string, parent: RegistryRef) => Promise<ResolvedItem>;
}

function refSourceType(ref: RegistryRef): RegistryLockSourceType {
  switch (ref.kind) {
    case 'github':
      return 'github';
    case 'url':
      return 'url';
    case 'local':
      return 'local';
    default:
      return 'registry';
  }
}

function defaultTarget(item: RegistryItem, filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  switch (item.type) {
    case 'registry:skill':
      return buildTarget.skill(item.name, base);
    case 'registry:agent':
      return buildTarget.agent(base);
    case 'registry:command':
      return buildTarget.command(base);
    case 'registry:tool':
      return buildTarget.tool(base);
    case 'registry:memory':
      return buildTarget.memory(base);
    default:
      return `~/${filePath}`;
  }
}

export async function planInstall(root: ResolvedItem, ctx: PlanContext): Promise<InstallPlan> {
  const plan: InstallPlan = {
    units: [],
    writes: [],
    envVars: {},
    docs: [],
    dependencies: [],
    warnings: [],
  };
  const seen = new Set<string>();

  const visit = async (resolved: ResolvedItem): Promise<void> => {
    const id = `${describeRegistry(resolved.ref)}#${resolved.item.name}`;
    if (seen.has(id)) return;
    seen.add(id);

    // Depth-first: install dependencies before the item that needs them.
    for (const dep of resolved.item.registryDependencies ?? []) {
      if (!ctx.resolveDependency) {
        plan.warnings.push(`unresolved dependency "${dep}" (no resolver configured)`);
        continue;
      }
      try {
        const depItem = await ctx.resolveDependency(dep, resolved.ref);
        plan.dependencies.push(dep);
        await visit(depItem);
      } catch (err) {
        plan.warnings.push(`failed to resolve dependency "${dep}": ${(err as Error).message}`);
      }
    }

    const writes: PlannedWrite[] = [];
    for (const file of resolved.item.files ?? []) {
      const targetRaw = file.target ?? defaultTarget(resolved.item, file.path);
      const target = expandTarget(targetRaw, ctx);
      let content: string;
      try {
        content = await resolved.readFile(file.path);
      } catch (err) {
        plan.warnings.push(`could not read "${file.path}" for "${resolved.item.name}": ${(err as Error).message}`);
        continue;
      }
      const write: PlannedWrite = {
        target,
        content,
        hash: hashContent(content),
        exists: ctx.exists(target),
        itemName: resolved.item.name,
      };
      writes.push(write);
      plan.writes.push(write);
    }

    for (const [k, v] of Object.entries(resolved.item.envVars ?? {})) plan.envVars[k] = v;
    if (resolved.item.docs) plan.docs.push(resolved.item.docs);

    plan.units.push({
      name: resolved.item.name,
      type: resolved.item.type,
      sourceLabel: describeRegistry(resolved.ref),
      sourceType: refSourceType(resolved.ref),
      writes,
    });
  };

  await visit(root);
  return plan;
}

export interface ApplyContext {
  root: string;
  overwrite?: boolean;
  /** ISO timestamp recorded in the lock (the engine never reads the clock). */
  now?: string;
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
}

export function applyInstall(plan: InstallPlan, ctx: ApplyContext): ApplyResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const write of plan.writes) {
    const abs = join(ctx.root, write.target);
    if (write.exists && !ctx.overwrite) {
      skipped.push(write.target);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, write.content, 'utf8');
    written.push(write.target);
  }

  const lock = readLock(ctx.root);
  const wrote = new Set(written);
  for (const unit of plan.units) {
    // Record only the files actually written — the lock must describe what's on
    // disk, not what was planned (a skipped pre-existing file keeps its old bytes,
    // so storing its planned hash would make drift-detection lie "up-to-date").
    const recordedFiles = unit.writes.filter((w) => wrote.has(w.target));
    if (recordedFiles.length === 0 && unit.writes.length > 0 && !ctx.overwrite) continue;
    upsertLockEntry(lock, unit.name, lockEntryFromUnit({ ...unit, writes: recordedFiles }, ctx.now));
  }
  writeLock(ctx.root, lock);

  return { written, skipped };
}

/**
 * Record a plan's units into a lock (pure — no disk). Used by the server-side
 * install path, which writes the lock into a git commit rather than to disk.
 * Unlike `applyInstall`, this records every unit (the server writes all files).
 */
export function recordPlanInLock(lock: RegistryLock, plan: InstallPlan, now?: string): RegistryLock {
  for (const unit of plan.units) lock.items[unit.name] = lockEntryFromUnit(unit, now);
  return lock;
}

/** The one place a lock entry is built from a planned unit. */
function lockEntryFromUnit(unit: PlannedUnit, now?: string): RegistryLockEntry {
  return {
    type: unit.type,
    source: unit.sourceLabel,
    sourceType: unit.sourceType,
    files: unit.writes.map((w) => ({ target: w.target, hash: w.hash })),
    installedAt: now,
  };
}

/** node:fs-backed existence check for a PlanContext. */
export function nodeFsExists(root: string): (target: string) => boolean {
  return (target: string) => existsSync(join(root, target));
}

/** Read a target's current content (for drift checks); null if absent. */
export function readTarget(root: string, target: string): string | null {
  try {
    return readFileSync(join(root, target), 'utf8');
  } catch {
    return null;
  }
}
