/**
 * `kortix tools` — the tools this project's sessions get, read from the local
 * kortix.yaml and its imports, and `eject`, which turns a Kortix tool into a
 * project tool the project owns.
 *
 *   kortix tools ls [--json]          name, kind, source; and the removed Kortix tools
 *   kortix tools eject <name>         tools/<name>.ts + `tools.<name>: tools/<name>.ts`
 *
 * Every Kortix tool is always registered; `tools:` maps a name to a project
 * module, and a Kortix tool's name replaces that tool. The ejected source is
 * the daemon's own module, embedded in `kortix-tools.generated.json`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  HARNESS_TOOL_NAMES,
  KORTIX_TOOL_NAMES,
  ManifestImportError,
  TOOL_NAME_RE,
  safeToolFile,
} from '@kortix/manifest-schema';
import { splitHelp } from '../command-argv.ts';
import { emitJson, takeFlagBool } from '../command-helpers.ts';
import KORTIX_TOOL_SOURCES from '../kortix-tools.generated.json' with { type: 'json' };
import { resolveLocalManifestImports } from '../manifest-imports.ts';
import { setYamlMapEntry } from '../manifest-edit.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix tools <subcommand> [options]

The tools this project's sessions get, from ./kortix.yaml \`tools:\` and its
imports. Kortix maintains these tools: ${KORTIX_TOOL_NAMES.join(', ')}.
Every Kortix tool is always registered. \`tools:\` maps a name to a project
module (\`<name>: <path to a .ts or .js module>\`), and a Kortix tool's name
replaces that tool.

Subcommands:
  ls [--json]               List each tool the sessions get: name, kind
                            (kortix, kortix (overridden), project) and source.
  eject <name> [--force]    Copy the Kortix tool <name> to tools/<name>.ts and
                            set \`tools.<name>: tools/<name>.ts\` in kortix.yaml.
                            The copy is yours to change; Kortix no longer
                            updates it. Refuses when tools/<name>.ts exists.

Options:
  --json        ls: machine-readable output.
  --force       eject: overwrite tools/<name>.ts.
  -h, --help    Show this help.

Limit the tools of one agent: \`agents.<name>.tools\` in kortix.yaml
(\`tools: { exclude: [web_search] }\`).
`;

type ToolKind = 'kortix' | 'kortix (overridden)' | 'project';

interface ToolRow {
  name: string;
  kind: ToolKind;
  source: string;
}

const isKortixTool = (name: string) => (KORTIX_TOOL_NAMES as readonly string[]).includes(name);

/**
 * What a session of this manifest loads, as the API compiles it
 * (compile-agent-config.ts `compileTools`): every Kortix tool, replaced by the
 * project module that `tools.<name>` names, then the project's own tools.
 */
export function listTools(raw: Record<string, unknown>): ToolRow[] {
  const tools = raw.tools;
  const map = tools && typeof tools === 'object' && !Array.isArray(tools) ? (tools as Record<string, unknown>) : {};
  const rows: ToolRow[] = KORTIX_TOOL_NAMES.map((name) => {
    const path = safeToolFile(map[name]);
    return path ? { name, kind: 'kortix (overridden)', source: path } : { name, kind: 'kortix', source: `kortix:${name}` };
  });
  for (const [name, value] of Object.entries(map)) {
    const path = safeToolFile(value);
    const reserved = (HARNESS_TOOL_NAMES as readonly string[]).includes(name) || name.startsWith('pty_');
    if (!isKortixTool(name) && path && TOOL_NAME_RE.test(name) && !reserved) rows.push({ name, kind: 'project', source: path });
  }
  return rows;
}

/** The local manifest, merged with its imports, or an exit code after printing why not. */
function readManifest(): { file: string; raw: Record<string, unknown>; origins: Record<string, string> } | number {
  const found = resolveLocalManifest(process.cwd());
  if (!found) {
    process.stderr.write(`${status.err('Manifest not found')}\n  ${C.dim}Run from your project root (the folder with kortix.yaml).${C.reset}\n`);
    return 2;
  }
  try {
    const resolved = resolveLocalManifestImports(found.path);
    return { file: found.path, raw: resolved.raw, origins: resolved.origins.tools };
  } catch (err) {
    const detail = err instanceof ManifestImportError ? err.message : `cannot parse ${found.path}: ${(err as Error).message}`;
    process.stderr.write(`${status.err(detail)}\n  ${C.dim}Run \`kortix validate\` for the full report.${C.reset}\n`);
    return 1;
  }
}

