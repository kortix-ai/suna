/**
 * `kortix migrate` — convert this project's kortix.yaml from kortix_version 2
 * to 3 (`planMigration` in ../manifest-migrate.ts). A preview by default;
 * `--write` applies it. Nothing is written or deleted without `--write`, and
 * nothing is written when the result does not validate.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { formatIssues, IMPORTABLE_LIST_KEYS, IMPORTABLE_MAP_KEYS, MANIFEST_IMPORTS_KEY, parseManifestText, splitManifestByOrigin } from '@kortix/manifest-schema';
import { emitJson, takeFlagBool } from '../command-helpers.ts';
import { resolveLocalManifestImports } from '../manifest-imports.ts';
import { type MigrationPlan, planMigration, renderManifest } from '../manifest-migrate.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix migrate [--write] [--json]

Convert this project's kortix.yaml from kortix_version 2 to 3. v3 defines each
agent in one kortix.yaml block: the project registers skills, tools, commands
and extensions, and each agent enables what it uses.

What it does:
  - Each agent's .md frontmatter moves into its kortix.yaml block; the .md
    keeps the prompt alone and becomes the agent's prompt_file.
  - opencode.json(c)'s permission is copied onto every agent that sets none,
    and the file is deleted.
  - skills/<name>/ folders become the skills registry.
  - OpenCode commands become the commands registry, each enabled on the agent
    its frontmatter names, else default_agent.
  - OpenCode plugins and harnesses.pi.packages become extensions, enabled on
    every agent that loaded them.
  - A manifest split with imports: stays split. Each agent, connector,
    trigger and App stays in the file that declared it; the new registries go
    to kortix.yaml.

Without --write it prints the plan and the new kortix.yaml and changes nothing.
The result is checked with the v3 validator; --write refuses an invalid result.

Options:
  --write       Apply the plan: write kortix.yaml and the prompt files, delete
                opencode.json(c).
  --json        Machine-readable plan.
  -h, --help    Show this help.

Then: kortix validate, commit, and open a change request.
`;

export function runMigrate(argv: string[]): number {
  if (argv.some((arg) => arg === '-h' || arg === '--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const rest = [...argv];
  const write = takeFlagBool(rest, ['--write']);
  const json = takeFlagBool(rest, ['--json']);
  if (rest.length > 0) {
    process.stderr.write(`unknown option "${rest[0]}"\n\n${HELP}`);
    return 2;
  }

  const found = resolveLocalManifest(process.cwd());
  if (!found) {
    process.stderr.write(`${status.err('Manifest not found')}\n  ${C.dim}Run from your project root (the folder with kortix.yaml).${C.reset}\n`);
    return 2;
  }
  const root = dirname(found.path);
  let raw: Record<string, unknown>;
  try {
    raw = parseManifestText(readFileSync(found.path, 'utf8'), found.format);
  } catch (err) {
    process.stderr.write(`${status.err(`cannot parse ${basename(found.path)}: ${(err as Error).message}`)}\n`);
    return 1;
  }
  const version = Number(raw.kortix_version ?? 1);
  if (version === 3) {
    if (json) emitJson({ migrated: false, version: 3 });
    else process.stdout.write(`${status.ok(`${basename(found.path)} is already kortix_version 3`)}\n`);
    return 0;
  }
  if (version !== 2) {
    process.stderr.write(
      `${status.err(`${basename(found.path)} is kortix_version ${version}.`)}\n  ${C.dim}kortix migrate converts kortix_version 2. Run \`kortix projects upgrade\` to move a v1 kortix.toml to kortix.yaml first.${C.reset}\n`,
    );
    return 1;
  }
  const plan = raw.imports === undefined ? planMigration(root, 'kortix.yaml', raw) : planSplitMigration(root, found.path);
  if (found.format === 'toml') plan.changes.push({ path: relative(root, found.path), action: 'delete', note: 'replaced by kortix.yaml' });

  if (json) {
    emitJson({ migrated: write && plan.valid, valid: plan.valid, manifest: plan.manifest, changes: plan.changes.map(({ content: _, ...change }) => change), dropped: plan.dropped, issues: plan.issues });
  } else {
    printPlan(plan, write);
  }
  if (!plan.valid) return 1;
  if (!write) return 0;

  for (const change of plan.changes) {
    const abs = resolve(root, change.path);
    if (change.action === 'delete') rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, change.content ?? '', 'utf8');
    }
  }
  if (!json) {
    process.stdout.write(
      `\n${status.ok('Migrated to kortix_version 3')}\n` +
        `Next:\n  1. kortix validate\n  2. git add -A && git commit -m "Migrate kortix.yaml to kortix_version 3"\n  3. git push origin HEAD && kortix cr open --title "Migrate kortix.yaml to kortix_version 3"\n`,
    );
  }
  return 0;
}

/** Keys an imported v3 file may hold; anything else fails the whole manifest. */
const IMPORTABLE = new Set<string>([...IMPORTABLE_LIST_KEYS, ...IMPORTABLE_MAP_KEYS, MANIFEST_IMPORTS_KEY]);

