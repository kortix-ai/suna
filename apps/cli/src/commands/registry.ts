/**
 * `kortix registry <subcommand>` — author and inspect registry.json files.
 *
 *   kortix registry build      Scan this repo → registry.json (now it's a registry)
 *   kortix registry validate   Validate a registry.json
 *   kortix registry list <reg> List the items in a registry
 *   kortix registry view <item>Show one item's details
 *   kortix registry search <reg> --query <q>
 *
 * The format is shadcn-compatible (registry.json / registry-item.json), so any
 * Kortix repo with a registry.json is marketplace-addressable and readable by
 * shadcn tooling for plain files.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildRegistry,
  formatIssues,
  loadItem,
  loadRegistry,
  parseItemAddress,
  parseRegistryAddress,
  validateRegistry,
  type RegistryItem,
  type RegistryLoaderOptions,
} from '@kortix/registry';
import { emitJson } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix registry <subcommand> [options]

Author and inspect Kortix registries (shadcn-compatible registry.json).

Subcommands:
  build               Scan this repo and write a registry.json.
  validate [path]     Validate a registry.json (default: ./registry.json).
  list <registry>     List items in a registry (owner/repo, URL, or ./path).
  view <item>         Show one item (owner/repo/item, URL, or ./path#item).
  search <registry>   Filter a registry's items with --query.

Options:
  --out <path>        build: where to write (default: ./registry.json).
  --root <dir>        build: repo root to scan (default: cwd).
  --name <name>       build: registry name (default: project name).
  --homepage <url>    build: registry homepage.
  --stdout            build: print to stdout instead of writing a file.
  --query <text>      search: case-insensitive filter over name/title/desc.
  --ref <ref>         list/view: git ref for a GitHub registry.
  --json              Machine-readable output.
  -h, --help          Show this help.
`;

function loaderOptions(ref?: string): RegistryLoaderOptions {
  return { defaultRefs: ref ? [ref] : ['main', 'master'] };
}

function takeValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v && !v.startsWith('-')) {
    argv.splice(i, 2);
    return v;
  }
  argv.splice(i, 1);
  return undefined;
}

function takeBool(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

export async function runRegistry(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const json = takeBool(rest, '--json');

  switch (sub) {
    case 'build':
      return registryBuild(rest, json);
    case 'validate':
      return registryValidate(rest, json);
    case 'list':
    case 'ls':
      return registryList(rest, json);
    case 'view':
      return registryView(rest, json);
    case 'search':
      return registrySearch(rest, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

function registryBuild(argv: string[], json: boolean): number {
  const out = takeValue(argv, '--out');
  const root = resolve(takeValue(argv, '--root') ?? process.cwd());
  const name = takeValue(argv, '--name');
  const homepage = takeValue(argv, '--homepage');
  const toStdout = takeBool(argv, '--stdout');

  const { registry, counts } = buildRegistry({ root, name, homepage });
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;

  if (toStdout) {
    process.stdout.write(serialized);
    return 0;
  }
  if (json) {
    emitJson({ name: registry.name, items: registry.items?.length ?? 0, counts });
    return 0;
  }

  const outPath = resolve(out ?? `${root}/registry.json`);
  writeFileSync(outPath, serialized, 'utf8');
  const total = registry.items?.length ?? 0;
  process.stdout.write(`${status.ok(`Wrote ${C.bold}${outPath}${C.reset}`)}\n`);
  process.stdout.write(
    `  ${C.dim}${total} items${C.reset} — ` +
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
        .join(', ') +
      '\n',
  );
  process.stdout.write(
    `  ${C.dim}Commit it and others can${C.reset} ${C.dim}point an agent at this repo to import ${registry.name}/<item>${C.reset}\n`,
  );
  return 0;
}

function registryValidate(argv: string[], json: boolean): number {
  const path = resolve(argv.find((a) => !a.startsWith('-')) ?? `${process.cwd()}/registry.json`);
  if (!existsSync(path)) {
    process.stderr.write(`${status.err(`registry.json not found at ${path}`)}\n`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    process.stderr.write(`${status.err(`invalid JSON: ${(err as Error).message}`)}\n`);
    return 2;
  }
  const result = validateRegistry(parsed);
  if (json) {
    emitJson(result);
    return result.valid ? 0 : 1;
  }
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  if (result.valid && warnings.length === 0) {
    process.stdout.write(`${status.ok('registry.json is valid')}\n`);
    return 0;
  }
  if (warnings.length > 0) {
    process.stdout.write(`${C.yellow}${warnings.length} warning(s):${C.reset}\n${formatIssues(warnings)}\n`);
  }
  if (errors.length > 0) {
    process.stderr.write(`${C.red}${errors.length} error(s):${C.reset}\n${formatIssues(errors)}\n`);
    return 1;
  }
  return 0;
}

async function registryList(argv: string[], json: boolean): Promise<number> {
  const ref = takeValue(argv, '--ref');
  const address = argv.find((a) => !a.startsWith('-'));
  if (!address) {
    process.stderr.write(`${status.err('pass a registry: kortix registry list owner/repo')}\n`);
    return 2;
  }
  let items: RegistryItem[];
  let registryName: string;
  try {
    const resolved = await loadRegistry(parseRegistryAddress(address), loaderOptions(ref));
    items = resolved.registry.items ?? [];
    registryName = resolved.registry.name;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  if (json) {
    emitJson(items.map((i) => ({ name: i.name, type: i.type, title: i.title, description: i.description })));
    return 0;
  }
  printItemTable(registryName, items);
  return 0;
}

async function registrySearch(argv: string[], json: boolean): Promise<number> {
  const ref = takeValue(argv, '--ref');
  const query = (takeValue(argv, '--query') ?? '').toLowerCase();
  const address = argv.find((a) => !a.startsWith('-'));
  if (!address) {
    process.stderr.write(`${status.err('pass a registry: kortix registry search owner/repo --query <q>')}\n`);
    return 2;
  }
  let items: RegistryItem[];
  let registryName: string;
  try {
    const resolved = await loadRegistry(parseRegistryAddress(address), loaderOptions(ref));
    registryName = resolved.registry.name;
    items = (resolved.registry.items ?? []).filter((i) =>
      `${i.name} ${i.title ?? ''} ${i.description ?? ''} ${(i.categories ?? []).join(' ')}`
        .toLowerCase()
        .includes(query),
    );
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  if (json) {
    emitJson(items.map((i) => ({ name: i.name, type: i.type, title: i.title, description: i.description })));
    return 0;
  }
  printItemTable(registryName, items);
  return 0;
}

async function registryView(argv: string[], json: boolean): Promise<number> {
  const ref = takeValue(argv, '--ref');
  const address = argv.find((a) => !a.startsWith('-'));
  if (!address) {
    process.stderr.write(`${status.err('pass an item: kortix registry view owner/repo/item')}\n`);
    return 2;
  }
  let resolved;
  try {
    resolved = await loadItem(parseItemAddress(address), loaderOptions(ref));
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }
  if (json) {
    emitJson(resolved.item);
    return 0;
  }
  const it = resolved.item;
  process.stdout.write(`\n  ${C.bold}${it.title || it.name}${C.reset} ${C.faded}${it.type}${C.reset}\n`);
  if (it.description) process.stdout.write(`  ${C.dim}${it.description}${C.reset}\n`);
  if (it.author) process.stdout.write(`  ${C.dim}by ${it.author}${C.reset}\n`);
  if (it.registryDependencies?.length) {
    process.stdout.write(`\n  ${C.dim}Depends on:${C.reset} ${it.registryDependencies.join(', ')}\n`);
  }
  if (it.files?.length) {
    process.stdout.write(`\n  ${C.dim}Files:${C.reset}\n`);
    for (const f of it.files) process.stdout.write(`    ${f.target ?? f.path}\n`);
  }
  const envKeys = Object.keys(it.envVars ?? {});
  if (envKeys.length) process.stdout.write(`\n  ${C.dim}Secrets:${C.reset} ${envKeys.join(', ')}\n`);
  process.stdout.write(`\n  ${C.dim}Add to a project:${C.reset} ${C.dim}start a session and ask the agent to import "${address}"${C.reset}\n`);
  return 0;
}

function printItemTable(registryName: string, items: RegistryItem[]): void {
  process.stdout.write(`\n  ${C.bold}${registryName}${C.reset} ${C.faded}— ${items.length} items${C.reset}\n\n`);
  if (items.length === 0) {
    process.stdout.write(`  ${C.dim}(no items)${C.reset}\n`);
    return;
  }
  const nameWidth = Math.min(28, Math.max(...items.map((i) => i.name.length)));
  for (const it of items) {
    const kind = it.type.replace('registry:', '');
    const desc = it.description ?? it.title ?? '';
    const trimmed = desc.length > 64 ? `${desc.slice(0, 61)}…` : desc;
    process.stdout.write(
      `  ${C.cyan}${it.name.padEnd(nameWidth)}${C.reset}  ${C.faded}${kind.padEnd(8)}${C.reset}  ${C.dim}${trimmed}${C.reset}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}Add one to a project:${C.reset} ${C.dim}start a session and ask the agent to import ${registryName}/<name>${C.reset}\n`);
}
