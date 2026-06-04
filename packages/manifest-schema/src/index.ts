/**
 * Canonical kortix.toml schema + validator.
 *
 * One source of truth, exercised wherever manifest input is accepted:
 *
 *   1. `kortix ship` (CLI) — pre-flight validation before push. A broken
 *      manifest fails fast with a colored diagnostic, no push happens.
 *   2. Backend CR-merge gate — backstop so manifests pushed without the CLI
 *      (raw git push, web edit) still can't take a project down.
 *   3. `kortix validate` (CLI) — explicit subcommand that just runs the
 *      validator and prints a report.
 *
 * Errors are structured (path + severity + message + optional line/col) so
 * callers can render them however they want. The validator is pure: no I/O,
 * no DB calls, just `(rawToml: string | object) → ManifestValidationResult`.
 */

import { parse as parseToml, TomlError } from 'smol-toml';

/** Maximum manifest schema version this validator understands. */
const KNOWN_SCHEMA_VERSION = 1;

/** The slug reserved for the platform-shared default sandbox template. */
const RESERVED_SANDBOX_SLUG = 'default';

/** Regex matching every user-defined slug (triggers, sandboxes, apps, connectors). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Regex matching every legal env-var name. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const TRIGGER_TYPES = ['cron', 'webhook'] as const;
const CONNECTOR_PROVIDERS = ['pipedream', 'mcp', 'openapi', 'graphql', 'http'] as const;
const CONNECTOR_AUTH_TYPES = ['bearer', 'basic', 'custom', 'none'] as const;
const CONNECTOR_POLICY_ACTIONS = ['always_run', 'require_approval', 'block'] as const;

const SANDBOX_CPU_BOUNDS = { min: 1, max: 32 } as const;
const SANDBOX_MEMORY_BOUNDS = { min: 1, max: 128 } as const;
const SANDBOX_DISK_BOUNDS = { min: 1, max: 500 } as const;

/** One diagnostic finding. */
export interface ManifestIssue {
  /** Dot-path to the offending value, e.g. `triggers[1].cron`. */
  path: string;
  /** Human-readable message. */
  message: string;
  /** `error` blocks push/merge; `warning` is advisory. */
  severity: 'error' | 'warning';
  /** Optional 1-indexed line within the original TOML text. */
  line?: number;
  /** Optional 1-indexed column. */
  column?: number;
}

export interface ManifestValidationResult {
  /** True iff there are zero `error` issues. */
  valid: boolean;
  /** The parsed manifest object (null when the TOML failed to parse at all). */
  parsed: Record<string, unknown> | null;
  /** All issues, both `error` and `warning`. */
  issues: ManifestIssue[];
}

/**
 * Validate a manifest. Accepts either the raw TOML string (canonical input
 * for CLI / git pushes) or an already-parsed object (callers that already
 * went through `smol-toml.parse`).
 */
