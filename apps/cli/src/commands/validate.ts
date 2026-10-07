/**
 * `kortix validate` — standalone project validator.
 *
 * Reads ./kortix.yaml (or --file <path>), runs the canonical
 * `@kortix/manifest-schema` validator, then the project checks in
 * `project-lint.ts`: every sandbox Dockerfile the manifest points at, the agent
 * wiring, and the size of the files Git stores. Prints one colored report.
 *
 *   exit 0   — no errors (warnings may be present)
 *   exit 1   — one or more errors
 *   exit 2   — file missing or unreadable
 *
 * `kortix ship` runs the same checks before it commits, and the backend runs
 * the same schema on CR-merge. The repository size check is only ever a
 * warning: a large repository still pushes, but its agent config build fails
 * above 32 MiB compressed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  DEPRECATED_KORTIX_PERMISSION_ALIASES,
  GRANTABLE_KORTIX_PERMISSIONS,
  type ManifestIssue,
  ManifestImportError,
  formatIssues,
  hasManifestImports,
  manifestFormatForPath,
  validateManifest,
} from '@kortix/manifest-schema';
import { lintProject } from '../project-lint.ts';
import { resolveLocalManifestImports } from '../manifest-imports.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, status } from '../style.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';

const HELP = help`Usage: kortix validate [options]

Statically validate the project's kortix.yaml against the canonical schema,
and lint every \`sandbox.templates\` Dockerfile for the constraints the cloud
builder enforces (no COPY from the repo, no RUN heredocs, Debian-family base).
Warn when the files in Git are large: a session builds its agent config from
the whole repository, and that build fails above 32 MiB compressed. Keep big
static assets in object storage, not in Git. \`kortix ship\` runs these checks.

Options:
  --file <path>          Validate this file instead of ./kortix.yaml.
  --no-dockerfile-lint   Skip the sandbox Dockerfile checks (manifest only).
  --json                 Emit a machine-readable JSON report (no color).
  --scopes               Print the full grantable kortix_permissions enum and exit.
  -h, --help             Show this help.
`;

/** One line per agent: its assigned connectors + Kortix permissions. */
function describeAgents(parsed: Record<string, unknown> | null): string {
  const agents = parsed?.agents;
  if (!Array.isArray(agents) || agents.length === 0) return '';
  const show = (v: unknown): string =>
    v === 'all' ? 'all' : Array.isArray(v) ? v.join(', ') || 'none' : 'none (default-deny)';
  const lines = agents.map((a: any) => {
    const name = typeof a?.name === 'string' ? a.name : '(unnamed)';
    // `env` omitted == 'all' (the parser's default), so render it that way rather
    // than as default-deny — otherwise the summary misreports an unscoped agent.
    const env = a?.env === undefined || a?.env === null ? 'all' : a?.env;
    return `  ${C.cyan}${name}${C.reset}  connectors=[${show(a?.connectors)}]  kortix_permissions=[${show(a?.kortix_permissions ?? a?.kortix_cli)}]  env=[${show(env)}]`;
  });
  return `\n${C.dim}Per-agent scope (kortix.yaml [[agents]]):${C.reset}\n${lines.join('\n')}\n`;
}

export function runValidate(argv: string[]): number {
  const flags = takeFlags(argv, HELP, (rest) => ({
    file: takeFlagValue(rest, ['--file']),
    json: takeFlagBool(rest, ['--json']),
    scopes: takeFlagBool(rest, ['--scopes']),
    dockerfileLint: !takeFlagBool(rest, ['--no-dockerfile-lint']),
  }));
  if (typeof flags === 'number') return flags;
  if (flags.scopes) {
    process.stdout.write(
      `${C.dim}Grantable kortix_permissions (project-scoped — account-level admin actions can never be granted to an agent):${C.reset}\n`,
    );
    for (const a of GRANTABLE_KORTIX_PERMISSIONS) process.stdout.write(`  ${a}\n`);
    const renamed = Object.entries(DEPRECATED_KORTIX_PERMISSION_ALIASES);
    if (renamed.length > 0) {
      // Not grantable any more, but still ACCEPTED in a manifest that has one.
      // This list is what an agent reads to decide what to write, so it has to
      // say what the old name maps to rather than pretend it never existed.
      process.stdout.write(
        `\n${C.dim}Renamed — still accepted, but write the new name:${C.reset}\n`,
      );
      for (const [was, now] of renamed) {
        process.stdout.write(`  ${was}${C.dim} → ${now.join(', ')}${C.reset}\n`);
      }
    }
    return 0;
  }

  // Explicit --file wins; otherwise resolve the project's manifest, preferring
  // kortix.yaml over kortix.toml (falls back to kortix.yaml for the not-found msg).
  const filePath = flags.file
    ? resolve(process.cwd(), flags.file)
    : (resolveLocalManifest(process.cwd())?.path ?? resolve(process.cwd(), 'kortix.yaml'));
  if (!existsSync(filePath)) {
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ valid: false, error: 'file_not_found', path: filePath }) + '\n',
      );
    } else {
      process.stderr.write(
        `${status.err('Manifest not found')}\n` +
          `  ${C.dim}Looked for ${filePath}${C.reset}\n` +
          `  ${C.dim}Run from your project root, or pass${C.reset} ${C.cyan}--file <path>${C.reset}\n`,
      );
    }
    return 2;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ valid: false, error: 'read_failed', detail }) + '\n');
    } else {
      process.stderr.write(`${status.err(`Failed to read ${filePath}: ${detail}`)}\n`);
    }
    return 2;
  }

  let result = validateManifest(raw, manifestFormatForPath(filePath));
  // `imports:` — validate the MERGED document, the one the platform runs. A
  // broken import (missing file, duplicate name, cycle, root-only key in an
  // imported file) is an error here, the same one the CR-merge gate returns.
  if (result.parsed && hasManifestImports(result.parsed) && manifestFormatForPath(filePath) === 'yaml') {
    try {
      const merged = resolveLocalManifestImports(filePath, 'yaml');
      result = validateManifest(merged.raw, 'yaml');
    } catch (err) {
      if (!(err instanceof ManifestImportError)) throw err;
      result = {
        ...result,
        valid: false,
        issues: [...result.issues, { path: 'imports', message: err.message, severity: 'error' }],
      };
    }
  }

  // Manifest issues first, then the project checks — one merged report, one
  // exit code. A Dockerfile `error` fails `validate` exactly like a schema
  // error does; `ship` runs the same `lintProject` list and stops on it too.
  const issues = [
    ...result.issues,
    ...lintProject(result.parsed, filePath, { dockerfileLint: flags.dockerfileLint }),
  ];
  const valid = !issues.some((i) => i.severity === 'error');

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({
        valid,
        path: filePath,
        issues,
      }) + '\n',
    );
    return valid ? 0 : 1;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (valid && warnings.length === 0) {
    process.stdout.write(`${status.ok(`${basename(filePath)} is valid`)}\n`);
    process.stdout.write(describeAgents(result.parsed));
    return 0;
  }

  if (warnings.length > 0) {
    process.stdout.write(
      `${C.yellow}${warnings.length} warning${warnings.length === 1 ? '' : 's'}:${C.reset}\n`,
    );
    process.stdout.write(formatIssues(warnings) + '\n');
  }
  if (errors.length > 0) {
    process.stderr.write(
      `\n${C.red}${errors.length} error${errors.length === 1 ? '' : 's'}:${C.reset}\n`,
    );
    process.stderr.write(formatIssues(errors) + '\n');
    return 1;
  }

  return 0;
}
