/**
 * `kortix validate` — standalone manifest validator.
 *
 * Reads ./kortix.toml (or --file <path>), runs the canonical
 * `@kortix/manifest-schema` validator, and prints a colored report.
 *
 *   exit 0   — no errors (warnings may be present)
 *   exit 1   — one or more errors
 *   exit 2   — file missing or unreadable
 *
 * Mirrors the same validator that `kortix ship` runs as a pre-flight check
 * and that the backend runs on CR-merge — there is exactly one schema, used
 * in three places.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  GRANTABLE_KORTIX_CLI_ACTIONS,
  formatIssues,
  manifestFormatForPath,
  validateManifest,
} from '@kortix/manifest-schema';
import { resolveLocalManifest } from '../manifest.ts';
import { C, status } from '../style.ts';

const HELP = `Usage: kortix validate [options]

Statically validate the project's kortix.toml against the canonical schema.

Options:
  --file <path>   Validate this file instead of ./kortix.toml.
  --json          Emit a machine-readable JSON report (no color).
  --scopes        Print the full grantable kortix_cli action enum and exit.
  -h, --help      Show this help.
`;

interface Flags {
  file?: string;
  json: boolean;
  help: boolean;
  scopes: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, help: false, scopes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) flags.file = argv[++i];
    else if (arg === '--json') flags.json = true;
    else if (arg === '--scopes') flags.scopes = true;
    else if (arg === '-h' || arg === '--help') flags.help = true;
  }
  return flags;
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
  return `\n${C.dim}Per-agent scope (kortix.toml [[agents]]):${C.reset}\n${lines.join('\n')}\n`;
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
  // kortix.yaml over kortix.toml (falls back to kortix.toml for the not-found msg).
  const filePath = flags.file
    ? resolve(process.cwd(), flags.file)
    : (resolveLocalManifest(process.cwd())?.path ?? resolve(process.cwd(), 'kortix.toml'));
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

  if (flags.json) {
    process.stdout.write(
      JSON.stringify({
        valid: result.valid,
        path: filePath,
        issues: result.issues,
      }) + '\n',
    );
    return result.valid ? 0 : 1;
  }

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');

  if (result.valid && warnings.length === 0) {
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