export function validateManifest(
  input: string | Record<string, unknown>,
): ManifestValidationResult {
  const issues: ManifestIssue[] = [];
  let parsed: Record<string, unknown> | null = null;

  if (typeof input === 'string') {
    try {
      parsed = parseToml(input) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof TomlError) {
        const tomlError = err as Error & { line?: unknown; column?: unknown };
        issues.push({
          path: '<toml>',
          message: `Syntax error: ${tomlError.message}`,
          severity: 'error',
          line: typeof tomlError.line === 'number' ? tomlError.line : undefined,
          column: typeof tomlError.column === 'number' ? tomlError.column : undefined,
        });
      } else {
        issues.push({
          path: '<toml>',
          message: `Failed to parse TOML: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error',
        });
      }
      return { valid: false, parsed: null, issues };
    }
  } else {
    parsed = input;
  }

  validateRoot(parsed, issues);
  validateProject(parsed.project, 'project', issues);
  validateEnv(parsed.env, 'env', issues);
  validateOpenCode(parsed.opencode, 'opencode', issues);
  validateSandbox(parsed.sandbox, 'sandbox', issues);
  rejectLegacySandboxes(parsed.sandboxes, 'sandboxes', issues);
  validateTriggers(parsed.triggers, 'triggers', issues);
  validateConnectors(parsed.connectors, 'connectors', issues);
  validateChannels(parsed.channels, 'channels', issues);
  validateApps(parsed.apps, 'apps', issues);
  validateRuntime(parsed.runtime, 'runtime', issues);

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    parsed,
    issues,
  };
}

/** Format issues into a colored, console-friendly multi-line string. */
export function formatIssues(issues: ManifestIssue[], opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  return issues
    .map((i) => {
      const tag = i.severity === 'error' ? red('error') : yellow('warning');
      const where = i.line ? ` ${dim(`(line ${i.line}${i.column ? `:${i.column}` : ''})`)}` : '';
      return `  ${tag} ${dim(i.path)}: ${i.message}${where}`;
    })
    .join('\n');
}

// ─── Section validators ───────────────────────────────────────────────────

function validateRoot(raw: Record<string, unknown>, issues: ManifestIssue[]): void {
  const versionRaw = raw.kortix_version;
  if (versionRaw == null) {
    issues.push({
      path: 'kortix_version',
      message: 'kortix_version is required — add `kortix_version = 1` at the top.',
      severity: 'error',
    });
    return;
  }
  const version = typeof versionRaw === 'number' ? versionRaw : NaN;
  if (!Number.isFinite(version) || version < 1 || Math.floor(version) !== version) {
    issues.push({
      path: 'kortix_version',
      message: `kortix_version must be a positive integer (got ${JSON.stringify(versionRaw)}).`,
      severity: 'error',
    });
    return;
  }
  if (version > KNOWN_SCHEMA_VERSION) {
    issues.push({
      path: 'kortix_version',
      message: `Unsupported schema version ${version}. This tool understands up to v${KNOWN_SCHEMA_VERSION}; upgrade the CLI or pin the manifest.`,
      severity: 'error',
    });
  }
}

function validateProject(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node == null) return; // optional
  if (!isTable(node)) {
    issues.push({ path, message: '[project] must be a table.', severity: 'error' });
    return;
  }
  expectStringOrAbsent(node.name, `${path}.name`, issues);
  expectStringOrAbsent(node.description, `${path}.description`, issues);
}

function validateEnv(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '[env] must be a table.', severity: 'error' });
    return;
  }
  for (const key of ['required', 'optional'] as const) {
    const val = node[key];
    if (val == null) continue;
    if (!Array.isArray(val)) {
      issues.push({
        path: `${path}.${key}`,
        message: `must be an array of env-var names.`,
        severity: 'error',
      });
      continue;
    }
    val.forEach((item, i) => {
      const where = `${path}.${key}[${i}]`;
      if (typeof item !== 'string') {
        issues.push({ path: where, message: `must be a string env-var name.`, severity: 'error' });
        return;
      }
      const upper = item.trim().toUpperCase();
      if (!ENV_NAME_RE.test(upper)) {
        issues.push({
          path: where,
          message: `"${item}" is not a valid env-var name (uppercase letters, digits, underscores; must not start with a digit).`,
          severity: 'error',
        });
      }
    });
  }
  // Reject unknown keys to catch typos early.
  for (const key of Object.keys(node)) {
    if (!['required', 'optional'].includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Unknown [env] key "${key}". Expected one of: required, optional.`,
        severity: 'warning',
      });
    }
  }
}

function validateOpenCode(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '[opencode] must be a table.', severity: 'error' });
    return;
  }
  expectRelativePathOrAbsent(node.config_dir, `${path}.config_dir`, issues);
}

/**
 * Validate the `[sandbox]` namespace. The image definitions live under
 * `[[sandbox.templates]]` (array of tables). The `[sandbox]` table itself
 * carries no direct image keys — those belonged to the removed singular
 * `[sandbox]` table, so any that linger are flagged as legacy.
 */
