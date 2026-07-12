/**
 * Installer implementation backing `kortix marketplace install`.
 *
 *   kortix marketplace install kortix-ai/skills/pdf
 *   kortix marketplace install github:kortix-ai/skills@v1/pdf
 *   kortix marketplace install @kortix/pdf
 *   kortix marketplace install ./local/registry.json#pdf
 *   kortix marketplace install https://host/r/pdf.json
 *
 * Default target is the local working tree (files written under .kortix/,
 * you commit). `--project <id>` commits straight into a linked cloud project's
 * repo instead (lands in the next session, no local clone).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type InstallPlan,
  type RegistryLoaderOptions,
  type RegistryRef,
  type ResolvedItem,
  applyInstall,
  loadItem,
  nodeFsExists,
  parseItemAddress,
  planInstall,
  resolveOpencodeDir,
} from '@kortix/registry';
import { emitJson, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, status } from '../style.ts';

/** Shape returned by GET /v1/marketplace/items. */
interface CatalogItem {
  id: string;
  registry: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
  capabilities: { secrets: string[]; connectors: string[]; tools: string[]; network: string[] };
  dependencies: string[];
}
interface InstallResponse {
  ok: boolean;
  commit_sha: string;
  branch: string;
  file_count: number;
  installed: Array<{ name: string; type: string }>;
  capabilities: { secrets: string[]; connectors: string[]; tools: string[]; network: string[] };
}

const HELP = help`Usage: kortix marketplace install <item> [options]

Install a marketplace item into this project. Items can be skills, agents,
commands, tools, files, folders, or bundles.

Address forms:
  pdf                        A marketplace item name
  kortix-starter:pdf         A marketplace item id
  owner/repo/item            A legacy GitHub registry item
  github:owner/repo@ref/item Pin to a branch/tag/sha
  @namespace/item            A legacy namespaced registry item
  ./path/registry.json#item  A legacy local registry item
  https://host/r/item.json   A legacy direct item URL

Options:
  --root <dir>      Project root to install into (default: cwd).
  --project <id>    Commit into a linked cloud project's repo instead of cwd.
  --host <name>     Use a configured Kortix host for --project installs.
  --ref <ref>       Git ref for a GitHub registry (default: main, then master).
  --namespace <a=b> Legacy namespace to item URL template (repeatable).
  --overwrite       Overwrite files that already exist.
  --dry-run         Show what would be installed without writing anything.
  --json            Machine-readable output.
  -h, --help        Show this help.
`;

interface Flags {
  root: string;
  rootExplicit: boolean;
  project?: string;
  host?: string;
  ref?: string;
  namespaces: Record<string, string>;
  overwrite: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseFlags(argv: string[]): { address?: string; flags: Flags } {
  const flags: Flags = {
    root: process.cwd(),
    rootExplicit: false,
    namespaces: {},
    overwrite: false,
    dryRun: false,
    json: false,
  };
  let address: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      flags.root = resolve(argv[++i]);
      flags.rootExplicit = true;
    } else if (arg === '--project' && argv[i + 1]) flags.project = argv[++i];
    else if (arg === '--host' && argv[i + 1]) flags.host = argv[++i];
    else if (arg === '--ref' && argv[i + 1]) flags.ref = argv[++i];
    else if (arg === '--namespace' && argv[i + 1]) {
      const [k, v] = argv[++i].split('=');
      if (k && v) flags.namespaces[k] = v;
    } else if (arg === '--overwrite' || arg === '--force') flags.overwrite = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--json') flags.json = true;
    else if (!arg.startsWith('-') && !address) address = arg;
  }
  return { address, flags };
}

function loaderOptions(flags: Flags): RegistryLoaderOptions {
  return {
    defaultRefs: flags.ref ? [flags.ref] : ['main', 'master'],
    namespaces: flags.namespaces,
  };
}

/** A dependency resolver that resolves bare names against the parent registry. */
function makeResolver(flags: Flags) {
  return (rawAddress: string, parent: RegistryRef): Promise<ResolvedItem> =>
    loadItem(parseItemAddress(rawAddress), { ...loaderOptions(flags), defaultRegistry: parent });
}

