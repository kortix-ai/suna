/**
 * Kortix trigger DSL — lives inside the project manifest (kortix.yaml; a
 * legacy v1 project may instead use kortix.toml) as a `triggers:` list of
 * entries. The manifest at the repo root is THE source of truth for
 * trigger config; runtime state (last_fired_at, executions) stays in the
 * `project_trigger_runtime` DB table.
 *
 * Example shape (kortix.yaml):
 *
 *   kortix_version: 2
 *
 *   project:
 *     name: example
 *
 *   triggers:
 *     - slug: daily-digest
 *       name: Daily digest
 *       type: cron
 *       agent: default
 *       enabled: true
 *       cron: "0 0 9 * * 1-5"
 *       timezone: UTC
 *       prompt: "Generate the daily digest…"
 *
 *     - slug: slack
 *       type: webhook
 *       secret_env: WEBHOOK_SLACK_SECRET
 *       prompt: "New {{ message.text }}"
 *
 * One file, one PR-review surface. Web-UI edits are read-modify-write on
 * this same file — see writeManifestTriggers / deleteManifestTrigger in
 * apps/api/src/projects/index.ts.
 */

import {
  MANIFEST_FILENAME_YAML,
  type ManifestFormat,
  manifestCandidatePaths,
  manifestFormatForPath,
  parseManifestText,
  serializeManifestObject,
} from '@kortix/manifest-schema';
import { type GitBackedProject, readManifestFromRepo, readRepoFile } from './git';

/** Where the manifest lives. Same path the rest of the platform looks for.
 *  A project may instead use `kortix.yaml` ({@link MANIFEST_FILENAME_YAML}) —
 *  reads prefer it if present; this stays the canonical name for breadcrumbs
 *  and the toml/legacy default. */
export const MANIFEST_FILENAME = 'kortix.toml';
export { MANIFEST_FILENAME_YAML };

/**
 * Schema version of the manifest. Bumped when we make a breaking change to
 * how the file is parsed. Manifests without `kortix_version` are treated as
 * v1 (backward compat). `KNOWN_SCHEMA_VERSION` deliberately stays `1` — it is
 * the version every v1 test fixture across this package stamps into its
 * `kortix_version` header and the version `parseAgentEntry`/`extractTriggers`'
 * v1 code paths were authored against; changing its VALUE would silently flip
 * every one of those v1-shaped fixtures onto the v2 reader below. See
 * `MAX_SCHEMA_VERSION` for the actual acceptance ceiling.
 */
export const KNOWN_SCHEMA_VERSION = 1;

/**
 * Highest schema version this reader (the one the session/trigger/grant
 * pipeline actually reads through — `readManifest`/`parseManifestString`)
 * accepts without throwing. `kortix_version: 2` (the `agents:` map + full
 * OpenCode `AgentConfig` parity + deny-by-default grants — see
 * `@kortix/manifest-schema`'s `ManifestV2`) is validated at write time by
 * `kortix validate` / the CR-merge gate; THIS reader must not also reject it,
 * or every v2 project's session grant resolution would fail closed/open
 * instead of reading the agent's declared grant (the runtime-wiring gap
 * fixed by docs/specs/2026-07-05-agent-first-config-unification.md §2.1/§2.2 —
 * `extractAgents` in `./agents.ts` is the v2-aware consumer). A version above
 * this ceiling is genuinely unknown to the platform and still refused.
 */
export const MAX_SCHEMA_VERSION = 2;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export type GitTriggerType = 'cron' | 'webhook';