function validateSandbox(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({
      path,
      message: '`[sandbox]` must be a table holding `[[sandbox.templates]]` entries.',
      severity: 'error',
    });
    return;
  }
  // Legacy singular `[sandbox]` shape: image/build keys set directly on the
  // table instead of inside a `[[sandbox.templates]]` entry. Reject with a
  // migration hint rather than silently ignoring them.
  const LEGACY_SANDBOX_KEYS = ['image', 'dockerfile', 'slug', 'cpu', 'memory', 'disk', 'entrypoint', 'context', 'context_dir', 'gpu'];
  const stray = LEGACY_SANDBOX_KEYS.filter((k) => node[k] !== undefined);
  if (stray.length > 0) {
    issues.push({
      path,
      message: `The singular \`[sandbox]\` table is no longer supported. Define each image under \`[[sandbox.templates]]\` (array of tables) with a named slug, and remove the \`${stray.join('`, `')}\` key${stray.length === 1 ? '' : 's'} from \`[sandbox]\`.`,
      severity: 'error',
    });
  }
  validateSandboxTemplates(node.templates, `${path}.templates`, issues);

  // `default` selects which template EVERY session in the project boots
  // (UI, triggers, channels) without passing `sandbox_slug`. It must name a
  // template defined above, or the reserved "default" (the platform image).
  if (node.default !== undefined) {
    const want = typeof node.default === 'string' ? node.default.trim() : '';
    if (!want) {
      issues.push({
        path: `${path}.default`,
        message: '`default` must be a non-empty template slug.',
        severity: 'error',
      });
    } else if (want !== RESERVED_SANDBOX_SLUG) {
      const slugs = Array.isArray(node.templates)
        ? node.templates
            .filter(isTable)
            .map((t) => (typeof (t as Record<string, unknown>).slug === 'string' ? ((t as Record<string, unknown>).slug as string).trim() : ''))
            .filter(Boolean)
        : [];
      if (!slugs.includes(want)) {
        issues.push({
          path: `${path}.default`,
          message: `\`default\` = "${want}" does not match any \`[[sandbox.templates]]\` slug (or the reserved "${RESERVED_SANDBOX_SLUG}").`,
          severity: 'error',
        });
      }
    }
  }
}

function validateSandboxTemplates(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`sandbox.templates` must be an array of tables — use `[[sandbox.templates]]`, not `[sandbox.templates]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug (lowercase letters, digits, dashes, underscores; max 128 chars).`,
        severity: 'error',
      });
    } else if (slug === RESERVED_SANDBOX_SLUG) {
      issues.push({
        path: `${where}.slug`,
        message: `slug "${RESERVED_SANDBOX_SLUG}" is reserved for the platform default — use any other slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}" — slugs must be unique within a project.`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    const hasImage = typeof entry.image === 'string' && entry.image.trim() !== '';
    const hasDockerfile = typeof entry.dockerfile === 'string' && entry.dockerfile.trim() !== '';
    if (hasImage && hasDockerfile) {
      issues.push({
        path: where,
        message: 'set exactly one of `image` or `dockerfile`, not both.',
        severity: 'error',
      });
    }
    if (!hasImage && !hasDockerfile) {
      issues.push({
        path: where,
        message: 'set one of `image` or `dockerfile`.',
        severity: 'error',
      });
    }
    if (hasImage && typeof entry.image === 'string') {
      const img = entry.image.trim();
      if (img.endsWith(':latest')) {
        issues.push({
          path: `${where}.image`,
          message: 'Pin a specific tag instead of "latest" (e.g. `python:3.12-slim`).',
          severity: 'warning',
        });
      } else if (!img.includes(':') && !img.includes('@')) {
        issues.push({
          path: `${where}.image`,
          message: 'Image reference must include a tag (e.g. `:3.12-slim`) or digest (`@sha256:…`).',
          severity: 'error',
        });
      }
    }
    if (hasDockerfile && typeof entry.dockerfile === 'string') {
      expectRelativePathOrAbsent(entry.dockerfile, `${where}.dockerfile`, issues);
    }
    expectStringOrAbsent(entry.name, `${where}.name`, issues);
    expectStringOrAbsent(entry.entrypoint, `${where}.entrypoint`, issues);
    expectBoundedIntOrAbsent(entry.cpu, `${where}.cpu`, SANDBOX_CPU_BOUNDS, issues);
    expectBoundedIntOrAbsent(entry.memory, `${where}.memory`, SANDBOX_MEMORY_BOUNDS, issues);
    expectBoundedIntOrAbsent(entry.disk, `${where}.disk`, SANDBOX_DISK_BOUNDS, issues);
    if (entry.gpu !== undefined) {
      issues.push({
        path: `${where}.gpu`,
        message: 'GPU specs are not supported in this version. Remove the `gpu` key.',
        severity: 'warning',
      });
    }
  });
}

function rejectLegacySandboxes(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node === undefined) return;
  issues.push({
    path,
    message:
      '`[[sandboxes]]` has been renamed to `[[sandbox.templates]]`. The fields are unchanged — rename each `[[sandboxes]]` header to `[[sandbox.templates]]` and remove the old block.',
    severity: 'error',
  });
}