function configDirFor(root: string): string {
  // Resolve kortix.yaml or kortix.toml (yaml preferred); resolveOpencodeDir reads
  // either format's [opencode] config_dir. Hardcoding kortix.toml here would use
  // the default dir for a yaml project, installing into the wrong place.
  const resolved = resolveLocalManifest(root);
  const raw = resolved ? readFileSync(resolved.path, 'utf8') : null;
  return resolveOpencodeDir(raw);
}

export async function runMarketplaceInstall(argv: string[]): Promise<number> {
  const { address, flags } = parseFlags(argv);
  if (!address || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return address ? 0 : 2;
  }

  // Default cloud path: install straight into the linked project's repo (no
  // local clone). `--root` keeps the developer/local registry path explicit.
  // The address is resolved against the project's marketplace catalog, so it
  // may be a bare name ("pdf"), a catalog id ("kortix-starter:pdf"), or a title.
  if (flags.project || !flags.rootExplicit) {
    return installToProject(address, flags);
  }

  let resolved: ResolvedItem;
  try {
    resolved = await loadItem(parseItemAddress(address), loaderOptions(flags));
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 1;
  }

  const configDir = configDirFor(flags.root);
  const plan = await planInstall(resolved, {
    configDir,
    exists: nodeFsExists(flags.root),
    resolveDependency: makeResolver(flags),
  });

  if (flags.json && flags.dryRun) {
    emitJson({
      item: resolved.item.name,
      type: resolved.item.type,
      writes: plan.writes.map((w) => ({ target: w.target, exists: w.exists })),
      dependencies: plan.dependencies,
      envVars: plan.envVars,
      warnings: plan.warnings,
    });
    return 0;
  }

  printPlan(resolved, plan, flags);

  if (flags.dryRun) {
    process.stdout.write(`\n  ${C.dim}Dry run — nothing written.${C.reset}\n`);
    return 0;
  }

  const result = applyInstall(plan, {
    root: flags.root,
    overwrite: flags.overwrite,
    now: new Date().toISOString(),
  });

  process.stdout.write('\n');
  for (const t of result.written) process.stdout.write(`${status.ok(t)}\n`);
  for (const t of result.skipped) {
    process.stdout.write(`${status.warn(`${t} (exists — use --overwrite)`)}\n`);
  }
  const verb = result.written.length === 1 ? 'file' : 'files';
  process.stdout.write(
    `\n${status.ok(`Installed ${C.bold}${resolved.item.name}${C.reset} — ${result.written.length} ${verb} written`)}\n`,
  );
  if (result.written.length > 0) {
    process.stdout.write(
      `  ${C.dim}Commit + ship to make it live:${C.reset} ${C.cyan}git add -A && git commit -m "add ${resolved.item.name}" && kortix ship${C.reset}\n`,
    );
  }
  return 0;
}

