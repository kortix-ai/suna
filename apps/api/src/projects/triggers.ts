/**
 * Kortix trigger DSL — lives inside `kortix.toml` as `[[triggers]]` array
 * entries. The manifest at the repo root is THE source of truth for
 * trigger config; runtime state (last_fired_at, executions) stays in the
 * `project_trigger_runtime` DB table.
 *
 * Example shape:
 *
 *   kortix_version = 1
 *
 *   [project]
 *   name = "example"
 *
 *   [[triggers]]
 *   slug = "daily-digest"
 *   name = "Daily digest"
 *   type = "cron"
 *   agent = "default"
 *   enabled = true
 *   cron = "0 0 9 * * 1-5"
 *   timezone = "UTC"
 *   prompt = """
 *   Generate the daily digest…
 *   """
 *
 *   [[triggers]]
 *   slug = "slack"
 *   type = "webhook"
 *   secret_env = "WEBHOOK_SLACK_SECRET"
 *   prompt = "New {{ message.text }}"
 *
 * One file, one PR-review surface. Web-UI edits are read-modify-write on
 * this same file — see writeManifestTriggers / deleteManifestTrigger in
 * apps/api/src/projects/index.ts.
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readRepoFile, type GitBackedProject } from './git';

/** Where the manifest lives. Same path the rest of the platform looks for. */
export const MANIFEST_FILENAME = 'kortix.toml';

/**
 * Schema version of the manifest. Bumped when we make a breaking change to
 * how the file is parsed. Manifests without `kortix_version` are treated as
 * v1 (backward compat). A higher major than KNOWN_SCHEMA_VERSION → loaders
 * refuse to interpret the file so we don't silently misread future fields.
 */
export const KNOWN_SCHEMA_VERSION = 1;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

type GitTriggerType = 'cron' | 'webhook';

export interface GitTriggerSpec {
  /** URL-safe slug — unique per project. */
  slug: string;
  /**
   * Where the entry is sourced from. Always `kortix.toml#triggers.<slug>`
   * now that triggers are centralized. The hash is just a hint for the UI;
   * the platform doesn't use it for routing.
   */
  path: string;
  /** Human label; defaults to the slug when not set. */
  name: string;
  type: GitTriggerType;
  /** Agent name (default: "default"). */
  agent: string;
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
}

interface GitTriggerParseError {
  slug: string;
  path: string;
  error: string;
}

export interface ParsedManifest {
  schemaVersion: number;
  /** The raw decoded TOML object — callers shouldn't usually need this. */
  raw: Record<string, unknown>;
}

/** Result of `loadProjectTriggers` — same shape callers got pre-refactor. */
interface LoadedTriggers {
  specs: GitTriggerSpec[];
  errors: GitTriggerParseError[];
}

/* ─── Manifest IO ───────────────────────────────────────────────────────── */

/**
 * Read + parse the project's kortix.toml. Returns null if the file is
 * absent (so the caller can treat the repo as "not a Kortix project yet").
 * Throws on parse errors so the caller can surface them up — we don't
 * silently swallow a malformed manifest.
 */
export async function readManifest(
  project: GitBackedProject,
): Promise<ParsedManifest | null> {
  let raw: string;
  try {
    raw = await readRepoFile(project, MANIFEST_FILENAME, project.defaultBranch);
  } catch {
    return null;
  }
  return parseManifestString(raw);
}

/**
 * Synchronous parse from a TOML string. Exported so the CRUD path can
 * round-trip (read existing string, parse, mutate, serialize) without
 * touching the network.
 */