/**
 * A manifest split with `imports:`: migrate the merged document, then write
 * every entry back to the file that declared it (`splitManifestByOrigin`).
 * The new registries (skills, commands, extensions) go to the root. A key an
 * imported v3 file cannot hold (v2 dropped it silently, e.g. `harnesses`) is
 * removed and reported.
 */
function planSplitMigration(root: string, manifestFile: string): MigrationPlan {
  const resolved = resolveLocalManifestImports(manifestFile, 'yaml');
  const plan = planMigration(root, 'kortix.yaml', resolved.raw);
  const files = splitManifestByOrigin(resolved, plan.next);
  plan.changes = plan.changes.filter((change) => change.path !== 'kortix.yaml');
  const rewrites = files.flatMap((file, index) => {
    const isRoot = index === 0;
    const raw = { ...file.raw };
    if (!isRoot) {
      for (const key of Object.keys(raw).filter((key) => !IMPORTABLE.has(key))) {
        plan.dropped.push(`${file.path}: ${key} (an imported v3 file holds ${[...IMPORTABLE].join(', ')})`);
        delete raw[key];
      }
    }
    if (!isRoot && !file.changed && Object.keys(raw).length === Object.keys(file.raw).length) return [];
    return [{ path: file.path, action: 'rewrite' as const, note: isRoot ? 'kortix_version 2 → 3: agents inline, registries, per-agent grants' : 'its entries in kortix_version 3 shape', content: renderManifest(raw, isRoot) }];
  });
  plan.changes.unshift(...rewrites);
  plan.manifest = rewrites[0]?.content ?? plan.manifest;
  return plan;
}

function printPlan(plan: MigrationPlan, write: boolean): void {
  process.stdout.write(`kortix migrate: kortix_version 2 → 3${write ? '' : ' (preview — nothing changes; run with --write to apply)'}\n\n`);
  const width = Math.max(...plan.changes.map((change) => change.path.length)) + 2;
  for (const change of plan.changes) {
    const mark = change.action === 'delete' ? `${C.red}-${C.reset}` : `${C.yellow}~${C.reset}`;
    process.stdout.write(`  ${mark} ${change.path.padEnd(width)}${C.dim}${change.note}${C.reset}\n`);
  }
  if (plan.dropped.length > 0) {
    process.stdout.write(`\n${C.yellow}Not carried over:${C.reset}\n`);
    for (const line of plan.dropped) process.stdout.write(`  ! ${line}\n`);
  }
  process.stdout.write(`\n${C.dim}── ${join('.', 'kortix.yaml')} ──${C.reset}\n${plan.manifest}`);
  if (plan.issues.length > 0) {
    process.stdout.write(`\n${plan.valid ? 'Warnings' : `${C.red}The result does not validate${C.reset}`}:\n${formatIssues(plan.issues)}\n`);
  } else {
    process.stdout.write(`\n${status.ok('The result validates as kortix_version 3')}\n`);
  }
}