function printPlan(resolved: ResolvedItem, plan: InstallPlan, flags: Flags): void {
  const title = resolved.item.title || resolved.item.name;
  process.stdout.write(
    `\n  ${C.bold}${title}${C.reset} ${C.faded}(${resolved.item.type.replace('registry:', '')})${C.reset}\n`,
  );
  if (resolved.item.description) {
    process.stdout.write(`  ${C.dim}${resolved.item.description}${C.reset}\n`);
  }
  if (plan.dependencies.length > 0) {
    process.stdout.write(
      `\n  ${C.dim}Pulls dependencies:${C.reset} ${plan.dependencies.join(', ')}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}Files → ${flags.root === process.cwd() ? '.' : flags.root}${C.reset}\n`,
  );
  for (const w of plan.writes) {
    const mark = w.exists ? `${C.yellow}~${C.reset}` : `${C.green}+${C.reset}`;
    process.stdout.write(
      `    ${mark} ${w.target}${w.exists ? ` ${C.faded}(exists)${C.reset}` : ''}\n`,
    );
  }
  const envKeys = Object.keys(plan.envVars);
  if (envKeys.length > 0) {
    process.stdout.write(`\n  ${C.dim}Needs secrets:${C.reset} ${envKeys.join(', ')}\n`);
    process.stdout.write(
      `  ${C.dim}Set them with${C.reset} ${C.cyan}kortix secrets set <KEY> <value>${C.reset}\n`,
    );
  }
  for (const warn of plan.warnings) process.stdout.write(`${status.warn(warn)}\n`);
}

/** Install a marketplace item straight into a linked cloud project's repo. */
async function installToProject(address: string, flags: Flags): Promise<number> {
  const ctx = await resolveProjectContext({ projectArg: flags.project, hostArg: flags.host });
  if (!ctx) return 1;

  let items: CatalogItem[];
  try {
    const res = await ctx.client.get<{ items: CatalogItem[] }>(
      `/marketplace/items?query=${encodeURIComponent(address)}`,
    );
    items = res.items ?? [];
  } catch (err) {
    return surfaceApiError(err);
  }

  const match =
    items.find((i) => i.id === address) ??
    items.find((i) => i.name === address) ??
    items.find((i) => i.id.endsWith(`:${address}`)) ??
    (items.length === 1 ? items[0] : undefined);

  if (!match) {
    process.stderr.write(
      `${status.err(`No marketplace item matches "${address}".`)} ` +
        `Browse with ${C.cyan}kortix marketplace search ${address}${C.reset} or the web marketplace.\n`,
    );
    if (items.length > 1) {
      process.stdout.write(
        `  ${C.dim}Did you mean:${C.reset} ${items
          .slice(0, 6)
          .map((i) => i.id)
          .join(', ')}\n`,
      );
    }
    return 1;
  }

  if (!flags.json) {
    process.stdout.write(
      `\n  ${C.bold}${match.title}${C.reset} ${C.faded}(${match.type.replace('registry:', '')})${C.reset}\n`,
    );
    if (match.description) process.stdout.write(`  ${C.dim}${match.description}${C.reset}\n`);
    if (match.dependencies.length > 0) {
      process.stdout.write(`  ${C.dim}Pulls:${C.reset} ${match.dependencies.join(', ')}\n`);
    }
    const secrets = match.capabilities?.secrets ?? [];
    if (secrets.length > 0) {
      process.stdout.write(`  ${C.dim}Needs secrets:${C.reset} ${secrets.join(', ')}\n`);
    }
  }

  if (flags.dryRun) {
    process.stdout.write(
      `\n  ${C.dim}Dry run — would commit to ${C.reset}${C.bold}${ctx.projectId}${C.reset}${C.dim} (${match.id}).${C.reset}\n`,
    );
    return 0;
  }

  let res: InstallResponse;
  try {
    res = await ctx.client.post<InstallResponse>(`/projects/${ctx.projectId}/marketplace/install`, {
      id: match.id,
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  if (flags.json) {
    emitJson(res);
    return 0;
  }

  process.stdout.write(
    `\n${status.ok(`Installed ${C.bold}${match.title}${C.reset} into your project`)}\n`,
  );
  process.stdout.write(
    `  ${C.dim}commit${C.reset} ${C.cyan}${res.commit_sha?.slice(0, 8)}${C.reset} ${C.dim}on${C.reset} ${res.branch} ${C.dim}— ${res.file_count} files${C.reset}\n`,
  );
  if (res.installed?.length > 1) {
    process.stdout.write(
      `  ${C.dim}items:${C.reset} ${res.installed.map((i) => i.name).join(', ')}\n`,
    );
  }
  if (res.capabilities?.secrets?.length) {
    process.stdout.write(
      `  ${C.dim}Set its secrets with${C.reset} ${C.cyan}kortix secrets set <KEY> <value>${C.reset} ${C.dim}(${res.capabilities.secrets.join(', ')})${C.reset}\n`,
    );
  }
  process.stdout.write(`  ${C.dim}Live in your next session.${C.reset}\n`);
  return 0;
}