export interface GitTriggerSpec {
  /** URL-safe slug — unique per project. */
  slug: string;
  /**
   * Where the entry is sourced from. Always `<manifest-file>#triggers.<slug>`
   * now that triggers are centralized — `kortix.yaml` for v2 projects,
   * `kortix.toml` for legacy v1 ones. The hash is just a hint for the UI;
   * the platform doesn't use it for routing.
   */
  path: string;
  /** Human label; defaults to the slug when not set. */
  name: string;
  type: GitTriggerType;
  /** Agent name (default: "default"). */
  agent: string;
  /**
   * Model for this trigger's runs (wire form `provider/model`), or null for
   * "Default" — resolve the chain at fire time (agent → project → account →
   * platform `auto`). The most-specific *default-time* override for a trigger
   * run. Catalog-availability is validated at the route layer, not here.
   */
  model: string | null;
  /** When false, the scheduler / webhook receiver skip this entry. */
  enabled: boolean;
  /** Mustache-style prompt template — the body sent to the agent on each fire. */
  promptTemplate: string;
  /** For type=cron only. 6-field croner expression. Null for one-off (`runAt`) schedules. */
  cron: string | null;
  /**
   * For type=cron only. ISO-8601 instant for a one-off ("run once") schedule.
   * Mutually exclusive with `cron`: when set, the trigger fires exactly once
   * at/after this instant and then stays dormant (guarded by last_fired_at).
   */
  runAt: string | null;
  /** For type=cron only. IANA timezone. Defaults to UTC. */
  timezone: string;
  /**
   * For type=webhook only — the project_secrets key that holds the HMAC
   * signing secret. The actual secret value is never inline.
   */
  secretEnv: string | null;
  /**
   * Session reuse policy.
   * - `'fresh'` (default): every fire mints a brand-new session (new sandbox +
   *   new ephemeral branch) — the historical behavior.
   * - `'reuse'`: re-prompt the most recent session this trigger created
   *   (resuming its sandbox + opencode root) so ONE long-lived session
   *   accumulates context across fires. If no reusable session exists yet (or
   *   the last one is dead/failed), a fresh one is created and becomes the
   *   canonical session going forward. Primarily meant for recurring cron
   *   triggers that should feel like a single persistent agent run.
   */
  sessionMode: GitTriggerSessionMode;
  /**
   * For `sessionMode === 'pinned'` only — the exact `project_sessions.session_id`
   * this trigger loops. Null for `'fresh'`/`'reuse'`. Stored in the manifest as
   * `session_id` (portable) AND persisted on `project_trigger_runtime.session_id`.
   */
  pinnedSessionId: string | null;
}

export type GitTriggerSessionMode = 'fresh' | 'reuse' | 'pinned';

export const GIT_TRIGGER_SESSION_MODES: readonly GitTriggerSessionMode[] = [
  'fresh',
  'reuse',
  'pinned',
];

export interface GitTriggerParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ParsedManifest {
  schemaVersion: number;
  /** The raw decoded object — callers shouldn't usually need this. */
  raw: Record<string, unknown>;
  /** Which on-disk format this manifest is in. Drives serialization back to the
   *  same format on commit. Required so every construction site is explicit. */
  format: ManifestFormat;
  /** The repo-relative file the manifest was read from (or should be written to
   *  for a synthesized one) — e.g. `kortix.yaml` or `kortix.toml`. Lets the
   *  commit path write to the exact same file, honoring `.yml` and custom dirs. */
  path: string;
}

/** Result of `loadProjectTriggers` — same shape callers got pre-refactor. */
export interface LoadedTriggers {
  specs: GitTriggerSpec[];
  errors: GitTriggerParseError[];
}

/* ─── Manifest IO ───────────────────────────────────────────────────────── */

/**
 * Read + parse the project's manifest. Returns null if no manifest file is
 * present (so the caller can treat the repo as "not a Kortix project yet").
 * Throws on parse errors so the caller can surface them up — we don't
 * silently swallow a malformed manifest.
 *
 * DUAL-FORMAT: prefers `kortix.yaml` over `kortix.toml` when both exist, else
 * falls back to whichever is present (honoring a custom `manifest_path`). The
 * resolved file + format ride along on the ParsedManifest so the commit path
 * writes back to the exact same file in the same format.
 */
export async function readManifest(project: GitBackedProject): Promise<ParsedManifest | null> {
  let found: { path: string; content: string } | null;
  try {
    // manifest_path can still say kortix.toml (an older project, or a stale
    // default) even when the file actually on disk is kortix.yaml — so we
    // can't rely on it to point at the right format. We actively probe the
    // .yaml/.yml siblings first (manifestCandidatePaths), which also keeps
    // per-agent env/connector scoping ON for a yaml-only project (a missing
    // `agents:` read = grants resolve to null = unrestricted).
    const candidates = manifestCandidatePaths(project.manifestPath).map((c) => c.path);
    found = await readManifestFromRepo(project, candidates, project.defaultBranch);
  } catch {
    return null;
  }
  if (!found) return null;
  return parseManifestString(found.content, manifestFormatForPath(found.path), found.path);
}

/**
 * Synchronous parse from a manifest string. Exported so the CRUD path can
 * round-trip (read existing string, parse, mutate, serialize) without touching
 * the network. `format`/`path` default to TOML/kortix.toml so an existing
 * caller passing only a string is unchanged.
 */
