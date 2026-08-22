import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const MIB = 1024 * 1024;
const MINIMUM_BUDGET = 16 * MIB;
const FALLBACK_BUDGET = 256 * MIB;
const UNLIMITED_SENTINEL = 2 ** 53;

function readLimit(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value < UNLIMITED_SENTINEL ? value : null;
  } catch {
    return null;
  }
}

/** Reserves 75% of process memory for Bun, parsed objects, streams, and SDKs. */
export function automaticInflightBudgetBytes(): number {
  const host = totalmem();
  const cgroup =
    readLimit('/sys/fs/cgroup/memory.max') ??
    readLimit('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const limit = cgroup ? Math.min(cgroup, host) : host;
  return deriveInflightBudgetBytes(limit);
}

export function deriveInflightBudgetBytes(limit: number | null): number {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return FALLBACK_BUDGET;
  return Math.max(MINIMUM_BUDGET, Math.floor(limit * 0.25));
}
