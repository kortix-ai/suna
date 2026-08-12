/**
 * The monitor-box reconciler's DECISIONS, with no `db`, no `config`, and no
 * provider import.
 *
 * The reconciler converges desired state (spec D5): flag on + ≥1 enabled
 * monitor ⇒ a box exists and runs the current manifest revision; flag off, zero
 * monitors, an inactive project, or an exceeded budget ⇒ no box. Every one of
 * those rules is a pure function here, and the DB/provider half
 * (./monitor-box.ts) is a thin store that executes what these return — the same
 * split ./trigger-runtime-catalog-core.ts uses, and the reason the decision
 * matrix is unit-testable without mocking a database.
 *
 * Spec: docs/specs/2026-08-12-monitors.md.
 */

import { createHash } from 'node:crypto';

/** Enabled monitors one project may run. Extras are disabled, deterministically. */
export const MONITOR_MAX_ENABLED = 10;
/** Default monthly compute budget for a project's monitor box, in USD. */
export const MONITOR_DEFAULT_MONTHLY_BUDGET_USD = 75;
/** Bounds `monitors.monthly_budget_usd` in project metadata. */
export const MONITOR_MAX_MONTHLY_BUDGET_USD = 1000;
/** How long an event row is kept before the retention sweep deletes it. */
export const MONITOR_EVENT_RETENTION_DAYS = 30;
/**
 * Boxes PROVISIONED per pass.
 *
 * Bounded like every other periodic sweep here (RECONCILE_MISSING_BATCH_SIZE,
 * ORPHAN_REAP_MAX_PER_PASS): a create is a ~70 s provider call, so an unbounded
 * pass over a fleet that all wants a box at once would hold the maintenance
 * lock past its stall watchdog. Stopping and observing stay unbounded — they
 * are cheap, and they are the direction that saves money. Nothing starves: a
 * project that got no box this tick still wants one on the next.
 */
export const MONITOR_CREATES_PER_PASS = 10;

/** Box row statuses that count as live (the partial unique index's set). */
export const MONITOR_LIVE_BOX_STATUSES = [
  'provisioning',
  'starting',
  'running',
  'stopping',
] as const;

/** One monitor as the trigger catalog stores it. */
export interface MonitorCatalogRow {
  slug: string;
  enabled: boolean;
  /** `triggerScheduleRevision(spec)` — changes iff the monitor's spec changed. */
  scheduleRevision: string | null;
  /** The full `GitTriggerSpec`, as persisted in `schedule_spec`. */
  spec: {
    run?: string | null;
    monitorMode?: 'poll' | 'stream' | null;
    intervalSeconds?: number | null;
    expectEventWithinSeconds?: number | null;
  } | null;
}

/** The subset of a box row the decision needs. */
/**
 * The secret grant a SHARED monitor box may hold, given each enabled
 * monitor's agent grant: the intersection. Every monitor process runs
 * same-UID in one microVM, so any secret in the box is readable by every
 * monitor — a secret ships only when every agent is granted it. 'all' is an
 * unscoped grant: it imposes no restriction on the others, and all-'all'
 * stays 'all'. `withheldByAgent` names, per agent, the identifiers narrowed
 * away (empty list = an unscoped grant was narrowed to the shared set), so
 * callers can surface the withholding instead of failing silently.
 */
export function intersectMonitorSecretGrants(grants: Map<string, string[] | 'all'>): {
  grant: string[] | 'all';
  withheldByAgent: Map<string, string[]>;
} {
  const scoped = [...grants.values()].filter((g): g is string[] => Array.isArray(g));
  const grant: string[] | 'all' =
    scoped.length === 0 ? 'all' : scoped.reduce((acc, g) => acc.filter((id) => g.includes(id)));
  const withheldByAgent = new Map<string, string[]>();
  if (Array.isArray(grant)) {
    for (const [agent, g] of grants) {
      const withheld = g === 'all' ? [] : g.filter((id) => !grant.includes(id));
      if (withheld.length > 0 || (g === 'all' && scoped.length > 0)) {
        withheldByAgent.set(agent, withheld);
      }
    }
  }
  return { grant, withheldByAgent };
}

export interface MonitorBoxSnapshot {
  boxId: string;
  status: string;
  manifestRevision: string | null;
  externalId: string | null;
}