function validateTriggers(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`triggers` must be an array of tables — use `[[triggers]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `"${slug}" is not a valid slug.`,
        severity: 'error',
      });
    } else if (seenSlugs.has(slug)) {
      issues.push({
        path: `${where}.slug`,
        message: `duplicate slug "${slug}".`,
        severity: 'error',
      });
    } else {
      seenSlugs.add(slug);
    }
    const type = typeof entry.type === 'string' ? entry.type.trim() : '';
    if (!(TRIGGER_TYPES as readonly string[]).includes(type)) {
      issues.push({
        path: `${where}.type`,
        message: `type must be one of: ${TRIGGER_TYPES.join(', ')} (got "${type || 'unset'}").`,
        severity: 'error',
      });
    }
    const prompt = typeof entry.prompt === 'string' ? entry.prompt : '';
    if (!prompt.trim()) {
      issues.push({
        path: `${where}.prompt`,
        message: 'prompt is required and may not be empty.',
        severity: 'error',
      });
    }
    if (type === 'cron') {
      const cron = typeof entry.cron === 'string' ? entry.cron.trim() : '';
      // A one-off ("run once") schedule carries `run_at` (ISO-8601 instant)
      // instead of a recurring `cron` expression — exactly one must be set.
      const runAt = typeof entry.run_at === 'string' ? entry.run_at.trim() : '';
      if (runAt) {
        if (Number.isNaN(Date.parse(runAt))) {
          issues.push({
            path: `${where}.run_at`,
            message: 'run_at must be an ISO-8601 datetime (e.g. 2026-06-01T09:00:00Z).',
            severity: 'error',
          });
        }
      } else if (!cron) {
        issues.push({
          path: `${where}.cron`,
          message: 'cron triggers must declare a `cron` expression or a one-off `run_at`.',
          severity: 'error',
        });
      }
      if (entry.timezone !== undefined && typeof entry.timezone !== 'string') {
        issues.push({
          path: `${where}.timezone`,
          message: 'timezone must be an IANA string.',
          severity: 'error',
        });
      }
    } else if (type === 'webhook') {
      const secret = typeof entry.secret_env === 'string' ? entry.secret_env.trim() : '';
      if (!secret) {
        issues.push({
          path: `${where}.secret_env`,
          message: 'webhook triggers must declare a `secret_env`.',
          severity: 'error',
        });
      } else if (!ENV_NAME_RE.test(secret)) {
        issues.push({
          path: `${where}.secret_env`,
          message: `"${secret}" is not a valid env-var name.`,
          severity: 'error',
        });
      }
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      issues.push({
        path: `${where}.enabled`,
        message: 'enabled must be a boolean.',
        severity: 'error',
      });
    }
  });
}

function validateConnectors(
  node: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`connectors` must be an array of tables — use `[[connectors]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({ path: `${where}.slug`, message: `"${slug}" is not a valid slug.`, severity: 'error' });
    } else if (seenSlugs.has(slug)) {
      issues.push({ path: `${where}.slug`, message: `duplicate slug "${slug}".`, severity: 'error' });
    } else {
      seenSlugs.add(slug);
    }
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) {
      issues.push({
        path: `${where}.provider`,
        message: `provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')} (got "${provider || 'unset'}").`,
        severity: 'error',
      });
    }
    if (provider === 'pipedream' && typeof entry.app !== 'string') {
      issues.push({
        path: `${where}.app`,
        message: 'pipedream connectors require `app`.',
        severity: 'error',
      });
    }
    if (provider === 'mcp' && typeof entry.url !== 'string') {
      issues.push({
        path: `${where}.url`,
        message: 'mcp connectors require `url`.',
        severity: 'error',
      });
    }
    if (provider === 'graphql' && typeof entry.endpoint !== 'string') {
      issues.push({
        path: `${where}.endpoint`,
        message: 'graphql connectors require `endpoint`.',
        severity: 'error',
      });
    }
    if (provider === 'http' && typeof entry.base_url !== 'string') {
      issues.push({
        path: `${where}.base_url`,
        message: 'http connectors require `base_url`.',
        severity: 'error',
      });
    }
    // Optional [connectors.auth]
    if (entry.auth !== undefined) {
      const auth = entry.auth;
      if (!isTable(auth)) {
        issues.push({ path: `${where}.auth`, message: 'auth must be a table.', severity: 'error' });
      } else {
        const t = typeof auth.type === 'string' ? auth.type : '';
        if (!(CONNECTOR_AUTH_TYPES as readonly string[]).includes(t)) {
          issues.push({
            path: `${where}.auth.type`,
            message: `auth.type must be one of: ${CONNECTOR_AUTH_TYPES.join(', ')} (got "${t || 'unset'}").`,
            severity: 'error',
          });
        }
        if (auth.secret !== undefined) {
          issues.push({
            path: `${where}.auth.secret`,
            message: 'auth.secret is no longer supported; set connector credentials in the platform.',
            severity: 'error',
          });
        }
      }
    }
    // Optional [[connectors.policies]]
    if (entry.policies !== undefined) {
      const policies = entry.policies;
      if (!Array.isArray(policies)) {
        issues.push({
          path: `${where}.policies`,
          message: 'connectors.policies must be an array of tables.',
          severity: 'error',
        });
      } else {
        policies.forEach((p, j) => {
          const pwhere = `${where}.policies[${j}]`;
          if (!isTable(p)) {
            issues.push({ path: pwhere, message: 'must be a table.', severity: 'error' });
            return;
          }
          if (typeof p.match !== 'string' || !p.match.trim()) {
            issues.push({
              path: `${pwhere}.match`,
              message: 'match glob is required.',
              severity: 'error',
            });
          }
          const action = typeof p.action === 'string' ? p.action : '';
          if (!(CONNECTOR_POLICY_ACTIONS as readonly string[]).includes(action)) {
            issues.push({
              path: `${pwhere}.action`,
              message: `action must be one of: ${CONNECTOR_POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}").`,
              severity: 'error',
            });
          }
        });
      }
    }
  });
}

