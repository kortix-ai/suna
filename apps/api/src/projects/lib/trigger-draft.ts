import type { TriggerList } from '@kortix/api-contract';
import { apps, connectorConnections, connectors, projectTriggerRuntime } from '@kortix/db';
import { type TriggerFilter, cronIntervalError, formatDurationSeconds, normalizeTriggerEntry, parseTriggerFilter } from '@kortix/manifest-schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../shared/db';
import * as store from '../trigger-events/store';
import { EVENT_TRIGGERS_OFF_MESSAGE, eventTriggersOffForProject } from '../trigger-events/flag';
import { connectionIdentity } from '../trigger-events/subscriptions';
import { MCP_SOURCE_ID, connectorEventApp } from '../trigger-events/mcp-source';
import { streamSchedules } from '../trigger-events/poll-store';
import { eventSourceAvailable } from '../trigger-events/registry';
import { ensureProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { nextTriggerScheduleSlot, validateTriggerCron, validateTriggerTimezone } from '../trigger-schedule';
import { GIT_TRIGGER_SESSION_MODES, type GitTriggerEventFields, type GitTriggerSessionMode, type GitTriggerSpec, type GitTriggerType, type LoadedTriggers, MANIFEST_FILENAME, type ParsedManifest, defaultTriggerSessionMode, eventOnlyKeyError, extractTriggers, parseMaxLateness, parseOverlap, parseRunCaps, parseAppField, parseEventFields, parseEvery, parseTargetField, readManifest, triggerSpecToTomlEntry, MONITOR_REMOVED } from '../triggers';
import { PRIVATE_TRIGGER_SESSION_ACCESS, loadTriggerSessionAccessMap } from '../trigger-session-access';
import { withProjectGitAuth } from './git';
import { type ProjectRow, deriveKortixApiRoot, normalizeBoolean, normalizeString } from './serializers';
import { triggersPausedForProject } from './trigger-scheduler-state';
import { readAccountAutomationPause } from '../../accounts/automation-pause';

// GET /v1/projects

export function buildPublicWebhookUrl(projectId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */

/** An app trigger's `app` must name a live App of the project, or the error to answer. */
export async function validateAppTriggerTarget(projectId: string, app: string): Promise<string | null> {
  const [row] = await db
    .select({ appId: apps.appId })
    .from(apps)
    .where(and(eq(apps.projectId, projectId), eq(apps.slug, app), isNull(apps.deletedAt)))
    .limit(1);
  return row ? null : `No App "${app}" in this project. Create or deploy it first: kortix apps deploy ${app}`;
}

export async function loadTriggersForResponse(
  projectId: string,
  project: ProjectRow,
): Promise<TriggerList> {
  const gitProject = await withProjectGitAuth(project);
  let manifest: ParsedManifest | null = null;
  let loaded: LoadedTriggers;
  try {
    manifest = await readManifest(gitProject);
    loaded = manifest ? extractTriggers(manifest) : { specs: [], errors: [] };
  } catch (error) {
    loaded = {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: gitProject.manifestPath || MANIFEST_FILENAME,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const { specs, errors } = loaded;
  if (manifest) {
    // A read from one API task may briefly see an older checkout after another
    // task commits a manifest update. Reads may ensure declared rows exist, but
    // must never prune rows from that possibly stale snapshot. Authoritative
    // mutation/delete paths perform the destructive reconciliation themselves.
    await ensureProjectTriggerRuntime(projectId, specs);
  }
  const runtimeRows =
    specs.length === 0
      ? []
      : await db
          .select()
          .from(projectTriggerRuntime)
          .where(eq(projectTriggerRuntime.projectId, projectId));
  const eventConnectors = await loadEventConnectorInfo(projectId, specs, project.metadata);
  const subscriptionBySlug = new Map(
    specs.some((spec) => spec.event) ? (await store.listByProject(projectId)).map((r) => [r.slug, r]) : [],
  );
  const eventsOff = eventTriggersOffForProject(project.metadata);
  const connectedAsBySlug = await loadConnectedAs([...subscriptionBySlug.values()]);
  // Kortix-polled triggers (source `mcp`) say when their app was checked and is checked next.
  // The poller skips every stream of a paused project, or one without either flag: no next check then.
  const checksRun = !eventsOff && !triggersPausedForProject(project.metadata) && eventSourceAvailable(MCP_SOURCE_ID, project.metadata);
  const schedules = await streamSchedules(
    [...subscriptionBySlug.values()].flatMap((r) => (r.provider === MCP_SOURCE_ID && r.externalId ? [r.externalId] : [])),
  );
  const runtimeBySlug = new Map(runtimeRows.map((row) => [row.slug, row]));
  const sessionAccessBySlug =
    specs.length === 0 ? new Map() : await loadTriggerSessionAccessMap(projectId);

  return {
    triggers: specs.map((spec) => ({
      slug: spec.slug,
      path: spec.path,
      name: spec.name,
      type: spec.type,
      agent: spec.agent,
      model: spec.model,
      enabled: spec.enabled,
      cron: spec.cron,
      run_at: spec.runAt,
      every_seconds: spec.everySeconds ?? null,
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      // Monitor fields: the monitor box was removed. Always null; kept in the
      // response for clients built against it.
      run: null,
      mode: null,
      interval_seconds: null,
      expect_event_within_seconds: null,
      app: spec.app ?? null,
      target: spec.target ?? null,
      event: spec.event
        ? {
            connector: spec.event.connector,
            account: spec.event.account ?? null,
            connected_as: connectedAsBySlug.get(spec.slug) ?? null,
            type: spec.event.type,
            config: spec.event.config,
            // `source` = the adapter (declared, else the connector's provider). `provider` stays the
            // connector's own provider for older clients: it differs only when a declared source mismatches.
            source: spec.event.source ?? eventConnectors.get(spec.event.connector)?.provider ?? null,
            provider: eventConnectors.get(spec.event.connector)?.provider ?? null,
            app: eventConnectors.get(spec.event.connector)?.app ?? null,
            ...eventStatusFor(subscriptionBySlug.get(spec.slug), eventsOff),
            ...checkTimesFor(subscriptionBySlug.get(spec.slug), schedules, checksRun),
          }
        : null,
      prompt_template: spec.promptTemplate,
      session_mode: spec.sessionMode,
      session_id: spec.pinnedSessionId,
      session_key: spec.sessionKey,
      filter: spec.filter,
      // Run caps (KRTX-1721); null = unset (the hourly default, 60, applies).
      max_runs_per_hour: spec.maxRunsPerHour ?? null,
      max_runs_per_day: spec.maxRunsPerDay ?? null,
      // Overlap (KRTX-1721); null = unset (`skip` for cron, `allow` otherwise).
      overlap: spec.overlap ?? null,
      session_access: sessionAccessBySlug.get(spec.slug) ?? PRIVATE_TRIGGER_SESSION_ACCESS,
      last_fired_at: runtimeBySlug.get(spec.slug)?.lastFiredAt?.toISOString() ?? null,
      last_status: runtimeBySlug.get(spec.slug)?.lastStatus ?? null,
      last_error: runtimeBySlug.get(spec.slug)?.lastError ?? null,
      last_attempt_at: runtimeBySlug.get(spec.slug)?.lastAttemptAt?.toISOString() ?? null,
      // The slot the scheduler claims next, jitter included (KRTX-1743).
      next_fire_at: runtimeBySlug.get(spec.slug)?.nextFireAt?.toISOString() ?? null,
      next_cron_at: spec.cron && !validateTriggerCron(spec.cron, spec.timezone)
        ? nextTriggerScheduleSlot(spec, new Date())?.toISOString() ?? null
        : null,
      // Auto-pause (KRTX-1721): set while the trigger paused itself after a
      // sustained run-limit breach. `PATCH enabled: true` resumes it.
      auto_paused_at: runtimeBySlug.get(spec.slug)?.autoPausedAt?.toISOString() ?? null,
      auto_paused_reason: runtimeBySlug.get(spec.slug)?.autoPausedAt ? (runtimeBySlug.get(spec.slug)?.autoPausedReason ?? null) : null,
      webhook_url: spec.type === 'webhook' ? buildPublicWebhookUrl(projectId, spec.slug) : null,
    })),
    // Server-side activation state for this project's whole trigger set. When
    // true, the platform won't auto-run any of them (cron sweep skips, webhooks
    // ignored), regardless of each trigger's own `enabled`.
    triggers_paused: triggersPausedForProject(project.metadata),
    // The account's Pause all automations (KRTX-1721): true stops these triggers too.
    account_automations_paused: (await readAccountAutomationPause(project.accountId)) !== null,
    errors,
  };
}

/** Identity of the account each active subscription runs on, by trigger slug. */
async function loadConnectedAs(subs: store.EventSubscriptionRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(subs.flatMap((s) => (s.connectionId ? [s.connectionId] : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: connectorConnections.connectionId, label: connectorConnections.label, metadata: connectorConnections.metadata })
    .from(connectorConnections)
    .where(inArray(connectorConnections.connectionId, ids));
  const byId = new Map(rows.map((r) => [r.id, connectionIdentity(r)]));
  return new Map(subs.flatMap((s) => (s.connectionId && byId.has(s.connectionId) ? [[s.slug, byId.get(s.connectionId)!] as const] : [])));
}

/** provider + app of each connector an event trigger names (null when the connector is not declared). */
async function loadEventConnectorInfo(
  projectId: string,
  specs: GitTriggerSpec[],
  projectMetadata: unknown,
): Promise<Map<string, { provider: string; app: string | null }>> {
  const slugs = [...new Set(specs.flatMap((spec) => (spec.event ? [spec.event.connector] : [])))];
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ slug: connectors.slug, provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), inArray(connectors.slug, slugs)));
  const mcpAvailable = eventSourceAvailable(MCP_SOURCE_ID, projectMetadata);
  return new Map(rows.map((row) => [row.slug, { provider: row.provider, app: connectorEventApp(row, mcpAvailable) }]));
}

/**
 * When a Kortix-polled trigger's app was last checked, and is checked next.
 * The next check is null whenever the poller skips the stream (paused, a flag
 * off) or the trigger is not subscribed.
 */
function checkTimesFor(
  row: store.EventSubscriptionRow | undefined,
  schedules: Map<string, { checkedAt: Date | null; nextCheckAt: Date | null; lastError: string | null }>,
  checksRun: boolean,
): { checked_at: string | null; next_check_at: string | null } {
  const schedule = row?.externalId ? schedules.get(row.externalId) : undefined;
  // The rows a check serves (mcp-poll.ts load): active ones, and ones showing the stream's own error.
  const served = row?.status === 'active' || (row?.status !== undefined && row.lastError !== null && row.lastError === schedule?.lastError);
  const live = checksRun && served;
  return {
    checked_at: schedule?.checkedAt?.toISOString() ?? null,
    next_check_at: live ? (schedule?.nextCheckAt?.toISOString() ?? null) : null,
  };
}

/** Subscription state of one event trigger for the list response; `pending` = no subscription row yet. */
export function eventStatusFor(row: store.EventSubscriptionRow | undefined, flagOff = false): {
  status: 'active' | 'needs_connection' | 'error' | 'pending';
  error: string | null;
  last_event_at: string | null;
} {
  // Flag off: no subscription is live, whatever a stale row says.
  if (flagOff) return { status: 'error', error: EVENT_TRIGGERS_OFF_MESSAGE, last_event_at: row?.lastEventAt?.toISOString() ?? null };
  return {
    status: (row?.status as store.EventSubscriptionStatus | undefined) ?? 'pending',
    error: row?.lastError ?? null,
    last_event_at: row?.lastEventAt?.toISOString() ?? null,
  };
}

export interface TriggerDraft {
  slug: string;
  name: string;
  type: GitTriggerType;
  agent: string;
  /** Wire-form model (`provider/model`) or null for "Default" (resolve at fire time). */
  model: string | null;
  enabled: boolean;
  promptTemplate: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  secretEnv: string | null;
  /** For type=cron only — the misfire bound (`max_lateness`), in whole seconds. */
  maxLatenessSeconds?: number;
  /** Any type — the run caps (`max_runs_per_hour`, `max_runs_per_day`, KRTX-1721). Omitted when unset. */
  maxRunsPerHour?: number;
  maxRunsPerDay?: number;
  /** Fresh session mode only — `overlap` (KRTX-1721). Omitted when unset: the type's default applies. */
  overlap?: 'skip' | 'allow';
  /** For type=event only — connector, optional source adapter, the adapter's event type and event config. */
  event?: GitTriggerEventFields | null;
  /** For type=app only — the slug of the App whose events fire the trigger. */
  app?: string | null;
  /** A fire calls this App instead of running an agent (GitTriggerSpec.target). */
  target?: GitTriggerSpec['target'];
  /** For type=cron only — a fixed period instead of a cron expression (GitTriggerSpec.everySeconds). */
  everySeconds?: number;
  sessionMode: GitTriggerSessionMode;
  /** For sessionMode === 'pinned' only: the exact session id to loop. */
  pinnedSessionId: string | null;
  /** For sessionMode === 'keyed' only: the template deriving one session per key. */
  sessionKey: string | null;
  /** Payload paths that must match for a delivery to fire. Null when unfiltered. */
  filter: TriggerFilter | null;
}

export function parseTriggerDraft(
  rawBody: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  // A body may use the `on:` / `run:` shape; `run.prompt` is the prompt template.
  const normalized = normalizeTriggerEntry(rawBody) as Record<string, unknown>;
  const body = normalized !== rawBody && normalized.prompt !== undefined && normalized.prompt_template === undefined
    ? { ...normalized, prompt_template: normalized.prompt }
    : normalized;
  const rawSlug = normalizeString(body.slug);
  const name = normalizeString(body.name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const typeRaw = normalizeString(body.type);
  const type: GitTriggerType | null =
    typeRaw === 'webhook' || typeRaw === 'cron' || typeRaw === 'event' || typeRaw === 'app'
      ? typeRaw
      : null;
  if (typeRaw === 'monitor') return { error: MONITOR_REMOVED };
  if (!type) return { error: 'type must be "cron", "webhook", "event", or "app"' };
  if (type !== 'event') {
    const bad = eventOnlyKeyError(body, 'event_config', type);
    if (bad) return { error: bad };
  }
  if (type !== 'app' && body.app !== undefined && body.app !== null) {
    return { error: `app is only valid on an app trigger (type is "${type}")` };
  }
  if (type !== 'cron' && body.every !== undefined && body.every !== null) {
    return { error: `every is only valid on a cron trigger (type is "${type}")` };
  }

  const parsedTarget = parseTargetField(body, type);
  if ('error' in parsedTarget) return parsedTarget;
  // An App target receives the payload, not a prompt.
  const promptTemplate = normalizeString(body.prompt_template ?? body.promptTemplate) ?? (parsedTarget.target ? '' : null);
  if (promptTemplate === null) return { error: 'prompt_template is required' };

  const agent = normalizeString(body.agent ?? body.agent_name) ?? 'default';
  // null/empty model = "Default" — leave it to the resolution chain at fire time.
  const model = normalizeString(body.model) ?? null;
  const enabled = normalizeBoolean(body.enabled) ?? true;

  const session = parseDraftSession(body, type);
  if ('error' in session) return session;
  const { sessionMode, pinnedSessionId, sessionKey } = session;
  const parsedFilter = parseTriggerFilter(body.filter);
  if ('error' in parsedFilter) return parsedFilter;
  const { filter } = parsedFilter;

  const common = { slug, name, agent, model, enabled, promptTemplate, sessionMode, pinnedSessionId, sessionKey, filter };
  const lateness = parseMaxLateness(body, type);
  if ('error' in lateness) return lateness;
  const caps = parseRunCaps(body);
  if ('error' in caps) return caps;
  const overlap = parseOverlap(body);
  if ('error' in overlap) return overlap;
  const draft =
    type === 'event'
      ? parseEventDraft(body, common)
      : type === 'app'
        ? parseAppDraft(body, common)
        : type === 'cron'
          ? parseCronDraft(body, common)
          : parseWebhookDraft(body, common);
  if ('error' in draft) return draft;
  return { ...draft, ...(type === 'cron' ? lateness : {}), ...caps, ...overlap, ...parsedTarget };
}

function parseDraftSession(body: Record<string, unknown>, type: GitTriggerType):
  Pick<TriggerDraft, 'sessionMode' | 'pinnedSessionId' | 'sessionKey'> | { error: string } {
  const sessionModeRaw = normalizeString(body.session_mode ?? body.sessionMode);
  if (
    sessionModeRaw &&
    !(GIT_TRIGGER_SESSION_MODES as readonly string[]).includes(sessionModeRaw)
  ) {
    return {
      error: `session_mode must be one of ${GIT_TRIGGER_SESSION_MODES.map((m) => `"${m}"`).join(', ')}`,
    };
  }
  // Declaring a `session_key` IS the opt-in to keyed sessions — requiring both
  // it and `session_mode: keyed` was redundant. An explicit mode still wins, so
  // `session_mode: fresh` + a stray key stays fresh (and nulls the key below).
  const sessionKeyRaw = normalizeString(body.session_key ?? body.sessionKey);

  const sessionMode: GitTriggerSessionMode = sessionModeRaw
    ? (sessionModeRaw as GitTriggerSessionMode)
    : sessionKeyRaw
      ? 'keyed'
      : defaultTriggerSessionMode(type);
  const pinnedSessionIdRaw = normalizeString(body.session_id ?? body.sessionId);
  if (sessionMode === 'pinned' && !pinnedSessionIdRaw) {
    return { error: 'session_mode "pinned" requires a session_id to pin the trigger to' };
  }
  const pinnedSessionId: string | null =
    sessionMode === 'pinned' ? (pinnedSessionIdRaw ?? null) : null;

  // An EXPLICIT keyed mode with no key is still an error — nothing to bucket by.
  if (sessionMode === 'keyed' && !sessionKeyRaw) {
    return {
      error:
        'session_mode "keyed" requires a session_key template (e.g. "{{ body.data.chat_jid }}")',
    };
  }
  const sessionKey: string | null = sessionMode === 'keyed' ? (sessionKeyRaw ?? null) : null;
  return { sessionMode, pinnedSessionId, sessionKey };
}

type DraftCommon = Pick<TriggerDraft, 'slug' | 'name' | 'agent' | 'model' | 'enabled' | 'promptTemplate' | 'sessionMode' | 'pinnedSessionId' | 'sessionKey' | 'filter'>;

function parseEventDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
  const event = parseEventFields(body, 'event_config');
  if ('error' in event) return { error: event.error };
  return {
    ...common,
    type: 'event',
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    event,
  };
}

function parseAppDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
  const parsed = parseAppField(body);
  if ('error' in parsed) return parsed;
  return {
    ...common,
    type: 'app',
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv: null,
    app: parsed.app,
  };
}

function parseCronDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
    const timezone = normalizeString(body.timezone) ?? 'UTC';
    const timezoneError = validateTriggerTimezone(timezone);
    if (timezoneError) return { error: timezoneError };
    const every = parseEvery(body);
    if ('error' in every) return every;
    const runAtRaw = normalizeString(body.run_at ?? body.runAt);
    if (every.everySeconds !== undefined) {
      if (runAtRaw || normalizeString(body.cron ?? body.schedule)) return { error: 'declare one of cron, run_at or every' };
      return {
        ...common, type: 'cron', cron: null, runAt: null, timezone, secretEnv: null,
        everySeconds: every.everySeconds,
      };
    }
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return { error: `run_at must be an ISO-8601 datetime (got "${runAtRaw}")` };
      }
      return {
        ...common,
        type: 'cron',
        cron: null,
        runAt: new Date(parsed).toISOString(),
        timezone,
        secretEnv: null,
      };
    }
    const cron = normalizeString(body.cron ?? body.schedule);
    if (!cron)
      return { error: 'cron triggers must declare a `cron` expression, an `every` period, or a one-off `run_at`' };
    const cronError = validateTriggerCron(cron, timezone) ?? cronIntervalError(cron, timezone);
    if (cronError) return { error: cronError };
    return {
      ...common,
      type: 'cron',
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
    };
}

function parseWebhookDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
  const secretEnv = normalizeString(body.secret_env ?? body.secretEnv);
  if (!secretEnv) return { error: 'webhook triggers must declare `secret_env`' };
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return { error: `secret_env must look like a project_secrets name (got "${secretEnv}")` };
  }
  return {
    ...common,
    type: 'webhook',
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */

export function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  // Event and app triggers reject cron wiring outright.
  const noCronWiring = spec.type === 'event' || spec.type === 'app';
  return {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    model: spec.model,
    enabled: spec.enabled,
    prompt_template: spec.promptTemplate,
    cron: spec.cron,
    // Carry the one-off instant too, or a PATCH that touches anything else on a
    // `run_at` trigger would drop its schedule and fail re-validation ("cron
    // triggers must declare a `cron` expression or a one-off `run_at`").
    run_at: spec.runAt,
    every: spec.everySeconds ? formatDurationSeconds(spec.everySeconds) : null,
    // An event/app trigger rejects cron wiring outright, so its merge body must carry the
    // implicit 'UTC' as null — re-parsing the splat would otherwise fail on the
    // timezone the spec only holds as a placeholder.
    timezone: noCronWiring ? null : spec.timezone,
    secret_env: spec.secretEnv,
    max_lateness: spec.maxLatenessSeconds ? formatDurationSeconds(spec.maxLatenessSeconds) : null,
    // Kept on PATCH, like max_lateness: an edit of any other field keeps the caps.
    max_runs_per_hour: spec.maxRunsPerHour ?? null,
    max_runs_per_day: spec.maxRunsPerDay ?? null,
    overlap: spec.overlap ?? null,
    session_mode: spec.sessionMode,
    session_id: spec.pinnedSessionId,
    session_key: spec.sessionKey,
    filter: spec.filter,
    // Event keys only for an event trigger: a non-event body must not carry them.
    ...(spec.event
      ? { connector: spec.event.connector, event_account: spec.event.account ?? null, event_source: spec.event.source ?? null, event: spec.event.type, event_config: spec.event.config }
      : {}),
    ...(spec.type === 'app' ? { app: spec.app ?? null } : {}),
    // Kept on PATCH like the caps; `target: null` in a PATCH body clears it.
    target: spec.target ?? null,
  };
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'trigger'
  );
}

