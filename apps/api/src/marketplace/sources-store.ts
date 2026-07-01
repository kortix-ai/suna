/**
 * Persisted "Add a marketplace" sources — extra registries an operator points
 * Kortix at (a GitHub repo, Git URL, or local folder), Codex-style. Stored as a
 * single JSON array under the `marketplace.sources` platform setting (a JSONB
 * KV row), so no migration is needed. Platform-global: every project sees them.
 * (Account-/project-scoping is a future refinement — see MARKETPLACE.md.)
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { platformSettings } from '@kortix/db';
import { Effect } from 'effect';
import { DatabaseService } from '../effect/services';
import { runEffectOrThrow } from '../effect/http';

const SOURCES_KEY = 'marketplace.sources';

export interface MarketplaceSource {
  id: string;
  /** A registry address: `owner/repo`, `github:owner/repo`, a registry.json URL, or a local path. */
  address: string;
  /** Optional git ref (branch/tag/sha) override. */
  gitRef?: string;
  /** Optional sparse sub-paths to scan within the repo (e.g. `plugins/codex`). */
  sparsePaths?: string[];
  /** Optional display label. */
  label?: string;
  addedAt: string;
}

export interface AddSourceInput {
  address: string;
  gitRef?: string;
  sparsePaths?: string[];
  label?: string;
}

function normalize(raw: unknown): MarketplaceSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is MarketplaceSource => !!s && typeof (s as { address?: unknown }).address === 'string');
}

export async function listSources(): Promise<MarketplaceSource[]> {
  return runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    const rows = yield* Effect.tryPromise(() =>
      database
        .select({ value: platformSettings.value })
        .from(platformSettings)
        .where(eq(platformSettings.key, SOURCES_KEY))
        .limit(1),
    );
    return normalize(rows[0]?.value);
  }));
}

async function writeSources(sources: MarketplaceSource[]): Promise<void> {
  await runEffectOrThrow(Effect.gen(function* () {
    const { database } = yield* DatabaseService;
    yield* Effect.tryPromise(() =>
      database
        .insert(platformSettings)
        .values({ key: SOURCES_KEY, value: sources })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: sources, updatedAt: new Date() } }),
    );
  }));
}

export async function addSource(input: AddSourceInput): Promise<MarketplaceSource> {
  const address = input.address.trim();
  if (!address) throw new Error('A source address is required');
  const gitRef = input.gitRef?.trim() || undefined;
  const sparsePaths = (input.sparsePaths ?? []).map((p) => p.trim()).filter(Boolean);
  const label = input.label?.trim() || undefined;

  const sources = await listSources();
  // De-dupe on (address, gitRef): re-adding updates sparse paths/label in place.
  const existing = sources.find((s) => s.address === address && (s.gitRef ?? '') === (gitRef ?? ''));
  if (existing) {
    existing.sparsePaths = sparsePaths.length ? sparsePaths : undefined;
    if (label) existing.label = label;
    await writeSources(sources);
    return existing;
  }

  const source: MarketplaceSource = {
    id: randomUUID(),
    address,
    gitRef,
    sparsePaths: sparsePaths.length ? sparsePaths : undefined,
    label,
    addedAt: new Date().toISOString(),
  };
  await writeSources([...sources, source]);
  return source;
}

export async function removeSource(id: string): Promise<boolean> {
  const sources = await listSources();
  const next = sources.filter((s) => s.id !== id);
  if (next.length === sources.length) return false;
  await writeSources(next);
  return true;
}