export type MonitorBoxAction =
  /** Nothing to do — either no box is wanted and none exists, or it is correct. */
  | { kind: 'none'; reason: string }
  /** No live box exists and one is wanted. */
  | { kind: 'create'; reason: string }
  /** A live box exists but runs the wrong manifest, or is wedged. Tear + rebuild. */
  | { kind: 'restart'; reason: string }
  /** A live box exists and is no longer wanted. */
  | { kind: 'stop'; reason: string }
  /** The box is correct: observe it and stamp billing liveness. */
  | { kind: 'observe'; reason: string };

export interface MonitorBoxDecisionInput {
  projectActive: boolean;
  flagEnabled: boolean;
  /** Count AFTER the cap has been applied. */
  enabledMonitors: number;
  /** {@link monitorManifestRevision} over the enabled monitors. */
  desiredRevision: string;
  budgetExceeded: boolean;
  box: MonitorBoxSnapshot | null;
}

/**
 * The whole desired-state rule, in evaluation order.
 *
 * Order matters and is deliberate: "should a box exist at all" is answered
 * before "is the box we have correct", so a flag flipped off tears the box down
 * even when its manifest also drifted, and the budget gate cannot be bypassed
 * by a manifest edit.
 */
export function decideMonitorBox(input: MonitorBoxDecisionInput): MonitorBoxAction {
  const wanted = input.projectActive && input.flagEnabled && input.enabledMonitors > 0;
  if (!wanted) {
    const reason = !input.projectActive
      ? 'project is not active'
      : !input.flagEnabled
        ? 'monitors flag is off'
        : 'no enabled monitors';
    return input.box ? { kind: 'stop', reason } : { kind: 'none', reason };
  }
  // The budget is a HARD stop, checked before anything that could recreate a
  // box: an over-budget project must not get one back on the next tick because
  // its manifest happened to change.
  if (input.budgetExceeded) {
    const reason = 'monthly monitor compute budget exceeded';
    return input.box ? { kind: 'stop', reason } : { kind: 'none', reason };
  }
  if (!input.box) return { kind: 'create', reason: 'no live monitor box' };
  if (input.box.status === 'error') {
    return { kind: 'restart', reason: 'box is in error' };
  }
  if (!input.box.externalId) {
    // A row that never got a provider id is a create that died mid-flight.
    return { kind: 'restart', reason: 'box has no provider id' };
  }
  if (input.box.manifestRevision !== input.desiredRevision) {
    return { kind: 'restart', reason: 'manifest revision drift' };
  }
  return { kind: 'observe', reason: 'box matches desired state' };
}

export interface MonitorSelection {
  /** The monitors the box will run, capped and ordered deterministically. */
  selected: MonitorCatalogRow[];
  /** Enabled monitors beyond the cap — disabled with a `last_error`. */
  overCap: MonitorCatalogRow[];
}

/**
 * Apply the per-project cap.
 *
 * The order is SLUG ASCENDING, not manifest order or insertion order: the
 * reconciler must pick the same ten monitors on every tick and in every
 * process, or an eleventh monitor would flap in and out and the box would
 * restart forever. Slug order is stable, visible in the manifest, and
 * independent of row ordering — a project that hits the cap can predict exactly
 * which monitors run by sorting its own slugs.
 */
export function selectEnabledMonitors(
  rows: readonly MonitorCatalogRow[],
  cap = MONITOR_MAX_ENABLED,
): MonitorSelection {
  const enabled = rows
    .filter((row) => row.enabled && !!row.spec?.run && !!row.spec?.monitorMode)
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return { selected: enabled.slice(0, cap), overCap: enabled.slice(cap) };
}

/** The `last_error` written on a monitor disabled by the per-project cap. */
export function monitorOverCapError(cap = MONITOR_MAX_ENABLED): string {
  return `monitor disabled: this project already runs the maximum of ${cap} enabled monitors (selected in slug order). Disable another monitor in kortix.yaml to make room.`;
}

/**
 * The box's manifest revision — the hash the reconciler compares to decide
 * whether the running box is still correct.
 *
 * Built from each monitor's own `schedule_revision`, which already hashes
 * exactly the fields a monitor's behavior depends on (run, mode, interval,
 * expect_event_within, enabled, filter, prompt, agent, model). So a manifest
 * edit that changes nothing a monitor does produces the same revision and does
 * NOT restart the box — and any edit that does change one, restarts it.
 */
