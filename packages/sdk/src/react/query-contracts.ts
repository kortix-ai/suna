/**
 * One freshness contract per entity, declared once.
 *
 * `staleTime` is per-OBSERVER in React Query, not per-key. Seven call sites
 * reading the flat `project-detail` key therefore declared seven answers to "when
 * does a server-side change reach the user", and which one governed depended
 * on which pages happened to be mounted. Tiers remove the choice from the call
 * site: a consumer spreads a contract, it never authors one.
 *
 * `refetchOnMount` is `true` everywhere, DELIBERATELY, and it is the second
 * time this file has gotten it wrong — the first version said `false`
 * "because explicit invalidation is the freshness channel". That is
 * empirically false: `invalidateQueries` defaults to `refetchType: 'active'`,
 * which only refetches queries with a currently-mounted observer. An
 * invalidated entry with NO mounted observer — the exact shape of a route the
 * user has navigated away from — is marked invalidated but never refetched,
 * and `refetchOnMount:false` means the next mount doesn't refetch it either.
 * It serves its stale (or, worse, wrongly-optimistic — see
 * `invalidate-project.ts`) value for the rest of `gcTime`. Verified against
 * the real TanStack engine:
 *
 *   refetchOnMount:false -> {"seen":"OPTIMISTIC","totalFetches":1}   wrong value survives
 *   refetchOnMount:true  -> {"seen":"SERVER","totalFetches":2}        self-heals
 *
 * This is NOT a tradeoff against "wasted" fetches on remount, because
 * `refetchOnMount:true` still respects `staleTime` — it only refetches an
 * entry that is actually stale or invalidated. A remount of FRESH data costs
 * the same either way:
 *
 *   FRESH-FALSE {"refetchedOnRemount":0,"isPending":false}
 *   FRESH-TRUE  {"refetchedOnRemount":0,"isPending":false}
 *
 * Do not "optimise" this back to `false` without redoing both probes above.
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
    refetchOnMount: true as const,
  };
}

/**
 * Entity → tier. Adding an entity here without a tier is a type error, which
 * is the point: a new query cannot quietly inherit the global default.
 */
export const FRESHNESS = {
  projectsList: 'inventory',
  projectSummary: 'config',
  projectDetail: 'config',
  projectConfig: 'config',
  session: 'inventory',
  sessions: 'inventory',
  messages: 'live',
  connectors: 'config',
  connectorConfig: 'config',
  secrets: 'config',
  policies: 'config',
  executorPolicies: 'config',
  access: 'inventory',
  accessRequests: 'inventory',
  pendingInvites: 'inventory',
  groupGrants: 'inventory',
  resourceGrants: 'inventory',
  files: 'config',
  fileSource: 'config',
  branches: 'config',
  sandboxes: 'volatile',
  sandboxTemplates: 'config',
  snapshots: 'config',
  modelPicker: 'config',
  gateway: 'volatile',
  triggers: 'config',
} as const satisfies Record<string, FreshnessTier>;
