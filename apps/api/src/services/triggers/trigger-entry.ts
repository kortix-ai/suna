import {
  MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
  MONITOR_MIN_INTERVAL_SECONDS,
  MONITOR_MODES,
  MONITOR_RUN_MAX_LENGTH,
  formatDurationSeconds,
  parseDurationSeconds,
} from '@kortix/manifest-schema';
import { isPlainObject } from '../../lib/json';
import type { GitBackedProject } from '../git';
import { MANIFEST_FILENAME, readManifest } from '../projects/manifest-io';
import { validateTriggerCron, validateTriggerTimezone } from './trigger-schedule';
import {
  GIT_TRIGGER_SESSION_MODES,
  type GitMonitorFields,
  type GitMonitorMode,
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
 * Parse + validate the `type: monitor` fields off a manifest entry or a CRUD
 * body. ONE implementation for both paths, mirroring
 * `@kortix/manifest-schema`'s `validateMonitorTrigger` rule for rule — the
 * write gate and the runtime reader must never disagree on what a monitor is.
 * Returns a plain error string so each caller can wrap it in its own shape.
 */
export function parseMonitorFields(
  row: Record<string, unknown>,
): GitMonitorFields | { error: string } {
  const run = typeof row.run === 'string' ? row.run.trim() : '';
  if (!run) return { error: 'monitor triggers must declare a `run` command (repo-relative)' };
  if (run.length > MONITOR_RUN_MAX_LENGTH) {
    return { error: `run must be at most ${MONITOR_RUN_MAX_LENGTH} characters` };
  }
  if (/[\r\n]/.test(run)) return { error: 'run must be a single command line — no newlines' };

  const modeRaw = typeof row.mode === 'string' ? row.mode.trim().toLowerCase() : '';
  if (!(MONITOR_MODES as readonly string[]).includes(modeRaw)) {
    return { error: `mode must be "poll" or "stream" (got "${modeRaw || 'unset'}")` };
  }
  const monitorMode = modeRaw as GitMonitorMode;

  let intervalSeconds: number | null = null;
  if (monitorMode === 'poll') {
    const parsed = parseMonitorDuration(row.interval, 'interval', MONITOR_MIN_INTERVAL_SECONDS);
    if ('error' in parsed) return parsed;
    intervalSeconds = parsed.seconds;
  } else if (row.interval !== undefined && row.interval !== null) {
    return { error: 'interval is only valid on a `mode: poll` monitor — a stream runs continuously' };
  }

  let expectEventWithinSeconds: number | null = null;
  const expectRaw = row.expect_event_within ?? row.expectEventWithin;
  if (expectRaw !== undefined && expectRaw !== null) {
    const parsed = parseMonitorDuration(
      expectRaw,
      'expect_event_within',
      MONITOR_MIN_EXPECT_EVENT_WITHIN_SECONDS,
    );
    if ('error' in parsed) return parsed;
    expectEventWithinSeconds = parsed.seconds;
  }

  // cron/webhook wiring on a monitor is a hard error, not a silent drop: a
  // manifest that claims a schedule the monitor runner never reads is a lie.
  for (const key of ['cron', 'schedule', 'run_at', 'runAt', 'timezone', 'secret_env', 'secretEnv']) {
    if (row[key] !== undefined && row[key] !== null) {
      return {
        error: `${key} is not valid on a monitor trigger — monitors are driven by their \`run\` process`,
      };
    }
  }
  return { run, monitorMode, intervalSeconds, expectEventWithinSeconds };
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

const lastForcedTriggerRefreshAt = new Map<string, number>();

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
    } else {
      entry.cron = spec.cron ?? '';
    }
    entry.timezone = spec.timezone;
  } else if (spec.type === 'monitor') {
    entry.run = spec.run ?? '';
    entry.mode = spec.monitorMode ?? '';
    // Durations re-emit in canonical form (largest whole unit) — the same
    // normalization `run_at` gets. `interval` is poll-only; a stream monitor
    // has none to write.
    if (spec.intervalSeconds !== null) entry.interval = formatDurationSeconds(spec.intervalSeconds);
    if (spec.expectEventWithinSeconds !== null) {
      entry.expect_event_within = formatDurationSeconds(spec.expectEventWithinSeconds);
    }
  } else if (spec.secretEnv) {
    entry.secret_env = spec.secretEnv;
  }
  entry.prompt = spec.promptTemplate;
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
  if (typeRaw !== 'cron' && typeRaw !== 'webhook' && typeRaw !== 'monitor') {
    return err(slug, `type must be "cron", "webhook", or "monitor" (got "${typeRaw || 'unset'}")`);
  }
  const type = typeRaw as GitTriggerType;

  const prompt =
    typeof row.prompt === 'string'
      ? row.prompt
      : typeof row.prompt_template === 'string'
        ? row.prompt_template
        : '';
  if (!prompt.trim()) {
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

  // Optional payload guard. Values are compared as strings against the rendered
  // path, so `true`/`1` in the manifest behave the same as in the payload.
  let filter: Record<string, string> | null = null;
  if (row.filter !== undefined && row.filter !== null) {
    if (!isPlainObject(row.filter)) {
      return err(slug, '`filter` must be a table of payload paths to expected values');
    }
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.filter)) {
      const trimmed = key.trim();
      if (!trimmed) return err(slug, '`filter` keys must be non-empty payload paths');
      if (value === null || typeof value === 'object') {
        return err(slug, `\`filter.${trimmed}\` must be a string, number, or boolean`);
      }
      entries[trimmed] = String(value);
    }
    if (Object.keys(entries).length > 0) filter = entries;
  }

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
    sessionMode,
    pinnedSessionId,
    sessionKey,
    filter,
  };

  if (type === 'monitor') {
    const monitor = parseMonitorFields(row);
    if ('error' in monitor) return err(slug, monitor.error);
    return {
      ok: true,
      spec: {
        ...base,
        type: 'monitor',
        cron: null,
        runAt: null,
        timezone: 'UTC',
        secretEnv: null,
        run: monitor.run,
        monitorMode: monitor.monitorMode,
        intervalSeconds: monitor.intervalSeconds,
        expectEventWithinSeconds: monitor.expectEventWithinSeconds,
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
          run: null,
          monitorMode: null,
          intervalSeconds: null,
          expectEventWithinSeconds: null,
        },
      };
    }

    if (!cron)
      return err(slug, 'cron triggers must declare a `cron` expression or a one-off `run_at`');
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
        run: null,
        monitorMode: null,
        intervalSeconds: null,
        expectEventWithinSeconds: null,
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
      run: null,
      monitorMode: null,
      intervalSeconds: null,
      expectEventWithinSeconds: null,
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