function toolsLs(json: boolean): number {
  const manifest = readManifest();
  if (typeof manifest === 'number') return manifest;
  const tools = listTools(manifest.raw);
  if (json) {
    emitJson({ manifest: manifest.file, tools });
    return 0;
  }
  const nameWidth = Math.max(4, ...tools.map((row) => row.name.length)) + 2;
  const kindWidth = Math.max(4, ...tools.map((row) => row.kind.length)) + 2;
  process.stdout.write(`${C.dim}${pad('NAME', nameWidth)}${pad('KIND', kindWidth)}SOURCE${C.reset}\n`);
  for (const row of tools) process.stdout.write(`${pad(row.name, nameWidth)}${pad(row.kind, kindWidth)}${row.source}\n`);
  return 0;
}

function toolsEject(name: string | undefined, force: boolean): number {
  if (!name || !isKortixTool(name)) {
    process.stderr.write(
      `${status.err(name ? `"${name}" is not a Kortix tool.` : 'Name the Kortix tool to eject.')}\n` +
        `  ${C.dim}Eject one of: ${KORTIX_TOOL_NAMES.join(', ')}.${C.reset}\n`,
    );
    return 2;
  }
  const manifest = readManifest();
  if (typeof manifest === 'number') return manifest;
  const root = dirname(manifest.file);
  const target = `tools/${name}.ts`;
  const map = manifest.raw.tools && typeof manifest.raw.tools === 'object' ? (manifest.raw.tools as Record<string, unknown>) : {};
  const current = map[name];
  const owned = safeToolFile(current);
  if (!force && owned && owned !== target) {
    process.stderr.write(
      `${status.err(`${name} is already the project's own module: ${owned}.`)}\n  ${C.dim}Pass --force to replace it with a fresh copy at ${target}.${C.reset}\n`,
    );
    return 1;
  }
  if (!force && existsSync(resolve(root, target))) {
    process.stderr.write(`${status.err(`${target} exists.`)}\n  ${C.dim}Pass --force to overwrite it with the Kortix source.${C.reset}\n`);
    return 1;
  }

  mkdirSync(resolve(root, 'tools'), { recursive: true });
  writeFileSync(resolve(root, target), (KORTIX_TOOL_SOURCES as Record<string, string>)[name]!, 'utf8');

  // The file that declares the entry gets the edit; a new entry goes to the root manifest.
  const declaring = manifest.origins[name] ? resolve(root, manifest.origins[name]!) : manifest.file;
  const comment = `ejected from kortix:${name}`;
  setYamlMapEntry(declaring, 'tools', name, target, comment);

  const edited = relative(root, declaring);
  process.stdout.write(`${status.ok(`Ejected ${name}`)}\n`);
  process.stdout.write(`  ${C.dim}wrote${C.reset}   ${target} ${C.dim}(the Kortix source, now the project's to change)${C.reset}\n`);
  process.stdout.write(`  ${C.dim}set${C.reset}     ${edited}: tools.${name}: ${target}\n`);
  process.stdout.write(
    `\nNext:\n` +
      `  1. Edit ${target}. Keep the default export: { description, parameters, execute(args, context) }.\n` +
      `  2. kortix validate\n` +
      `  3. git add ${target} ${edited} && git commit -m "Own the ${name} tool"\n` +
      `  4. Open a change request: git push origin HEAD && kortix cr open --title "Own the ${name} tool"\n` +
      `${C.dim}Sessions load the copy after the change request merges.${C.reset}\n`,
  );
  return 0;
}

export function runTools(argv: string[]): number {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const [sub, ...rest] = argv;
  const json = takeFlagBool(rest, ['--json']);
  const force = takeFlagBool(rest, ['--force']);
  const unknown = rest.find((arg) => arg.startsWith('-'));
  if (unknown) {
    process.stderr.write(`unknown option "${unknown}"\n\n${HELP}`);
    return 2;
  }
  switch (sub) {
    case 'ls':
    case 'list':
      return toolsLs(json);
    case 'eject':
      return toolsEject(rest[0], force);
    default:
      process.stderr.write(`unknown subcommand "${sub}"\n\n${HELP}`);
      return 2;
  }
}
