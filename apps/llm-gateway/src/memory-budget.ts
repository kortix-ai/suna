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

/**
 * Admission gets 50% of the process memory limit; the other 50% is Bun's heap
 * floor, response streams, and allocator slack.
 *
 * 50% is safe because the admission counter already charges
 * DEFAULT_BODY_AMPLIFICATION (3x) per wire byte and that factor is MEASURED,
 * not guessed: memory-envelope.test.ts drives a 27 MiB / 40-screenshot request
 * through the real handler and records a peak of 2.25x (openai-compat) and
 * 2.9x (anthropic ai-sdk) over the wire size, with a 0.61x steady state once
 * the stream is handed back. The parsed graph is therefore fully inside the
 * charged amount; the old 25% share double-counted it.
 */
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
  return Math.max(MINIMUM_BUDGET, Math.floor(limit * 0.5));
}