export function monitorManifestRevision(rows: readonly MonitorCatalogRow[]): string {
  if (rows.length === 0) return '';
  const material = rows
    .map((row) => `${row.slug}:${row.scheduleRevision ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** One entry of the `KORTIX_MONITORS` payload the daemon reads at boot. */
export interface MonitorEnvEntry {
  slug: string;
  run: string;
  mode: 'poll' | 'stream';
  interval_seconds?: number;
  expect_event_within_seconds?: number;
}

/**
 * Serialize the selected monitors for the box.
 *
 * This is the ONLY thing the daemon learns about the manifest: apps/api owns
 * the parse, so the box can never disagree with the platform about which
 * monitors exist or what command each one names.
 */
export function buildMonitorEnvPayload(rows: readonly MonitorCatalogRow[]): string {
  const entries: MonitorEnvEntry[] = [];
  for (const row of rows) {
    const run = row.spec?.run;
    const mode = row.spec?.monitorMode;
    if (!run || !mode) continue;
    entries.push({
      slug: row.slug,
      run,
      mode,
      ...(mode === 'poll' && row.spec?.intervalSeconds
        ? { interval_seconds: row.spec.intervalSeconds }
        : {}),
      ...(row.spec?.expectEventWithinSeconds
        ? { expect_event_within_seconds: row.spec.expectEventWithinSeconds }
        : {}),
    });
  }
  return JSON.stringify(entries);
}

/**
 * Read the project's monthly monitor budget out of its metadata, clamped.
 *
 * Lives in `metadata.monitors.monthly_budget_usd` rather than a column: the
 * experimental surface has no CRUD yet, and a metadata key can be set today
 * without a migration. Anything unparseable falls back to the default — a
 * malformed number must never read as "unlimited".
 */
export function monitorMonthlyBudgetUsd(metadata: unknown): number {
  const monitors =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).monitors
      : null;
  const raw =
    monitors && typeof monitors === 'object' && !Array.isArray(monitors)
      ? (monitors as Record<string, unknown>).monthly_budget_usd
      : undefined;
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return MONITOR_DEFAULT_MONTHLY_BUDGET_USD;
  return Math.min(value, MONITOR_MAX_MONTHLY_BUDGET_USD);
}

/**
 * The `box_epoch` a PLATFORM-written event row carries.
 *
 * Platform rows must never collide with a runner's `(slug, epoch, seq)` space,
 * and a recurring platform notice must announce itself once, not every five
 * minutes. Both fall out of one key: a namespaced epoch that carries the period
 * it belongs to, with `seq: 0`, inserted `ON CONFLICT DO NOTHING`. One budget
 * notice per project per calendar month, for free.
 */
export function platformMonitorEpoch(kind: string, now: Date): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `platform:${kind}:${month}`;
}

export interface MonitorReconcileResult {
  projects: number;
  created: number;
  restarted: number;
  stopped: number;
  observed: number;
  disabledOverCap: number;
  /** Boxes this pass wanted to build but deferred to the next tick. */
  deferred: number;
  errors: number;
}

export function emptyMonitorReconcileResult(): MonitorReconcileResult {
  return {
    projects: 0,
    created: 0,
    restarted: 0,
    stopped: 0,
    observed: 0,
    disabledOverCap: 0,
    deferred: 0,
    errors: 0,
  };
}

/** The project state one reconcile pass reads. */
export interface MonitorProjectSnapshot {
  projectId: string;
  accountId: string;
  active: boolean;
  flagEnabled: boolean;
  monitors: MonitorCatalogRow[];
  box: MonitorBoxSnapshot | null;
  // Provisioning context. NO decision in this module reads these — they are
  // carried so the DB store can build a box without a second project query.
  repoUrl?: string;
  defaultBranch?: string;
  manifestPath?: string;
  metadata?: unknown;
}

/**
 * Everything the reconciler needs from the outside world. The DB/provider
 * implementation lives in ./monitor-box.ts; tests supply an in-memory one.
 */
export interface MonitorBoxStore {
  /** Projects that declare a monitor OR still hold a live box. */
  listProjects(): Promise<MonitorProjectSnapshot[]>;
  /** Disable a monitor pushed out by the cap, with an explanatory last_error. */
  disableMonitor(projectId: string, slug: string, error: string): Promise<void>;
  /** True when this project's monitor compute has hit its monthly budget. */
  budgetExceeded(project: MonitorProjectSnapshot): Promise<boolean>;
  /** Provision a box for the selected monitors. */
  createBox(
    project: MonitorProjectSnapshot,
    monitors: MonitorCatalogRow[],
    revision: string,
  ): Promise<void>;
  /** Tear a box down: provider removal, billing close, row closed out. */
  stopBox(project: MonitorProjectSnapshot, box: MonitorBoxSnapshot, reason: string): Promise<void>;
  /**
   * Observe a running box. MUST be a control-plane observation of the provider
   * (billing liveness is not allowed to trust anything the box says about
   * itself — see billing/services/compute-liveness.ts).
   */
  observeBox(project: MonitorProjectSnapshot, box: MonitorBoxSnapshot): Promise<void>;
  /** Append a platform lifecycle event so the owner's agent hears about it. */
  appendLifecycleEvent(
    project: MonitorProjectSnapshot,
    slug: string,
    epoch: string,
    line: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * One reconcile pass over every project.
 *
 * Each project is isolated: a throw is counted and the sweep continues, because
 * one project's unreachable provider must never stop every other project's
 * monitors from converging.
 */
export async function reconcileMonitorBoxesWithStore(
  store: MonitorBoxStore,
  now = new Date(),
): Promise<MonitorReconcileResult> {
  const result = emptyMonitorReconcileResult();
  const projects = await store.listProjects();
  result.projects = projects.length;

  for (const project of projects) {
    try {
      const { selected, overCap } = selectEnabledMonitors(project.monitors);
      for (const row of overCap) {
        await store.disableMonitor(project.projectId, row.slug, monitorOverCapError());
        result.disabledOverCap += 1;
      }

      const wantsBox =
        project.active && project.flagEnabled && selected.length > 0;
      // Only ask the budget question when a box is actually wanted — it is a
      // per-project aggregate query and a flag-off project must not pay for it.
      const budgetExceeded = wantsBox ? await store.budgetExceeded(project) : false;

      const decision = decideMonitorBox({
        projectActive: project.active,
        flagEnabled: project.flagEnabled,
        enabledMonitors: selected.length,
        desiredRevision: monitorManifestRevision(selected),
        budgetExceeded,
        box: project.box,
      });

      switch (decision.kind) {
        case 'none':
          break;
        case 'create':
          if (result.created + result.restarted >= MONITOR_CREATES_PER_PASS) {
            result.deferred += 1;
            break;
          }
          await store.createBox(project, selected, monitorManifestRevision(selected));
          result.created += 1;
          break;
        case 'restart':
          // A restart's STOP is not deferred: leaving a box running the wrong
          // manifest is worse than leaving the project briefly unwatched, and
          // the next tick rebuilds it through the `create` branch above.
          await store.stopBox(project, project.box!, decision.reason);
          if (result.created + result.restarted >= MONITOR_CREATES_PER_PASS) {
            result.deferred += 1;
            break;
          }
          await store.createBox(project, selected, monitorManifestRevision(selected));
          result.restarted += 1;
          break;
        case 'stop':
          await store.stopBox(project, project.box!, decision.reason);
          result.stopped += 1;
          if (budgetExceeded && selected[0]) {
            // ONE notice per project per month, on the first monitor in slug
            // order — the owner needs to be told once, not ten times.
            await store.appendLifecycleEvent(
              project,
              selected[0].slug,
              platformMonitorEpoch('budget', now),
              {
                event: 'budget_exceeded',
                detail:
                  'the project monitor box was stopped because this month\'s monitor compute budget is spent. Raise metadata.monitors.monthly_budget_usd or wait for the next billing month; no monitor is running until then.',
              },
            );
          }
          break;
        case 'observe':
          await store.observeBox(project, project.box!);
          result.observed += 1;
          break;
      }
    } catch (error) {
      result.errors += 1;
      console.warn(
        `[monitor-box] reconcile failed for project ${project.projectId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}