function validateChannels(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`channels` must be an array of tables — use `[[channels]]`.',
      severity: 'error',
    });
    return;
  }
  const seenPlatforms = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const platform = typeof entry.platform === 'string' ? entry.platform.trim() : '';
    if (!platform) {
      issues.push({ path: `${where}.platform`, message: 'platform is required (e.g. "slack").', severity: 'error' });
    } else if (seenPlatforms.has(platform)) {
      issues.push({
        path: `${where}.platform`,
        message: `duplicate platform "${platform}" — one [[channels]] entry per platform per project.`,
        severity: 'error',
      });
    } else {
      seenPlatforms.add(platform);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      issues.push({ path: `${where}.enabled`, message: 'enabled must be a boolean.', severity: 'error' });
    }
    if (entry.events !== undefined) {
      if (!Array.isArray(entry.events)) {
        issues.push({ path: `${where}.events`, message: 'events must be an array of strings.', severity: 'error' });
      } else {
        entry.events.forEach((ev, j) => {
          if (typeof ev !== 'string') {
            issues.push({ path: `${where}.events[${j}]`, message: 'must be a string.', severity: 'error' });
          }
        });
      }
    }
  });
}

function validateApps(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!Array.isArray(node)) {
    issues.push({
      path,
      message: '`apps` must be an array of tables — use `[[apps]]`.',
      severity: 'error',
    });
    return;
  }
  const seenSlugs = new Set<string>();
  node.forEach((entry, i) => {
    const where = `${path}[${i}]`;
    if (!isTable(entry)) {
      issues.push({ path: where, message: 'must be a table.', severity: 'error' });
      return;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) {
      issues.push({ path: `${where}.slug`, message: 'slug is required.', severity: 'error' });
    } else if (!SLUG_RE.test(slug)) {
      issues.push({ path: `${where}.slug`, message: `"${slug}" is not a valid slug.`, severity: 'error' });
    } else if (seenSlugs.has(slug)) {
      issues.push({ path: `${where}.slug`, message: `duplicate slug "${slug}".`, severity: 'error' });
    } else {
      seenSlugs.add(slug);
    }
    expectStringOrAbsent(entry.name, `${where}.name`, issues);
    expectStringOrAbsent(entry.framework, `${where}.framework`, issues);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      issues.push({ path: `${where}.enabled`, message: 'enabled must be a boolean.', severity: 'error' });
    }
    if (entry.domains !== undefined) {
      if (!Array.isArray(entry.domains)) {
        issues.push({ path: `${where}.domains`, message: 'domains must be an array of strings.', severity: 'error' });
      } else {
        entry.domains.forEach((d, j) => {
          if (typeof d !== 'string') {
            issues.push({ path: `${where}.domains[${j}]`, message: 'must be a string.', severity: 'error' });
          }
        });
      }
    }
    if (entry.source !== undefined) {
      if (!isTable(entry.source)) {
        issues.push({ path: `${where}.source`, message: 'source must be a table.', severity: 'error' });
      } else {
        const type = typeof entry.source.type === 'string' ? entry.source.type : '';
        if (type !== 'git' && type !== 'tar') {
          issues.push({
            path: `${where}.source.type`,
            message: `source.type must be "git" or "tar" (got "${type || 'unset'}").`,
            severity: 'error',
          });
        }
      }
    }
    if (entry.build !== undefined && !isTable(entry.build)) {
      issues.push({ path: `${where}.build`, message: 'build must be a table.', severity: 'error' });
    }
    if (entry.env !== undefined && !isTable(entry.env)) {
      issues.push({ path: `${where}.env`, message: 'env must be a table of string KEY=VALUE pairs.', severity: 'error' });
    }
  });
}