export function draftToSpec(
  draft: TriggerDraft,
  manifestPath: string = MANIFEST_FILENAME,
): GitTriggerSpec {
  return {
    slug: draft.slug,
    // Use the ACTUAL manifest path so a YAML project's trigger spec reports
    // `kortix.yaml#triggers.<slug>`, not a hardcoded `kortix.toml#…`.
    path: `${manifestPath}#triggers.${draft.slug}`,
    name: draft.name,
    type: draft.type,
    agent: draft.agent,
    model: draft.model,
    enabled: draft.enabled,
    promptTemplate: draft.promptTemplate,
    cron: draft.cron,
    runAt: draft.runAt,
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
    ...(draft.maxLatenessSeconds ? { maxLatenessSeconds: draft.maxLatenessSeconds } : {}),
    ...(draft.maxRunsPerHour ? { maxRunsPerHour: draft.maxRunsPerHour } : {}),
    ...(draft.maxRunsPerDay ? { maxRunsPerDay: draft.maxRunsPerDay } : {}),
    ...(draft.overlap ? { overlap: draft.overlap } : {}),
    event: draft.event,
    ...(draft.type === 'app' ? { app: draft.app ?? null } : {}),
    ...(draft.target ? { target: draft.target } : {}),
    ...(draft.everySeconds ? { everySeconds: draft.everySeconds } : {}),
    sessionMode: draft.sessionMode,
    pinnedSessionId: draft.pinnedSessionId,
    sessionKey: draft.sessionKey,
    filter: draft.filter,
  };
}
