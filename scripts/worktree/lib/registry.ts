import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  openSync, closeSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ports } from './ports';

export const KORTIX_HOME = process.env.KORTIX_HOME || join(homedir(), '.kortix');
export const WT_HOME = join(KORTIX_HOME, 'worktrees');
export const REGISTRY_PATH = join(WT_HOME, 'registry.json');
const LOCK_PATH = join(WT_HOME, 'registry.lock');

export interface SlotEntry {
  slot: number;
  projectId: string;
  path: string;
  branch: string;
  ports: Ports;
  createdAt: string;
  status: 'created' | 'running' | 'stopped';
}
export interface Registry {
  version: number;
  slots: Record<string, SlotEntry>;
}

function ensureHome() {
  if (!existsSync(WT_HOME)) mkdirSync(WT_HOME, { recursive: true, mode: 0o700 });
}

export function loadRegistry(): Registry {
  ensureHome();
  if (!existsSync(REGISTRY_PATH)) return { version: 1, slots: {} };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    throw new Error(`registry.json is corrupt: ${REGISTRY_PATH}`);
  }
}

export function saveRegistry(reg: Registry) {
  ensureHome();
  const tmp = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, REGISTRY_PATH); // atomic
}

export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  ensureHome();
  for (let i = 0; i < 120; i++) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      try { return await fn(); } finally { try { rmSync(LOCK_PATH); } catch {} }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > 60_000) { rmSync(LOCK_PATH); continue; }
      } catch {}
      await Bun.sleep(250);
    }
  }
  throw new Error(`could not acquire registry lock (${LOCK_PATH}); remove it if stale`);
}

export function sanitizeName(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!s) throw new Error(`invalid worktree name: "${name}"`);
  return s.slice(0, 40);
}

export function lowestFreeSlot(reg: Registry): number {
  const used = new Set(Object.values(reg.slots).map((s) => s.slot));
  let n = 0; while (used.has(n)) n++;
  return n;
}

export function slotDir(name: string): string { return join(WT_HOME, name); }
export function supaWorkdir(name: string): string { return join(slotDir(name), 'sb'); }
export function pnpmStore(name: string): string { return join(slotDir(name), 'pnpm-store'); }

export function writeMarker(worktreePath: string, entry: SlotEntry) {
  writeFileSync(join(worktreePath, '.kortix-worktree.json'), JSON.stringify(entry, null, 2));
}
