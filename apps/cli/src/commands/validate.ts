/**
 * `kortix validate` — standalone project validator.
 *
 * Reads ./kortix.yaml (or --file <path>), runs the canonical
 * `@kortix/manifest-schema` validator, then the project checks in
 * `project-lint.ts`: every sandbox Dockerfile the manifest points at, the agent
 * wiring, and the size of the files Git stores. Prints one line per issue:
 * `<file>:<line>:<col>  <severity>  <path>  <message>`.
 *
 *   exit 0   — no errors (warnings may be present)
 *   exit 1   — one or more errors
 *   exit 2   — file missing or unreadable
 *
 * `kortix ship` runs the same checks before it commits, and the backend runs
 * the same schema on CR-merge. The repository size check is only ever a
 * warning: a large repository still pushes and its sessions still start, but
 * above 512 MiB compressed a running session stops picking up config changes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { DEPRECATED_KORTIX_PERMISSION_ALIASES, fixManifestText, GRANTABLE_KORTIX_PERMISSIONS } from '@kortix/manifest-schema';
import { type FileIssue, formatIssueLine, validateManifestFile } from '../manifest.ts';
import { resolveLocalManifestImports } from '../manifest-imports.ts';
import { applyLocalLegacy, convertLocalLegacy, localManifestFile, readLegacyManifest } from '../manifest-legacy.ts';
import { C, help, status } from '../style.ts';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool, takeFlagValue } from '../command-helpers.ts';

const HELP = help`Usage: kortix validate [options]

Statically validate the project's kortix.yaml against the canonical schema,
and lint every \`sandbox.templates\` Dockerfile for the constraints the cloud
builder enforces (no COPY from the repo, no RUN heredocs, Debian-family base).
Warn when the files in Git are large: every session downloads them, and above
512 MiB compressed a running session stops picking up agent config changes
from the base branch. Keep big static assets in object storage, not in Git.
\`kortix ship\` runs these checks.

Prints one line per issue: <file>:<line>:<col>  <severity>  <path>  <message>.
An entry that \`imports:\` brings in is reported in the file that declares it.
Exit 1 on any error; warnings alone exit 0.

A deprecated shape still works and is a warning with \`fix: <id>\`. \`--fix\`
rewrites every deprecated shape to the latest one, in kortix.yaml and in the
files it imports, keeping comments, then validates. An older format
(\`kortix_version: 2\`, or a kortix.toml) still works too: it is validated as
converted, and \`--fix\` converts the files (kortix.toml becomes kortix.yaml,
each agent .md keeps only its prompt).

Options:
  --file <path>          Validate this file instead of ./kortix.yaml (or kortix.toml).
  --fix                  Rewrite deprecated shapes to the latest shape first.
  --no-dockerfile-lint   Skip the sandbox Dockerfile checks (manifest only).
  --json                 Emit a machine-readable JSON report (no color).
  --scopes               Print the full grantable kortix_permissions enum and exit.
  -h, --help             Show this help.
`;

/** One line per agent: what it enables. Every grant is deny-by-default. */
function describeAgents(parsed: Record<string, unknown> | null): string {
  const agents = parsed?.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return '';
  const show = (v: unknown): string =>
    v === 'all' ? 'all' : Array.isArray(v) ? v.join(', ') || 'none' : 'none (default-deny)';
  const keys = ['skills', 'subagents', 'commands', 'extensions', 'connectors', 'secrets'];
  const lines = Object.entries(agents as Record<string, Record<string, unknown> | null>).map(
    ([name, block]) => `  ${C.cyan}${name}${C.reset}  ${keys.map((key) => `${key}=[${show(block?.[key])}]`).join('  ')}`,
  );
  return lines.length === 0 ? '' : `\n${C.dim}What each agent enables:${C.reset}\n${lines.join('\n')}\n`;
}

/**
 * `--fix` for a legacy file (`kortix_version` 1 or 2, or `kortix.toml`):
 * write the converted project, and return the manifest to validate next. A
 * file in the current format is returned as is. Null when the legacy file
 * cannot be read.
 */
