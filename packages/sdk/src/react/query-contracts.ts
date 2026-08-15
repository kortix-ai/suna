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
  /**
   * Genuinely time-sensitive; no mutation announces the change, AND a
   * 30-second-old value would actively mislead.
   *
   * UNCLAIMED as of the `sandboxes`/`gateway` review below. Kept because
   * `FreshnessTier` is a published string-literal union and dropping a member
   * is a breaking change — not because anything needs it. The first two
   * entities put here got it for sounding urgent rather than being urgent, so
   * the bar for the next claimant is the second clause: name the reader that
   * is materially wrong at t+30s.
   */
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
  apps: 'inventory',
  appDeployments: 'inventory',
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
  /**
   * NOT live sandbox health — the sandbox TEMPLATE catalog.
   * `listProjectSandboxes` is `GET /projects/:id/sandboxes` returning
   * `SandboxTemplatesResponse` (`{ items, default_slug, provider_mode, … }`),
   * byte-for-byte the same call `sandboxTemplates` below already makes. Live
   * health is a different entity entirely — `getProjectSandboxHealth`,
   * `GET /projects/:id/sandbox-health`, read by `project-sandbox-alert.tsx`
   * under its own key with its own adaptive `refetchInterval` (8s while a
   * build is active, 120s otherwise). Nothing on THIS key is time-sensitive.
   *
   * Was `volatile` (5s) on the strength of the word "sandbox". Its
   * pre-migration window was 60s, every change to it arrives through this
   * app's own mutations (`sandbox-template-form.tsx`, `sandbox-view.tsx` —
   * all three invalidate this key), and `refetchOnMount: true` at 5s meant a
   * refetch on essentially every project landing. `config` restores the
   * original window and matches the twin below, which reads the same
   * response.
   */
  sandboxes: 'config',
  sandboxTemplates: 'config',
  snapshots: 'config',
  modelPicker: 'config',
  /**
   * Analytics aggregates over a `days` window — overview, series, breakdown,
   * sessions, errors — plus budgets and keys.
   *
   * The aggregates accumulate from TRAFFIC (agent runs, other members),
   * which no mutation of ours announces, so they cannot be `config`. But they
   * are aggregates over days: a 5-second window buys nothing a 30-second one
   * doesn't, and cost real requests — `refetchOnMount: true` at `volatile`
   * refetched all five on every Customize -> Gateway open. `inventory` is
   * both the honest description ("can also change from another member") and
   * exactly their pre-migration 30s window.
   *
   * Budgets and keys ride the same tier at 30s against a pre-migration 15s.
   * Safe: both are mutated only through this UI and both invalidate on
   * success (`use-project-gateway.ts`), so staleTime only ever bounds an
   * out-of-band change. `gatewayLogs` opts out entirely — it sets
   * `refetchInterval: 10_000` and no contract, because a log tail genuinely
   * is a tail.
   */
  gateway: 'inventory',
  triggers: 'config',
  /** Personalized-or-static prompt chips shown before a project's first
   *  message. No live writer announces a change (regenerated lazily server
   *  side); `config` matches `triggers`/`files`, the other repo-manifest-ish
   *  reads that only change through this app's own mutations. */
  starterSuggestions: 'config',
} as const satisfies Record<string, FreshnessTier>;
