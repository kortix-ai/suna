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
export type FreshnessTier = 'live' | 'config' | 'inventory' | 'volatile' | 'directory';

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
  directory: { staleTime: 10_000 },
};

/**
 * The fail-safe refetch for a query that settled as error WITHOUT data on a
 * still-mounted page.
 *
 * One transient failure (the API answered 5xx once, a network blip, the auth
 * session not published yet) used to park such an entry forever: nothing
 * refetches a settled error while the page stays mounted, and every
 * `enabled:` gate derived from the same entry stays shut — the page showed its
 * loading/empty state until a manual reload (reported 2026-10-04 on the Models
 * page and project settings, whose reads are gated on the shared project
 * detail entry).
 *
 * While the entry has no data and is in error, TanStack calls this on every
 * observer update and re-fires the fetch on the returned delay — 2 s, then
 * doubling to a 30 s ceiling. The engine only schedules the interval while the
 * query is enabled and observed: a gated query (`enabled: false`) fires
 * nothing, its gate re-opens when the entry it derives from heals, and the
 * first success clears the interval (data arrives ⇒ `false`). A pending or a
 * stale-data entry polls nothing, so healthy behavior is unchanged.
 *
 * The structural parameter is the part of TanStack's `Query` this decision
 * reads; the engine passes the full object, which is assignable to it.
 */
const ERROR_SELF_HEAL_BASE_MS = 2_000;
const ERROR_SELF_HEAL_CAP_MS = 30_000;

function errorSelfHealRefetchInterval(query: {
  state: { status: string; data?: unknown; errorUpdateCount: number };
}): number | false {
  const { status, data, errorUpdateCount } = query.state;
  if (status !== 'error' || data !== undefined) return false;
  return Math.min(
    ERROR_SELF_HEAL_BASE_MS * 2 ** Math.max(0, errorUpdateCount - 1),
    ERROR_SELF_HEAL_CAP_MS,
  );
}

export function contract(tier: FreshnessTier) {
  return {
    staleTime: TIERS[tier].staleTime,
    gcTime: GC_TIME,
    refetchOnMount: true as const,
    /**
     * A settled error with no data retried with capped backoff — see
     * `errorSelfHealRefetchInterval`. `directory` overrides with its
     * unconditional poll below, which already re-fires an errored entry.
     */
    refetchInterval: errorSelfHealRefetchInterval,
    ...(tier === 'directory'
      ? {
          refetchInterval: 10_000,
          refetchIntervalInBackground: false,
          refetchOnWindowFocus: 'always' as const,
          refetchOnReconnect: 'always' as const,
        }
      : {}),
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
  /**
   * The Connectors page list. Connectors change from outside that page: an
   * agent adds one in chat, a setup link or an OAuth return completes in
   * another tab, a teammate edits the manifest. `config` refetched only on
   * mount, and the page's top-level query never remounts, so the Connected tab
   * showed the new state only after a browser reload (prod, 2026-09-26).
   */
  connectors: 'directory',
  connectorConfig: 'config',
  /** A provider metadata probe; it changes on the provider's schedule, not ours. */
  connectorOAuth2Discovery: 'config',
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
  /** Live status: a device heartbeats every 30 s and counts as offline after 120 s. */
  captureDevices: 'directory',
  /** A timeline grows while its devices upload; no mutation of ours announces it. */
  captureTimeline: 'inventory',
  capturePolicy: 'config',
  captureWorkspace: 'config',
  captureMembers: 'directory',
  capturePeople: 'inventory',
  /** Workflows and episodes change when the nightly and 5-minute pipelines run. */
  captureIntelligence: 'inventory',
} as const satisfies Record<string, FreshnessTier>;
