/**
 * One freshness contract per entity, declared once.
 *
 * `staleTime` is per-OBSERVER in React Query, not per-key. Seven call sites
 * reading `['project-detail', id]` therefore declared seven answers to "when
 * does a server-side change reach the user", and which one governed depended
 * on which pages happened to be mounted. Tiers remove the choice from the call
 * site: a consumer spreads a contract, it never authors one.
 *
 * `refetchOnMount` is false everywhere on purpose. Explicit invalidation is the
 * freshness channel; a component mounting is not evidence that data changed.
 */
export type FreshnessTier = 'live' | 'config' | 'inventory' | 'volatile';

const GC_TIME = 30 * 60 * 1000;

const TIERS: Record<FreshnessTier, { staleTime: number }> = {
  /** Kept current by SSE events. Polling it would be redundant and racy. */
  live: { staleTime: Infinity },
  /** Changes arrive through this app's own mutations, which invalidate. */
  config: { staleTime: 60_000 },
  /** Can also change from another member or another tab. */
  inventory: { staleTime: 30_000 },
  /** Genuinely time-sensitive; no mutation announces the change. */
  volatile: { staleTime: 5_000 },
};

export function contract(tier: FreshnessTier) {
  return {
    staleTime: TIERS[tier].staleTime,
    gcTime: GC_TIME,
    refetchOnMount: false as const,
  };
}

/**
 * Entity → tier. Adding an entity here without a tier is a type error, which
 * is the point: a new query cannot quietly inherit the global default.
 */
export const FRESHNESS = {
  projectsList: 'inventory',
  projectDetail: 'config',
  projectConfig: 'config',
  sessions: 'inventory',
  messages: 'live',
  connectors: 'config',
  secrets: 'config',
  policies: 'config',
  access: 'inventory',
  files: 'config',
  branches: 'config',
  sandboxes: 'volatile',
  snapshots: 'config',
  gateway: 'volatile',
} as const satisfies Record<string, FreshnessTier>;