function convertLegacyFile(filePath: string, json: boolean): string | null {
  const root = dirname(filePath);
  let legacy;
  try {
    legacy = readLegacyManifest(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (json) process.stdout.write(JSON.stringify({ valid: false, error: 'read_failed', detail }) + '\n');
    else process.stderr.write(`${status.err(`Failed to read ${filePath}: ${detail}`)}\n`);
    return null;
  }
  if (!legacy) return filePath;
  const conversion = convertLocalLegacy(root, legacy);
  const touched = applyLocalLegacy(root, legacy, conversion);
  const manifest = resolve(root, conversion.changes[0]!.path);
  if (!json) {
    const shown = relative(process.cwd(), legacy.path) || basename(legacy.path);
    const target = relative(process.cwd(), manifest) || basename(manifest);
    process.stdout.write(`${status.ok(`${shown}: converted to ${target === shown ? '' : `${target}, `}the current format`)}\n`);
    for (const change of conversion.changes) {
      if (!touched.includes(change.path)) continue;
      process.stdout.write(`  ${C.dim}${change.action === 'delete' ? 'deleted' : 'wrote'} ${change.path}${change.note ? ` (${change.note})` : ''}${C.reset}\n`);
    }
    for (const note of conversion.dropped) process.stdout.write(`  ${C.yellow}not carried over${C.reset} ${note}\n`);
  }
  return manifest;
}

export function runValidate(argv: string[]): number {
  const flags = takeFlags(argv, HELP, (rest) => ({
    file: takeFlagValue(rest, ['--file']),
    json: takeFlagBool(rest, ['--json']),
    fix: takeFlagBool(rest, ['--fix']),
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

  // Explicit --file wins; otherwise the project's kortix.yaml (or kortix.yml, or a legacy kortix.toml).
  let filePath = flags.file
    ? resolve(process.cwd(), flags.file)
    : (localManifestFile(process.cwd()) ?? resolve(process.cwd(), 'kortix.yaml'));
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

  if (flags.fix) {
    const root = dirname(filePath);
    const converted = convertLegacyFile(filePath, flags.json);
    if (converted === null) return 2;
    filePath = converted;
    let paths = [filePath];
    try {
      paths = resolveLocalManifestImports(filePath).files.map((file) => resolve(root, file.path));
    } catch {
      // A broken file or import: fix what can be read, and let validation report the rest.
    }
    for (const path of paths) {
      const { text, fixed } = fixManifestText(readFileSync(path, 'utf8'));
      if (fixed.length === 0) continue;
      writeFileSync(path, text, 'utf8');
      if (!flags.json) {
        process.stdout.write(`${status.ok(`${relative(process.cwd(), path) || basename(path)}: rewrote ${fixed.map((f) => `${f.path} (${f.id})`).join(', ')}`)}\n`);
      }
    }
  }

  // Manifest issues first, then the project checks — one merged report, one
  // exit code. A Dockerfile `error` fails `validate` exactly like a schema
  // error does; `ship` runs the same checks and stops on it too.
  let parsed: Record<string, unknown> | null;
  let issues: FileIssue[];
  try {
    ({ parsed, issues } = validateManifestFile(filePath, { dockerfileLint: flags.dockerfileLint }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ valid: false, error: 'read_failed', detail }) + '\n');
    } else {
      process.stderr.write(`${status.err(`Failed to read ${filePath}: ${detail}`)}\n`);
    }
    return 2;
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (flags.json) {
    process.stdout.write(JSON.stringify({ valid: errors.length === 0, path: filePath, issues }) + '\n');
    return errors.length === 0 ? 0 : 1;
  }

  for (const w of warnings) process.stdout.write(`${formatIssueLine(w)}\n`);
  for (const e of errors) process.stderr.write(`${formatIssueLine(e)}\n`);
  const counts = `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  if (errors.length > 0) {
    process.stderr.write(`\n${status.err(`${basename(filePath)}: ${counts}`)}\n`);
    return 1;
  }
  process.stdout.write(`${warnings.length > 0 ? '\n' : ''}${status.ok(`${basename(filePath)} is valid${warnings.length > 0 ? ` (${counts})` : ''}`)}\n`);
  process.stdout.write(describeAgents(parsed));
  return 0;
}