export function parseManifestString(raw: string): ParsedManifest {
  const parsed = parseToml(raw) as Record<string, unknown>;
  const version = typeof parsed.kortix_version === 'number'
    ? parsed.kortix_version
    : typeof parsed.kortix_version === 'string'
      ? Number(parsed.kortix_version)
      : KNOWN_SCHEMA_VERSION;

  if (!Number.isFinite(version) || version < 1) {
    throw new Error('kortix_version must be a positive integer');
  }
  if (Math.floor(version) > KNOWN_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported kortix.toml schema version ${version}. This platform understands up to v${KNOWN_SCHEMA_VERSION}; upgrade the platform or pin the manifest.`,
    );
  }

  return { schemaVersion: Math.floor(version), raw: parsed };
}

/** Serialize a parsed manifest back to TOML text for committing. */
export function serializeManifest(manifest: ParsedManifest): string {
  // Ensure kortix_version is the FIRST key so the resulting TOML is
  // self-describing at a glance. smol-toml emits keys in insertion order.
  const out: Record<string, unknown> = { kortix_version: manifest.schemaVersion };
  for (const [key, value] of Object.entries(manifest.raw)) {
    if (key === 'kortix_version') continue;
    out[key] = value;
  }
  return stringifyToml(out);
}

/* ─── Trigger extraction ────────────────────────────────────────────────── */

/**
 * Parse the `[[triggers]]` array out of a loaded manifest, validating each
 * entry. Never throws — bad entries land in `errors` with a slug + reason
 * so the UI can render them alongside the good ones.
 */
export function extractTriggers(manifest: ParsedManifest): LoadedTriggers {
  const rawTriggers = manifest.raw.triggers;
  if (rawTriggers === undefined || rawTriggers === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(rawTriggers)) {
    return {
      specs: [],
      errors: [{
        slug: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`triggers` must be an array of tables — use [[triggers]], not [triggers]',
      }],
    };
  }

  const specs: GitTriggerSpec[] = [];
  const errors: GitTriggerParseError[] = [];
  const seenSlugs = new Set<string>();

  rawTriggers.forEach((entry, index) => {
    const result = parseTriggerEntry(entry, index);
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
): Promise<LoadedTriggers> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project);
  } catch (err) {
    return {
      specs: [],
      errors: [{
        slug: '(manifest)',
        path: MANIFEST_FILENAME,
        error: (err as Error).message || 'Failed to read manifest',
      }],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractTriggers(manifest);
}

/* ─── Trigger ↔ TOML conversion ─────────────────────────────────────────── */

/**
 * Convert a TriggerSpec back to the TOML-shaped object that goes into the
 * `triggers` array. Inverse of `parseTriggerEntry`. Used by the CRUD path
 * to write back to kortix.toml after a UI edit.
 */
export function triggerSpecToTomlEntry(spec: GitTriggerSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    enabled: spec.enabled,
  };
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

function parseTriggerEntry(entry: unknown, index: number): ParseOk | ParseErr {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[triggers]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[triggers]] entry #${index + 1} is missing a slug`);
  if (!SLUG_RE.test(slug)) {
    return err(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
  }

  const typeRaw = typeof row.type === 'string' ? row.type.trim() : '';
  if (typeRaw !== 'cron' && typeRaw !== 'webhook') {
    return err(slug, `type must be "cron" or "webhook" (got "${typeRaw || 'unset'}")`);
  }
  const type = typeRaw as GitTriggerType;

  const prompt = typeof row.prompt === 'string' ? row.prompt : '';
  if (!prompt.trim()) {
    return err(slug, 'prompt is required and may not be empty');
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug;
  const agent = typeof row.agent === 'string' && row.agent.trim() ? row.agent.trim() : 'default';
  const enabled = coerceBool(row.enabled, true);

  const path = `${MANIFEST_FILENAME}#triggers.${slug}`;

  if (type === 'cron') {
    const cron = typeof row.cron === 'string' ? row.cron.trim() : '';
    const runAtRaw = typeof row.run_at === 'string' ? row.run_at.trim() : '';
    const timezone = typeof row.timezone === 'string' && row.timezone.trim()
      ? row.timezone.trim()
      : 'UTC';

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
          enabled,
          promptTemplate: prompt,
          cron: null,
          runAt: new Date(parsed).toISOString(),
          timezone,
          secretEnv: null,
        },
      };
    }

    if (!cron) return err(slug, 'cron triggers must declare a `cron` expression or a one-off `run_at`');
    return {
      ok: true,
      spec: {
        slug,
        path,
        name,
        type: 'cron',
        agent,
        enabled,
        promptTemplate: prompt,
        cron,
        runAt: null,
        timezone,
        secretEnv: null,
      },
    };
  }

  // webhook
  const secretEnv = typeof row.secret_env === 'string' ? row.secret_env.trim() : '';
  if (!secretEnv) {
    return err(slug, 'webhook triggers must declare `secret_env` pointing at a project_secrets entry');
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
      enabled,
      promptTemplate: prompt,
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

function err(slug: string, message: string): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${MANIFEST_FILENAME}#triggers.${slug}`, error: message },
  };
}
