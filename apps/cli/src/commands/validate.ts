/**
 * `kortix validate` — standalone manifest validator.
 *
 * Reads ./kortix.yaml (or --file <path>), runs the canonical
 * `@kortix/manifest-schema` validator, then statically lints every sandbox
 * Dockerfile the manifest points at, and prints one colored report.
 *
 *   exit 0   — no errors (warnings may be present)
 *   exit 1   — one or more errors
 *   exit 2   — file missing or unreadable
 *
 * Mirrors the same validator that `kortix ship` runs as a pre-flight check
 * and that the backend runs on CR-merge — there is exactly one schema, used
 * in three places. The Dockerfile lint rides the same three places for free:
 * a Dockerfile that can't build in the cloud is as much a broken project as a
 * malformed manifest, and both are decidable from text alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import {
  GRANTABLE_KORTIX_CLI_ACTIONS,
  type ManifestIssue,
  formatIssues,
  manifestFormatForPath,
  validateManifest,
} from '@kortix/manifest-schema';
import { extractSandboxTemplates } from '@kortix/shared/sandbox';
import { lintDockerfile } from '../dockerfile-lint.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix validate [options]

Statically validate the project's kortix.yaml against the canonical schema,
and lint every \`sandbox.templates\` Dockerfile for the constraints the cloud
builder enforces (no COPY from the repo, no RUN heredocs, Debian-family base).

Options:
  --file <path>          Validate this file instead of ./kortix.yaml.
  --no-dockerfile-lint   Skip the sandbox Dockerfile checks (manifest only).
  --json                 Emit a machine-readable JSON report (no color).
  --scopes               Print the full grantable kortix_cli action enum and exit.
  -h, --help             Show this help.
`;

interface Flags {
  file?: string;
  json: boolean;
  help: boolean;
  scopes: boolean;
  dockerfileLint: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, help: false, scopes: false, dockerfileLint: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) flags.file = argv[++i];
    else if (arg === '--json') flags.json = true;
    else if (arg === '--scopes') flags.scopes = true;
    else if (arg === '--no-dockerfile-lint') flags.dockerfileLint = false;
    else if (arg === '-h' || arg === '--help') flags.help = true;
  }
  return flags;
}

/**
 * Lint each `sandbox.templates[].dockerfile` that exists on disk, resolved
 * relative to the MANIFEST's directory (paths in kortix.yaml are repo-relative,
 * and --file may point outside the cwd).
 *
 * A declared-but-missing Dockerfile is NOT reported here: that's the manifest
 * validator's business, and inventing a second, differently-worded error for it
 * would just double up the report.
 */
function lintSandboxDockerfiles(
  parsed: Record<string, unknown> | null,
  manifestPath: string,
): ManifestIssue[] {
  if (!parsed) return [];
  const root = dirname(manifestPath);
  const issues: ManifestIssue[] = [];
  for (const tpl of extractSandboxTemplates(parsed)) {
    if (!tpl.dockerfile) continue;
    const abs = resolve(root, tpl.dockerfile);
    if (!existsSync(abs)) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Report the path as written in the manifest when it stays inside the
    // project, so the author sees the string they typed.
    const shown = relative(root, abs).startsWith('..') ? abs : tpl.dockerfile;
    issues.push(...lintDockerfile(text, { path: shown }));
  }
  return issues;
}

/** One line per agent: its assigned connectors + Kortix-CLI powers. */
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
    return `  ${C.cyan}${name}${C.reset}  connectors=[${show(a?.connectors)}]  kortix_cli=[${show(a?.kortix_cli)}]  env=[${show(env)}]`;
  });
  return `\n${C.dim}Per-agent scope (kortix.yaml [[agents]]):${C.reset}\n${lines.join('\n')}\n`;
}

export function runValidate(argv: string[]): number {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.scopes) {
    process.stdout.write(
      `${C.dim}Grantable kortix_cli actions (project-scoped — account-level admin actions can never be granted to an agent):${C.reset}\n`,
    );
    for (const a of GRANTABLE_KORTIX_CLI_ACTIONS) process.stdout.write(`  ${a}\n`);
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

  const result = validateManifest(raw, manifestFormatForPath(filePath));

  // Manifest issues first, then the Dockerfile lint — one merged report, one
  // exit code. A Dockerfile `error` fails `validate` exactly like a schema
  // error does, which is the whole point: `ship` and the CR-merge gate then
  // stop it without any extra wiring.
  const issues = [
    ...result.issues,
    ...(flags.dockerfileLint ? lintSandboxDockerfiles(result.parsed, filePath) : []),
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
