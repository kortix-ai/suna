/**
 * Kortix sandbox config — `[sandbox]` section of `kortix.toml`.
 *
 * Lets a project declare the Dockerfile it wants its session sandboxes
 * built from. The Kortix snapshot builder reads this spec, layers the
 * Kortix agent daemon + opencode CLI on top of the user's image, and
 * publishes the result as the project's session snapshot.
 *
 * Example manifest:
 *
 *   [sandbox]
 *   dockerfile = "Dockerfile"
 *   context    = "."
 *
 * Defaults (when `[sandbox]` is absent OR fields are missing):
 *   - dockerfile = "Dockerfile"   — path inside the repo
 *   - context    = "."            — build context root inside the repo
 *
 * The build always appends a final stage that:
 *   1. Copies in the Kortix agent daemon binary (`kortix-agent`).
 *   2. Installs the pinned `opencode` CLI globally.
 *   3. Sets `ENTRYPOINT` to the Kortix sandbox entrypoint.
 *
 * That layering is non-negotiable — it's what makes a Daytona session
 * connectable from the dashboard. Users define the *workspace* base;
 * Kortix owns the *runtime* on top.
 */

import type { ParsedManifest } from './triggers';

export interface ProjectSandboxSpec {
  /** Repo-relative path to the project's Dockerfile. */
  dockerfile: string;
  /** Build context root, repo-relative. */
  context: string;
}

export interface SandboxParseError {
  field: string;
  error: string;
}

export const DEFAULT_SANDBOX: ProjectSandboxSpec = {
  dockerfile: 'Dockerfile',
  context: '.',
};

/**
 * Parse the `[sandbox]` table out of a manifest. Returns the resolved
 * spec (filled with defaults) and any per-field errors. Never throws —
 * callers can render errors next to the spec.
 */
export function extractSandbox(
  manifest: ParsedManifest,
): { spec: ProjectSandboxSpec; errors: SandboxParseError[] } {
  const raw = manifest.raw.sandbox;
  if (raw === undefined || raw === null) {
    return { spec: { ...DEFAULT_SANDBOX }, errors: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      spec: { ...DEFAULT_SANDBOX },
      errors: [{
        field: 'sandbox',
        error: '`sandbox` must be a table (`[sandbox]`), not an array or scalar',
      }],
    };
  }
  const row = raw as Record<string, unknown>;
  const errors: SandboxParseError[] = [];

  const dockerfile = pickString(row.dockerfile, 'Dockerfile', 'dockerfile', errors);
  const context = pickString(row.context ?? row.context_dir, '.', 'context', errors);

  // Refuse paths that escape the repo. The build runs in a sandbox of
  // its own, but accepting `../`/absolute makes the intent ambiguous.
  if (dockerfile.startsWith('/') || dockerfile.includes('..')) {
    errors.push({
      field: 'dockerfile',
      error: `dockerfile must be a repo-relative path (got "${dockerfile}")`,
    });
  }
  if (context.startsWith('/') || context.includes('..')) {
    errors.push({
      field: 'context',
      error: `context must be a repo-relative path (got "${context}")`,
    });
  }

  return { spec: { dockerfile, context }, errors };
}

function pickString(
  value: unknown,
  fallback: string,
  field: string,
  errors: SandboxParseError[],
): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    errors.push({ field, error: `${field} must be a string (got ${typeof value})` });
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

/* ─── Dockerfile merge ──────────────────────────────────────────────── */

/**
 * Compose the user's Dockerfile with the Kortix runtime layer. The
 * result is a complete Dockerfile string the snapshot builder can pass
 * to `docker build`.
 *
 * We take the user's Dockerfile as-is (FROM, RUN, ENV, whatever they
 * want for their workspace tooling) and append a final stage that
 * copies the Kortix agent binary, installs the pinned opencode CLI,
 * and sets our entrypoint. The user-stage image becomes the base for
 * the Kortix stage, so everything they installed remains on PATH.
 *
 * `userDockerfile` is the literal contents of the project's Dockerfile.
 * `opencodeVersion` pins the CLI version (matches the platform's
 * shared `OPENCODE_VERSION`).
 */
export function buildLayeredDockerfile(opts: {
  userDockerfile: string;
  opencodeVersion: string;
  agentBinaryPath: string;
  entrypointScriptPath: string;
}): string {
  const { userDockerfile, opencodeVersion, agentBinaryPath, entrypointScriptPath } = opts;
  const trimmed = userDockerfile.trimEnd();

  const kortixLayer = [
    '',
    '# ─── Kortix runtime layer (auto-injected) ──────────────────────────',
    '# Everything below is added by the Kortix snapshot builder. Do not',
    '# edit by hand — your project Dockerfile above is preserved verbatim.',
    '',
    'USER root',
    'RUN apt-get update \\',
    '    && apt-get install -y --no-install-recommends \\',
    '        ca-certificates curl git nodejs npm \\',
    '    && rm -rf /var/lib/apt/lists/*',
    '',
    `RUN npm install -g --no-audit --no-fund "opencode-ai@${opencodeVersion}" \\`,
    '    && command -v opencode \\',
    '    && opencode --version',
    '',
    `COPY ${agentBinaryPath} /usr/local/bin/kortix-agent`,
    `COPY ${entrypointScriptPath} /usr/local/bin/kortix-entrypoint`,
    'RUN chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix-entrypoint',
    '',
    'ENV KORTIX_WORKSPACE=/workspace',
    'WORKDIR /workspace',
    'EXPOSE 8000',
    'ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]',
    '',
  ].join('\n');

  return `${trimmed}\n${kortixLayer}`;
}
