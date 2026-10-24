import { BoundedMap } from '../shared/bounded-map';
import {
  EVENT_FORBIDDEN_KEYS,
  TRIGGER_MIN_MAX_LATENESS_SECONDS,
  formatDurationSeconds,
  parseDurationSeconds,
  parseTriggerFilter,
} from '@kortix/manifest-schema';
import { isPlainObject } from '../shared/json';
import type { GitBackedProject } from './git';
import { MANIFEST_FILENAME, readManifest } from './manifest-io';
import { validateTriggerCron, validateTriggerTimezone } from './trigger-schedule';
import {
  GIT_TRIGGER_SESSION_MODES,
  type GitTriggerEventFields,
  type GitTriggerParseError,
  type GitTriggerSessionMode,
  type GitTriggerSpec,
  type GitTriggerType,
  type LoadedTriggers,
  type ParsedManifest,
  defaultTriggerSessionMode,
} from './trigger-types';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;


/**
 * Parse + validate the `type: event` fields off a manifest entry (`config` key)
 * or a CRUD body (`event_config` key). Mirrors `@kortix/manifest-schema`'s
 * `validateEventTrigger`. Cron/webhook/monitor wiring is a hard error. The
 * provider validates `config` against the event's JSON schema at subscribe time.
 */
export function parseEventFields(
  row: Record<string, unknown>,
  configKey: 'config' | 'event_config',
): GitTriggerEventFields | { error: string } {
  const connector = typeof row.connector === 'string' ? row.connector.trim() : '';
  if (!connector) return { error: 'event triggers must declare a `connector`' };
  const type = typeof row.event === 'string' ? row.event.trim() : '';
  if (!type) return { error: 'event triggers must declare an `event`' };
  const configRaw = row[configKey];
  if (configRaw !== undefined && configRaw !== null && !isPlainObject(configRaw)) {
    return { error: `${configKey} must be an object` };
  }
  for (const key of EVENT_FORBIDDEN_KEYS) {
    if (row[key] !== undefined && row[key] !== null) {
      return { error: `${key} is not valid on an event trigger — events are driven by the connected app` };
    }
  }
  const accountRaw = row[configKey === 'config' ? 'account' : 'event_account'];
  if (accountRaw !== undefined && accountRaw !== null && (typeof accountRaw !== 'string' || !accountRaw.trim())) {
    return { error: 'account must be the label of a shared account on the connector' };
  }
  const sourceRaw = row[configKey === 'config' ? 'source' : 'event_source'];
  if (sourceRaw !== undefined && sourceRaw !== null && (typeof sourceRaw !== 'string' || !sourceRaw.trim())) {
    return { error: 'source must be the event source adapter id, such as "composio"' };
  }
  // Omitted (not null) when unset, so an event's schedule revision stays what it was before `account` and `source` existed.
  const account = typeof accountRaw === 'string' ? accountRaw.trim() : '';
  const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : '';
  return { connector, ...(account ? { account } : {}), ...(source ? { source } : {}), type, config: (configRaw as Record<string, unknown> | undefined | null) ?? {} };
}

/** connector/account/source/event/config belong to event triggers only; returns the error text or null. */
export function eventOnlyKeyError(
  row: Record<string, unknown>,
  configKey: 'config' | 'event_config',
  type: string,
): string | null {
  const prefixed = configKey !== 'config';
  for (const key of ['connector', prefixed ? 'event_account' : 'account', prefixed ? 'event_source' : 'source', 'event', configKey]) {
    if (row[key] !== undefined && row[key] !== null) {
      return `${key} is only valid on an event trigger (type is "${type}")`;
    }
  }
  return null;
}

const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What a `type: monitor` entry answers since the monitor box was removed. */
export const MONITOR_REMOVED =
  'monitor triggers were removed. Run the watcher in an App (a process that POSTs to $KORTIX_APP_EVENTS_URL) and fire with a `type: app` trigger, or poll with a cron trigger whose `target` is the App';

/**
 * The `type: app` field: the slug of the App whose events fire the trigger.
 * Every other type's wiring is a hard error. Mirrors `@kortix/manifest-schema`'s
 * `validateAppTrigger`.
 */
