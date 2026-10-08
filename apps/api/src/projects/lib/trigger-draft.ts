import type { TriggerList } from '@kortix/api-contract';
import { connectors, projectTriggerRuntime } from '@kortix/db';
import { cronIntervalError, formatDurationSeconds } from '@kortix/manifest-schema';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../shared/db';
import * as store from '../trigger-events/store';
import { ensureProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { validateTriggerCron, validateTriggerTimezone } from '../trigger-schedule';
import { GIT_TRIGGER_SESSION_MODES, type GitMonitorMode, type GitTriggerEventFields, type GitTriggerSessionMode, type GitTriggerSpec, type GitTriggerType, type LoadedTriggers, MANIFEST_FILENAME, type ParsedManifest, defaultTriggerSessionMode, eventOnlyKeyError, extractTriggers, parseEventFields, parseMonitorFields, readManifest, triggerSpecToTomlEntry } from '../triggers';
import { PRIVATE_TRIGGER_SESSION_ACCESS, loadTriggerSessionAccessMap } from '../trigger-session-access';
import { withProjectGitAuth } from './git';
import { type ProjectRow, deriveKortixApiRoot, normalizeBoolean, normalizeString } from './serializers';
import { isPlainObject } from '../../shared/json';
import { triggersPausedForProject } from './trigger-scheduler-state';

// GET /v1/projects

export function buildPublicWebhookUrl(projectId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */

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
  const eventConnectors = await loadEventConnectorInfo(projectId, specs);
  const subscriptionBySlug = new Map(
    specs.some((spec) => spec.event) ? (await store.listByProject(projectId)).map((r) => [r.slug, r]) : [],
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
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      run: spec.run,
      mode: spec.monitorMode,
      interval_seconds: spec.intervalSeconds,
      expect_event_within_seconds: spec.expectEventWithinSeconds,
      event: spec.event
        ? {
            connector: spec.event.connector,
            type: spec.event.type,
            config: spec.event.config,
            provider: eventConnectors.get(spec.event.connector)?.provider ?? null,
            app: eventConnectors.get(spec.event.connector)?.app ?? null,
            ...eventStatusFor(subscriptionBySlug.get(spec.slug)),
          }
        : null,
      prompt_template: spec.promptTemplate,
      session_mode: spec.sessionMode,
      session_id: spec.pinnedSessionId,
      session_key: spec.sessionKey,
      filter: spec.filter,
      session_access: sessionAccessBySlug.get(spec.slug) ?? PRIVATE_TRIGGER_SESSION_ACCESS,
      last_fired_at: runtimeBySlug.get(spec.slug)?.lastFiredAt?.toISOString() ?? null,
      last_status: runtimeBySlug.get(spec.slug)?.lastStatus ?? null,
      last_error: runtimeBySlug.get(spec.slug)?.lastError ?? null,
      last_attempt_at: runtimeBySlug.get(spec.slug)?.lastAttemptAt?.toISOString() ?? null,
      // The slot the scheduler claims next, jitter included (KRTX-1743).
      next_fire_at: runtimeBySlug.get(spec.slug)?.nextFireAt?.toISOString() ?? null,
      webhook_url: spec.type === 'webhook' ? buildPublicWebhookUrl(projectId, spec.slug) : null,
    })),
    // Server-side activation state for this project's whole trigger set. When
    // true, the platform won't auto-run any of them (cron sweep skips, webhooks
    // ignored), regardless of each trigger's own `enabled`.
    triggers_paused: triggersPausedForProject(project.metadata),
    errors,
  };
}

/** provider + app of each connector an event trigger names (null when the connector is not declared). */
async function loadEventConnectorInfo(
  projectId: string,
  specs: GitTriggerSpec[],
): Promise<Map<string, { provider: string; app: string | null }>> {
  const slugs = [...new Set(specs.flatMap((spec) => (spec.event ? [spec.event.connector] : [])))];
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ slug: connectors.slug, provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), inArray(connectors.slug, slugs)));
  return new Map(
    rows.map((row) => {
      const app = (row.config as Record<string, unknown> | null)?.app;
      return [row.slug, { provider: row.provider, app: typeof app === 'string' ? app : null }];
    }),
  );
}

/** Subscription state of one event trigger for the list response; `pending` = no subscription row yet. */
export function eventStatusFor(row: store.EventSubscriptionRow | undefined): {
  status: 'active' | 'needs_connection' | 'error' | 'pending';
  error: string | null;
  last_event_at: string | null;
} {
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
  /** For type=monitor only — the repo-relative command the box supervises. */
  run: string | null;
  /** For type=monitor only — `poll` (run on interval) or `stream` (long-running). */
  monitorMode: GitMonitorMode | null;
  /** For `monitorMode === 'poll'` only — the poll period, in whole seconds. */
  intervalSeconds: number | null;
  /** For type=monitor only — the silence watchdog, in whole seconds. */
  expectEventWithinSeconds: number | null;
  /** For type=event only — connector, provider event type and event config. */
  event?: GitTriggerEventFields | null;
  sessionMode: GitTriggerSessionMode;
  /** For sessionMode === 'pinned' only: the exact session id to loop. */
  pinnedSessionId: string | null;
  /** For sessionMode === 'keyed' only: the template deriving one session per key. */
  sessionKey: string | null;
  /** Payload paths that must match for a delivery to fire. Null when unfiltered. */
  filter: Record<string, string> | null;
}