export function parseManifestString(
  raw: string,
  format: ManifestFormat = 'toml',
  path: string = format === 'yaml' ? MANIFEST_FILENAME_YAML : MANIFEST_FILENAME,
): ParsedManifest {
  const parsed = parseManifestText(raw, format);
  const version =
    typeof parsed.kortix_version === 'number'
      ? parsed.kortix_version
      : typeof parsed.kortix_version === 'string'
        ? Number(parsed.kortix_version)
        : KNOWN_SCHEMA_VERSION;

  if (!Number.isFinite(version) || version < 1) {
    throw new Error('kortix_version must be a positive integer');
  }
  if (Math.floor(version) > MAX_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ${path} schema version ${version}. This platform understands up to v${MAX_SCHEMA_VERSION}; upgrade the platform or pin the manifest.`,
    );
  }

  return { schemaVersion: Math.floor(version), raw: parsed, format, path };
}

/** Serialize a parsed manifest back to text (in its own format) for committing. */
export function serializeManifest(manifest: ParsedManifest): string {
  // Ensure kortix_version is the FIRST key so the manifest is self-describing at
  // a glance. Both smol-toml and the yaml package emit keys in insertion order.
  const out: Record<string, unknown> = { kortix_version: manifest.schemaVersion };
  for (const [key, value] of Object.entries(manifest.raw)) {
    if (key === 'kortix_version') continue;
    out[key] = value;
  }
  return serializeManifestObject(out, manifest.format);
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
    const result = parseTriggerEntry(entry, index, filename);
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
export async function loadProjectTriggers(project: GitBackedProject): Promise<LoadedTriggers> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project);
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
  // Only emit session_mode when it deviates from the default ('fresh') so
  // existing manifests stay byte-stable on round-trip.
  if (spec.sessionMode !== 'fresh') {
    entry.session_mode = spec.sessionMode;
  }
  // `pinned` carries the exact session id to loop.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    entry.session_id = spec.pinnedSessionId;
  }
  if (spec.type === 'cron') {
    if (spec.runAt) {
      entry.run_at = spec.runAt;
    } else {
      entry.cron = spec.cron ?? '';
    }
    entry.timezone = spec.timezone;
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

// A bad IANA timezone (typo, or an abbreviation like "PST") otherwise slips
// through parsing and only fails later inside the cron due-check, where it's
// swallowed to `false` — the trigger then silently never fires. Catch it at
// parse time so it surfaces as a visible trigger error instead.
function isValidTimeZone(tz: string): boolean {
  if (tz === 'UTC') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseTriggerEntry(entry: unknown, index: number, filename: string = MANIFEST_FILENAME): ParseOk | ParseErr {
  const err = (slug: string, message: string): ParseErr => makeTriggerError(slug, message, filename);

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
  if (typeRaw !== 'cron' && typeRaw !== 'webhook') {
    return err(slug, `type must be "cron" or "webhook" (got "${typeRaw || 'unset'}")`);
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
    sessionModeRaw !== 'fresh' &&
    sessionModeRaw !== 'reuse' &&
    sessionModeRaw !== 'pinned'
  ) {
    return err(slug, `session_mode must be "fresh", "reuse", or "pinned" (got "${sessionModeRaw}")`);
  }
  const sessionMode: GitTriggerSessionMode =
    sessionModeRaw === 'reuse' ? 'reuse' : sessionModeRaw === 'pinned' ? 'pinned' : 'fresh';

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

  const path = `${filename}#triggers.${slug}`;

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
    if (!isValidTimeZone(timezone)) {
      return err(
        slug,
        `timezone must be a valid IANA name like "UTC" or "America/New_York" (got "${timezone}")`,
      );
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
          slug,
          path,
          name,
          type: 'cron',
          agent,
          model,
          enabled,
          promptTemplate: prompt,
          cron: null,
          runAt: new Date(parsed).toISOString(),
          timezone,
          secretEnv: null,
          sessionMode,
          pinnedSessionId,
        },
      };
    }

    if (!cron)
      return err(slug, 'cron triggers must declare a `cron` expression or a one-off `run_at`');
    return {
      ok: true,
      spec: {
        slug,
        path,
        name,
        type: 'cron',
        agent,
        model,
        enabled,
        promptTemplate: prompt,
        cron,
        runAt: null,
        timezone,
        secretEnv: null,
        sessionMode,
        pinnedSessionId,
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
      slug,
      path,
      name,
      type: 'webhook',
      agent,
      model,
      enabled,
      promptTemplate: prompt,
      cron: null,
      runAt: null,
      timezone: 'UTC',
      secretEnv,
      sessionMode,
      pinnedSessionId,
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

function makeTriggerError(slug: string, message: string, filename: string = MANIFEST_FILENAME): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${filename}#triggers.${slug}`, error: message },
  };
}