export function parseAppField(row: Record<string, unknown>): { app: string } | { error: string } {
  const app = typeof row.app === 'string' ? row.app.trim() : '';
  if (!APP_SLUG_RE.test(app)) return { error: 'app triggers must declare `app`: the slug of an App in this project' };
  for (const key of EVENT_FORBIDDEN_KEYS) {
    if (row[key] !== undefined && row[key] !== null) {
      return { error: `${key} is not valid on an app trigger — the App decides when to emit` };
    }
  }
  return { app };
}

/** The smallest `every` period: one minute, the cron floor. */
export const TRIGGER_MIN_EVERY_SECONDS = 60;

/** A schedule's `every: 5m` (cron type only), in whole seconds. Absent → `{}`. */
export function parseEvery(row: Record<string, unknown>): { everySeconds?: number } | { error: string } {
  if (row.every === undefined || row.every === null) return {};
  const parsed = parseMonitorDuration(row.every, 'every', TRIGGER_MIN_EVERY_SECONDS);
  return 'error' in parsed ? parsed : { everySeconds: parsed.seconds };
}

/**
 * `target: { app, path?, method? }`: a fire calls an App instead of running an
 * agent. Absent → `{}`, so a spec without it keeps its shape and revision.
 * A monitor runs its own command and takes no target.
 */
export function parseTargetField(
  row: Record<string, unknown>,
  type: GitTriggerType,
): { target?: NonNullable<GitTriggerSpec['target']> } | { error: string } {
  const raw = row.target;
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) return { error: 'target must be an object: { app, path, method }' };
  const { app, path = '/', method = 'POST', payload, ...rest } = raw as Record<string, unknown>;
  const unknown = Object.keys(rest)[0];
  if (unknown) return { error: `target.${unknown} is not a target field (app, path, method, payload)` };
  if (payload !== undefined && (!isPlainObject(payload) || JSON.stringify(payload).length > 64 * 1024)) {
    return { error: 'target.payload must be an object of at most 64 KiB' };
  }
  if (typeof app !== 'string' || !APP_SLUG_RE.test(app.trim())) return { error: 'target.app must be the slug of an App in this project' };
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path) || path.length > 2048) return { error: 'target.path must be an HTTP path starting with /' };
  if (method !== 'POST' && method !== 'GET') return { error: 'target.method must be POST or GET' };
  return { target: { app: app.trim(), path, method, ...(payload ? { payload: payload as Record<string, unknown> } : {}) } };
}

/**
 * A cron trigger's `max_lateness` (KRTX-1743): the misfire bound. Absent → `{}`,
 * so a spec without it keeps its shape and schedule revision. Mirrors
 * `@kortix/manifest-schema`'s rule: cron only, at least 60s.
 */
export function parseMaxLateness(
  row: Record<string, unknown>,
  type: GitTriggerType,
): { maxLatenessSeconds?: number } | { error: string } {
  const raw = row.max_lateness;
  if (raw === undefined || raw === null) return {};
  if (type !== 'cron') return { error: 'max_lateness is only valid on a cron trigger' };
  const parsed = parseMonitorDuration(raw, 'max_lateness', TRIGGER_MIN_MAX_LATENESS_SECONDS);
  return 'error' in parsed ? parsed : { maxLatenessSeconds: parsed.seconds };
}

/**
 * A trigger's run caps (KRTX-1721): `max_runs_per_hour` and `max_runs_per_day`,
 * any type. Absent → omitted, so a spec without them keeps its shape and
 * schedule revision. Mirrors `@kortix/manifest-schema`: a whole number ≥ 1.
 */
export function parseRunCaps(
  row: Record<string, unknown>,
): { maxRunsPerHour?: number; maxRunsPerDay?: number } | { error: string } {
  const caps: { maxRunsPerHour?: number; maxRunsPerDay?: number } = {};
  for (const [field, key] of [['max_runs_per_hour', 'maxRunsPerHour'], ['max_runs_per_day', 'maxRunsPerDay']] as const) {
    const raw = row[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      return { error: `${field} must be a whole number of at least 1` };
    }
    caps[key] = raw;
  }
  return caps;
}

/**
 * A trigger's `overlap` (KRTX-1721): `skip` or `allow`. Absent → omitted, and
 * the default applies (`skip` for cron, `allow` otherwise). It acts on fresh
 * session mode only (`lib/trigger-overlap.ts`).
 */