export function parseTriggerDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  const rawSlug = normalizeString(body.slug);
  const name = normalizeString(body.name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const typeRaw = normalizeString(body.type);
  const type: GitTriggerType | null =
    typeRaw === 'webhook' || typeRaw === 'cron' || typeRaw === 'monitor' || typeRaw === 'event'
      ? typeRaw
      : null;
  if (!type) return { error: 'type must be "cron", "webhook", "monitor", or "event"' };
  if (type !== 'event') {
    const bad = eventOnlyKeyError(body, 'event_config', type);
    if (bad) return { error: bad };
  }

  const promptTemplate = normalizeString(
    body.prompt_template ?? body.promptTemplate,
  );
  if (!promptTemplate) return { error: 'prompt_template is required' };

  const agent = normalizeString(body.agent ?? body.agent_name) ?? 'default';
  // null/empty model = "Default" — leave it to the resolution chain at fire time.
  const model = normalizeString(body.model) ?? null;
  const enabled = normalizeBoolean(body.enabled) ?? true;

  const session = parseDraftSession(body, type);
  if ('error' in session) return session;
  const { sessionMode, pinnedSessionId, sessionKey } = session;
  const parsedFilter = parseDraftFilter(body.filter);
  if ('error' in parsedFilter) return parsedFilter;
  const { filter } = parsedFilter;

  const common = { slug, name, agent, model, enabled, promptTemplate, sessionMode, pinnedSessionId, sessionKey, filter };
  if (type === 'event') return parseEventDraft(body, common);
  if (type === 'monitor') return parseMonitorDraft(body, common);
  if (type === 'cron') return parseCronDraft(body, common);
  return parseWebhookDraft(body, common);
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

function parseDraftFilter(filterRaw: unknown): { filter: TriggerDraft['filter'] } | { error: string } {
  let filter: Record<string, string> | null = null;
  if (filterRaw !== undefined && filterRaw !== null) {
    if (!isPlainObject(filterRaw)) {
      return { error: 'filter must be an object mapping payload paths to expected values' };
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(filterRaw)) {
      const trimmed = key.trim();
      if (!trimmed) return { error: 'filter keys must be non-empty payload paths' };
      if (value === null || typeof value === 'object') {
        return { error: `filter.${trimmed} must be a string, number, or boolean` };
      }
      entries[trimmed] = String(value);
    }
    if (Object.keys(entries).length > 0) filter = entries;
  }

  return { filter };
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
    run: null,
    monitorMode: null,
    intervalSeconds: null,
    expectEventWithinSeconds: null,
    event,
  };
}

function parseMonitorDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
    const monitor = parseMonitorFields(body);
    if ('error' in monitor) return { error: monitor.error };
    return {
      ...common,
      type: 'monitor',
      cron: null,
      runAt: null,
      timezone: 'UTC',
      secretEnv: null,
      run: monitor.run,
      monitorMode: monitor.monitorMode,
      intervalSeconds: monitor.intervalSeconds,
      expectEventWithinSeconds: monitor.expectEventWithinSeconds,
    };
}

function parseCronDraft(body: Record<string, unknown>, common: DraftCommon): TriggerDraft | { error: string } {
    const timezone = normalizeString(body.timezone) ?? 'UTC';
    const timezoneError = validateTriggerTimezone(timezone);
    if (timezoneError) return { error: timezoneError };
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    const runAtRaw = normalizeString(body.run_at ?? body.runAt);
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
        run: null,
        monitorMode: null,
        intervalSeconds: null,
        expectEventWithinSeconds: null,
      };
    }
    const cron = normalizeString(body.cron ?? body.schedule);
    if (!cron)
      return { error: 'cron triggers must declare a `cron` expression or a one-off `run_at`' };
    const cronError = validateTriggerCron(cron, timezone) ?? cronIntervalError(cron, timezone);
    if (cronError) return { error: cronError };
    return {
      ...common,
      type: 'cron',
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
      run: null,
      monitorMode: null,
      intervalSeconds: null,
      expectEventWithinSeconds: null,
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
    run: null,
    monitorMode: null,
    intervalSeconds: null,
    expectEventWithinSeconds: null,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */

export function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  // Monitor and event triggers reject cron wiring outright.
  const noCronWiring = spec.type === 'monitor' || spec.type === 'event';
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
    // A monitor/event rejects cron wiring outright, so its merge body must carry the
    // implicit 'UTC' as null — re-parsing the splat would otherwise fail on the
    // timezone the spec only holds as a placeholder.
    timezone: noCronWiring ? null : spec.timezone,
    secret_env: spec.secretEnv,
    run: spec.run,
    mode: spec.monitorMode,
    interval:
      spec.intervalSeconds === null ? null : formatDurationSeconds(spec.intervalSeconds),
    expect_event_within:
      spec.expectEventWithinSeconds === null
        ? null
        : formatDurationSeconds(spec.expectEventWithinSeconds),
    session_mode: spec.sessionMode,
    session_id: spec.pinnedSessionId,
    session_key: spec.sessionKey,
    filter: spec.filter,
    // Event keys only for an event trigger: a non-event body must not carry them.
    ...(spec.event
      ? { connector: spec.event.connector, event: spec.event.type, event_config: spec.event.config }
      : {}),
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
    run: draft.run,
    monitorMode: draft.monitorMode,
    intervalSeconds: draft.intervalSeconds,
    expectEventWithinSeconds: draft.expectEventWithinSeconds,
    event: draft.event,
    sessionMode: draft.sessionMode,
    pinnedSessionId: draft.pinnedSessionId,
    sessionKey: draft.sessionKey,
    filter: draft.filter,
  };
}