// ─── Primitive helpers ────────────────────────────────────────────────────

/** The built-in Kortix runtime features toggleable under `[runtime]`. */
export const RUNTIME_FEATURE_KEYS = ['memory', 'web_tools', 'pty', 'show', 'executor'] as const;

/**
 * Validate the `[runtime]` table — the Kortix runtime defaults. Every built-in
 * is ON unless turned off here (or enforced off per-session via the API).
 * `disable_all = true` runs the session as plain OpenCode.
 *
 *   [runtime]
 *   disable_all = false
 *   memory = true
 *   web_tools = true
 *   pty = true
 *   show = true
 *   executor = true
 */
function validateRuntime(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node == null) return;
  if (!isTable(node)) {
    issues.push({ path, message: '[runtime] must be a table.', severity: 'error' });
    return;
  }
  expectBooleanOrAbsent(node.disable_all, `${path}.disable_all`, issues);
  for (const key of RUNTIME_FEATURE_KEYS) {
    expectBooleanOrAbsent(node[key], `${path}.${key}`, issues);
  }
  // Unknown keys are a likely typo (e.g. `web_search` instead of `web_tools`) —
  // warn but don't fail, so the schema can add features without breaking older manifests.
  for (const key of Object.keys(node)) {
    if (key !== 'disable_all' && !(RUNTIME_FEATURE_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `unknown [runtime] feature "${key}". Known features: ${RUNTIME_FEATURE_KEYS.join(', ')}.`,
        severity: 'warning',
      });
    }
  }
}

function expectBooleanOrAbsent(value: unknown, path: string, issues: ManifestIssue[]): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'boolean') {
    issues.push({ path, message: 'must be a boolean (true/false).', severity: 'error' });
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectStringOrAbsent(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string.', severity: 'error' });
  }
}

function expectRelativePathOrAbsent(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string path.', severity: 'error' });
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    issues.push({ path, message: 'must not be empty.', severity: 'error' });
    return;
  }
  if (trimmed.startsWith('/')) {
    issues.push({
      path,
      message: 'must be a path relative to the repo root (no leading "/").',
      severity: 'error',
    });
    return;
  }
  if (trimmed.split('/').includes('..')) {
    issues.push({
      path,
      message: 'must not contain ".." path segments.',
      severity: 'error',
    });
  }
}

function expectBoundedIntOrAbsent(
  value: unknown,
  path: string,
  bounds: { min: number; max: number },
  issues: ManifestIssue[],
): void {
  if (value === undefined || value === null) return;
  const num =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(num) || num <= 0) {
    issues.push({ path, message: `must be a positive integer.`, severity: 'error' });
    return;
  }
  if (Math.floor(num) !== num) {
    issues.push({ path, message: `must be an integer.`, severity: 'error' });
    return;
  }
  if (num < bounds.min) {
    issues.push({ path, message: `must be ≥ ${bounds.min}.`, severity: 'error' });
  } else if (num > bounds.max) {
    issues.push({
      path,
      message: `must be ≤ ${bounds.max} (clamped at runtime, but pin a sane value in source).`,
      severity: 'warning',
    });
  }
}