export function parseOverlap(row: Record<string, unknown>): { overlap?: 'skip' | 'allow' } | { error: string } {
  const raw = row.overlap;
  if (raw === undefined || raw === null) return {};
  if (raw !== 'skip' && raw !== 'allow') return { error: 'overlap must be "skip" or "allow"' };
  return { overlap: raw };
}

function parseMonitorDuration(
  value: unknown,
  field: string,
  floorSeconds: number,
): { seconds: number } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${field} must be a duration string like "30s", "5m", "24h", or "7d"` };
  }
  const seconds = parseDurationSeconds(value);
  if (seconds === null) {
    return {
      error: `${field} must be a positive integer plus s/m/h/d (got "${value}")`,
    };
  }
  if (seconds < floorSeconds) {
    return { error: `${field} must be at least ${floorSeconds}s (got "${value}")` };
  }
  return { seconds };
}

/* ─── Trigger extraction ────────────────────────────────────────────────── */

/**
 * Parse the `[[triggers]]` array out of a loaded manifest, validating each
 * entry. Never throws — bad entries land in `errors` with a slug + reason
 * so the UI can render them alongside the good ones.
 */
export function extractTriggers(manifest: ParsedManifest): LoadedTriggers {
  const filename = manifest.path || MANIFEST_FILENAME;
  const rawTriggers = manifest.raw.triggers;
  if (rawTriggers === undefined || rawTriggers === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(rawTriggers)) {
    return {
      specs: [],
      errors: [
        {
          slug: '(top-level)',
          path: filename,
          error:
            manifest.format === 'yaml'
              ? '`triggers` must be a list — write it as a YAML `triggers:` list, not a map or scalar.'
              : '`triggers` must be an array of tables — use [[triggers]], not [triggers]',
        },
      ],
    };
  }

  const specs: GitTriggerSpec[] = [];
  const errors: GitTriggerParseError[] = [];
  const seenSlugs = new Set<string>();

  rawTriggers.forEach((entry, index) => {
    // With `imports:`, report the file that declares the trigger, so the UI and
    // every error message point at the file the author has to open.
    const slug = (entry as { slug?: unknown } | null)?.slug;
    const declaredIn =
      (typeof slug === 'string' ? manifest.imports?.origins.triggers[slug] : undefined) ?? filename;
    const result = parseTriggerEntry(entry, index, declaredIn);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seenSlugs.has(result.spec.slug)) {
      errors.push({
        slug: result.spec.slug,
        path: result.spec.path,
        error: `Duplicate trigger slug "${result.spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    seenSlugs.add(result.spec.slug);
    specs.push(result.spec);
  });

  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Walk a project: read its manifest, extract triggers. Convenience for
 * callers that don't otherwise need the parsed manifest. Returns empty
 * arrays + a single top-level error when the manifest fails to parse —
 * never throws.
 */
