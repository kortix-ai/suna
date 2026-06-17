/**
 * registry-lock.json — what's installed in a project, with content hashes for
 * drift detection. Generalizes the old `skills-lock.json` (which only tracked
 * skills from kortix-ai/skills); that legacy file is still read and migrated.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_SKILLS_LOCK_FILENAME,
  REGISTRY_LOCK_FILENAME,
  type RegistryLock,
  type RegistryLockEntry,
} from './schema';

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function emptyLock(): RegistryLock {
  return { version: 2, items: {} };
}

export interface LockIo {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, content: string) => void;
}

const nodeIo: LockIo = {
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, c) => writeFileSync(p, c, 'utf8'),
};

interface LegacySkillsLock {
  version: number;
  skills?: Record<string, { source?: string; sourceType?: string; skillPath?: string; computedHash?: string }>;
}

/**
 * Parse lock content from raw strings (no disk) — the server path reads these
 * from a git tree. Prefers a v2 registry-lock.json; falls back to migrating a
 * legacy skills-lock.json; otherwise an empty lock.
 */
export function parseLockContent(
  registryLockRaw: string | null,
  legacyRaw: string | null = null,
): RegistryLock {
  if (registryLockRaw) {
    try {
      const parsed = JSON.parse(registryLockRaw) as RegistryLock;
      if (parsed && parsed.version === 2 && parsed.items) return parsed;
    } catch {
      // fall through
    }
  }
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as LegacySkillsLock;
      const lock = emptyLock();
      for (const [name, entry] of Object.entries(legacy.skills ?? {})) {
        lock.items[name] = {
          type: 'registry:skill',
          source: entry.source ?? 'kortix-ai/skills',
          sourceType: 'github',
          files: entry.computedHash
            ? [{ target: entry.skillPath ?? `.kortix/opencode/skills/${name}/SKILL.md`, hash: entry.computedHash }]
            : [],
        };
      }
      return lock;
    } catch {
      // ignore a malformed legacy file
    }
  }
  return emptyLock();
}

/** Serialize a lock to its canonical on-disk JSON (trailing newline). */
export function serializeLock(lock: RegistryLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/** Read registry-lock.json, migrating a legacy skills-lock.json if present. */
export function readLock(root: string, io: LockIo = nodeIo): RegistryLock {
  const lockPath = join(root, REGISTRY_LOCK_FILENAME);
  const legacyPath = join(root, LEGACY_SKILLS_LOCK_FILENAME);
  return parseLockContent(
    io.exists(lockPath) ? io.read(lockPath) : null,
    io.exists(legacyPath) ? io.read(legacyPath) : null,
  );
}

export function writeLock(root: string, lock: RegistryLock, io: LockIo = nodeIo): void {
  const lockPath = join(root, REGISTRY_LOCK_FILENAME);
  io.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

export function upsertLockEntry(lock: RegistryLock, name: string, entry: RegistryLockEntry): RegistryLock {
  lock.items[name] = entry;
  return lock;
}