export async function loadProjectTriggers(
  project: GitBackedProject,
  opts?: { forceRefresh?: boolean },
): Promise<LoadedTriggers> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project, { forceRefresh: opts?.forceRefresh });
  } catch (err) {
    // The manifest failed to parse before we learned which candidate file it
    // actually was (.yaml/.yml/.toml) — fall back to the project's configured
    // manifestPath (best-effort; may be stale for a project that switched
    // format by hand without updating it) rather than always naming kortix.toml.
    return {
      specs: [],
      errors: [
        {
          slug: '(manifest)',
          path: project.manifestPath || MANIFEST_FILENAME,
          error: (err as Error).message || 'Failed to read manifest',
        },
      ],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractTriggers(manifest);
}

function forcedTriggerRefreshCooldownMs(): number {
  const value = Number(process.env.KORTIX_GIT_REFRESH_INTERVAL_MS || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

const lastForcedTriggerRefreshAt = new BoundedMap<string, number>(5_000);

/**
 * Resolve one trigger for an action endpoint. A trigger can be absent from one
 * API replica's mirror for up to the normal refresh interval after another
 * replica commits it. Refresh once before returning a definitive miss.
 */
export async function findProjectTriggerBySlug(
  project: GitBackedProject,
  slug: string,
): Promise<GitTriggerSpec | null> {
  const cached = await loadProjectTriggers(project);
  const cachedSpec = cached.specs.find((spec) => spec.slug === slug);
  if (cachedSpec) return cachedSpec;

  const now = Date.now();
  const lastForcedAt = lastForcedTriggerRefreshAt.get(project.projectId) ?? 0;
  if (now - lastForcedAt < forcedTriggerRefreshCooldownMs()) return null;

  lastForcedTriggerRefreshAt.set(project.projectId, now);
  const refreshed = await loadProjectTriggers(project, { forceRefresh: true });
  return refreshed.specs.find((spec) => spec.slug === slug) ?? null;
}

/* ─── Trigger ↔ manifest-entry conversion ───────────────────────────────── */

/**
 * Convert a TriggerSpec back to the raw object that goes into the `triggers`
 * array — the shape is format-agnostic (same object serializes to either a
 * kortix.yaml list entry or a legacy kortix.toml `[[triggers]]` table).
 * Inverse of `parseTriggerEntry`. Used by the CRUD path to write back to the
 * project manifest after a UI edit.
 */
export function triggerSpecToTomlEntry(spec: GitTriggerSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
  };
  // Only emit model when set so manifests on the "Default" path stay byte-stable.
  if (spec.model) entry.model = spec.model;
  entry.enabled = spec.enabled;
  // Only when set, like model: an uncapped manifest stays byte-stable.
  if (spec.maxRunsPerHour) entry.max_runs_per_hour = spec.maxRunsPerHour;
  if (spec.maxRunsPerDay) entry.max_runs_per_day = spec.maxRunsPerDay;
  if (spec.overlap) entry.overlap = spec.overlap;
  // `keyed` is written as `session_key` alone: the key implies the mode on read
  // (see parseTriggerEntry), so emitting both would be redundant in the file a
  // human actually reads. It also keeps the manifest valid against the
  // `session_mode` enum in @kortix/manifest-schema, which the `kortix validate`
  // / CR-merge gate gets to before it learns about new modes.
  const keyedByKey = spec.sessionMode === 'keyed' && !!spec.sessionKey;
  // Only emit session_mode when it deviates from this type's default ('fresh'
  // for cron/webhook, 'reuse' for a monitor) so existing manifests stay
  // byte-stable on round-trip.
  if (spec.sessionMode !== defaultTriggerSessionMode(spec.type) && !keyedByKey) {
    entry.session_mode = spec.sessionMode;
  }
  // `pinned` carries the exact session id to loop.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    entry.session_id = spec.pinnedSessionId;
  }
  // `keyed` carries the template that derives one session per key.
  if (keyedByKey) {
    entry.session_key = spec.sessionKey;
  }
  if (spec.filter && Object.keys(spec.filter).length > 0) {
    entry.filter = spec.filter;
  }
  if (spec.type === 'cron') {
    if (spec.runAt) {
      entry.run_at = spec.runAt;
    } else if (spec.everySeconds) {
      entry.every = formatDurationSeconds(spec.everySeconds);
    } else {
      entry.cron = spec.cron ?? '';
    }
    entry.timezone = spec.timezone;
    if (spec.maxLatenessSeconds) entry.max_lateness = formatDurationSeconds(spec.maxLatenessSeconds);
  } else if (spec.type === 'event' && spec.event) {
    entry.connector = spec.event.connector;
    if (spec.event.account) entry.account = spec.event.account;
    if (spec.event.source) entry.source = spec.event.source;
    entry.event = spec.event.type;
    if (Object.keys(spec.event.config).length > 0) entry.config = spec.event.config;
  } else if (spec.type === 'app' && spec.app) {
    entry.app = spec.app;
  } else if (spec.secretEnv) {
    entry.secret_env = spec.secretEnv;
  }
  if (spec.target) entry.target = spec.target;
  if (spec.promptTemplate) entry.prompt = spec.promptTemplate;
  return entry;
}

interface ParseOk {
  ok: true;
  spec: GitTriggerSpec;
}
interface ParseErr {
  ok: false;
  error: GitTriggerParseError;
}

function parseTriggerEntry(
  entry: unknown,
  index: number,
  filename: string = MANIFEST_FILENAME,
): ParseOk | ParseErr {
  const err = (slug: string, message: string): ParseErr =>
    makeTriggerError(slug, message, filename);

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[triggers]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[triggers]] entry #${index + 1} is missing a slug`);
  if (!SLUG_RE.test(slug)) {
    return err(
      slug,
      `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`,
    );
  }

  const typeRaw = typeof row.type === 'string' ? row.type.trim() : '';
  if (typeRaw === 'monitor') return err(slug, MONITOR_REMOVED);
  if (
    typeRaw !== 'cron' &&
    typeRaw !== 'webhook' &&
    typeRaw !== 'event' &&
    typeRaw !== 'app'
  ) {
    return err(
      slug,
      `type must be "cron", "webhook", "event", or "app" (got "${typeRaw || 'unset'}")`,
    );
  }
  const type = typeRaw as GitTriggerType;
  const lateness = parseMaxLateness(row, type);
  if ('error' in lateness) return err(slug, lateness.error);
  const caps = parseRunCaps(row);
  if ('error' in caps) return err(slug, caps.error);
  const overlap = parseOverlap(row);
  if ('error' in overlap) return err(slug, overlap.error);
  if (type !== 'event') {
    const bad = eventOnlyKeyError(row, 'config', type);
    if (bad) return err(slug, bad);
  }
  if (type !== 'app' && row.app !== undefined && row.app !== null) {
    return err(slug, `app is only valid on an app trigger (type is "${type}")`);
  }
  if (type !== 'cron' && row.every !== undefined && row.every !== null) {
    return err(slug, `every is only valid on a cron trigger (type is "${type}")`);
  }

  const prompt =
    typeof row.prompt === 'string'
      ? row.prompt
      : typeof row.prompt_template === 'string'
        ? row.prompt_template
        : '';
  const parsedTarget = parseTargetField(row, type);
  if ('error' in parsedTarget) return err(slug, parsedTarget.error);
  // An App target receives the payload, not a prompt.
  if (!prompt.trim() && !parsedTarget.target) {
    return err(slug, 'prompt is required and may not be empty');
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug;
  const agent =
    typeof row.agent === 'string' && row.agent.trim()
      ? row.agent.trim()
      : typeof row.agent_name === 'string' && row.agent_name.trim()
        ? row.agent_name.trim()
        : 'default';
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null;
  const enabled = coerceBool(row.enabled, true);

  const sessionModeRaw =
    typeof row.session_mode === 'string'
      ? row.session_mode.trim().toLowerCase()
      : typeof row.sessionMode === 'string'
        ? row.sessionMode.trim().toLowerCase()
        : '';
  if (
    sessionModeRaw &&
    !(GIT_TRIGGER_SESSION_MODES as readonly string[]).includes(sessionModeRaw)
  ) {
    return err(
      slug,
      `session_mode must be one of ${GIT_TRIGGER_SESSION_MODES.map((m) => `"${m}"`).join(', ')} (got "${sessionModeRaw}")`,
    );
  }
  // `keyed` carries the template that derives one session per key
  // (manifest key `session_key`). Read BEFORE resolving the mode: declaring a
  // `session_key` is itself the opt-in, so `session_mode: keyed` is redundant
  // noise a manifest never has to write. An EXPLICIT mode always wins, so
  // `session_mode: fresh` + a stray key stays fresh (and drops the key below).
  const sessionKeyRaw =
    typeof row.session_key === 'string'
      ? row.session_key.trim()
      : typeof row.sessionKey === 'string'
        ? row.sessionKey.trim()
        : '';

  const sessionMode: GitTriggerSessionMode = sessionModeRaw
    ? (sessionModeRaw as GitTriggerSessionMode)
    : sessionKeyRaw
      ? 'keyed'
      : defaultTriggerSessionMode(type);

  // `pinned` carries the exact session id to loop (manifest key `session_id`).
  const pinnedSessionIdRaw =
    typeof row.session_id === 'string'
      ? row.session_id.trim()
      : typeof row.sessionId === 'string'
        ? row.sessionId.trim()
        : '';
  if (sessionMode === 'pinned' && !pinnedSessionIdRaw) {
    return err(slug, 'session_mode "pinned" requires a `session_id` to pin the trigger to');
  }
  const pinnedSessionId: string | null = sessionMode === 'pinned' ? pinnedSessionIdRaw : null;

  // An EXPLICIT `session_mode: keyed` with no key is still an error — there is
  // nothing to bucket sessions by. (The inferred path can't reach this: it only
  // resolves to `keyed` when a key is present.)
  if (sessionMode === 'keyed' && !sessionKeyRaw) {
    return err(
      slug,
      'session_mode "keyed" requires a `session_key` template (e.g. "{{ body.data.chat_jid }}")',
    );
  }
  const sessionKey: string | null = sessionMode === 'keyed' ? sessionKeyRaw : null;

  // Optional payload guard: a value (equals) or one operator per path,
  // compared as text against the delivery (`@kortix/manifest-schema`).
  const parsedFilter = parseTriggerFilter(row.filter);
  if ('error' in parsedFilter) return err(slug, parsedFilter.error);
  const { filter } = parsedFilter;

  const path = `${filename}#triggers.${slug}`;

  // The fields every branch below shares, computed once; each branch spreads
  // them and overrides only its type-specific fields.
  const base = {
    slug,
    path,
    name,
    agent,
    model,
    enabled,
    promptTemplate: prompt,
    ...parsedTarget,
    sessionMode,
    pinnedSessionId,
    sessionKey,
    filter,
    ...caps,
    ...overlap,
  };

  if (type === 'app') {
    const parsed = parseAppField(row);
    if ('error' in parsed) return err(slug, parsed.error);
    return {
      ok: true,
      spec: {
        ...base,
        type: 'app',
        cron: null,
        runAt: null,
        timezone: 'UTC',
        secretEnv: null,
        app: parsed.app,
      },
    };
  }

  if (type === 'event') {
    const event = parseEventFields(row, 'config');
    if ('error' in event) return err(slug, event.error);
    return {
      ok: true,
      spec: {
        ...base,
        type: 'event',
        cron: null,
        runAt: null,
        timezone: 'UTC',
        secretEnv: null,
        event,
      },
    };
  }

  if (type === 'cron') {
    const cron =
      typeof row.cron === 'string'
        ? row.cron.trim()
        : typeof row.schedule === 'string'
          ? row.schedule.trim()
          : '';
    const runAtRaw =
      typeof row.run_at === 'string'
        ? row.run_at.trim()
        : typeof row.runAt === 'string'
          ? row.runAt.trim()
          : '';
    const timezone =
      typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone.trim() : 'UTC';
    const timezoneError = validateTriggerTimezone(timezone);
    if (timezoneError) return err(slug, timezoneError);

    const every = parseEvery(row);
    if ('error' in every) return err(slug, every.error);
    if (every.everySeconds !== undefined) {
      if (cron || runAtRaw) return err(slug, 'declare one of cron, run_at or every');
      return {
        ok: true,
        spec: {
          ...base, type: 'cron', cron: null, runAt: null, timezone, secretEnv: null,
          ...lateness, everySeconds: every.everySeconds,
        },
      };
    }

    // A one-off ("run once") schedule carries `run_at` instead of `cron`.
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return err(slug, `run_at must be an ISO-8601 datetime (got "${runAtRaw}")`);
      }
      return {
        ok: true,
        spec: {
          ...base,
          type: 'cron',
          cron: null,
          runAt: new Date(parsed).toISOString(),
          timezone,
          secretEnv: null,
          ...lateness,
        },
      };
    }

    if (!cron)
      return err(slug, 'cron triggers must declare a `cron` expression, an `every` period, or a one-off `run_at`');
    const cronError = validateTriggerCron(cron, timezone);
    if (cronError) return err(slug, cronError);
    return {
      ok: true,
      spec: {
        ...base,
        type: 'cron',
        cron,
        runAt: null,
        timezone,
        secretEnv: null,
        ...lateness,
      },
    };
  }

  // webhook
  const secretEnv =
    typeof row.secret_env === 'string'
      ? row.secret_env.trim()
      : typeof row.secretEnv === 'string'
        ? row.secretEnv.trim()
        : '';
  if (!secretEnv) {
    return err(
      slug,
      'webhook triggers must declare `secret_env` pointing at a project_secrets entry',
    );
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return err(slug, `secret_env must look like a project_secrets name (got "${secretEnv}")`);
  }
  return {
    ok: true,
    spec: {
      ...base,
      type: 'webhook',
      cron: null,
      runAt: null,
      timezone: 'UTC',
      secretEnv,
    },
  };
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function makeTriggerError(
  slug: string,
  message: string,
  filename: string = MANIFEST_FILENAME,
): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${filename}#triggers.${slug}`, error: message },
  };
}
